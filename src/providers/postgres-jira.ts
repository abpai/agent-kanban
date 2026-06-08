import type { Sql } from 'postgres'

import { ErrorCode, KanbanError } from '../errors'
import type {
  ActivityEntry,
  BoardBootstrap,
  BoardConfig,
  BoardMetrics,
  BoardView,
  Column,
  Priority,
  Task,
  TaskComment,
} from '../types'
import { JIRA_CAPABILITIES } from './capabilities'
import {
  decodeColumnStatusIds,
  jiraBoardColumnRows,
  resolveJiraColumnId,
  type JiraActivityRow,
} from './jira-cache'
import { PostgresJiraCache, type JiraSyncMeta } from './postgres-jira-cache'
import { adfToPlainText, plainTextToAdf, type AdfDocument } from './jira-adf'
import {
  JiraClient,
  decideJiraPagination,
  normalizeJiraLabels,
  type JiraComment,
  type JiraIssue,
} from './jira-client'
import type { JiraProviderConfig } from './jira'
import { buildDeltaJql, safeDeltaSince } from './jira-jql'
import { providerUpstreamError, unsupportedOperation } from './errors'
import type {
  CreateTaskInput,
  KanbanProvider,
  ProviderContext,
  ProviderSyncStatus,
  TaskListFilters,
  UpdateTaskInput,
} from './types'
import { DEFAULT_POLLING_SYNC_INTERVAL_MS } from '../sync-config'
import {
  authorizeWebhook,
  headerLower,
  verifySha256HmacSignatureHeader,
  type WebhookRequest,
  type WebhookResult,
} from '../webhooks'
import { extractWebhookMeta, recordWebhookEvent, webhookEventStatus } from '../webhook-events'

const FULL_RECONCILE_INTERVAL_MS = 5 * 60_000

function shouldRunFullReconcile(lastFullSyncAt: string | null, now: number): boolean {
  if (!lastFullSyncAt) return true
  const lastFullSyncAtMs = Date.parse(lastFullSyncAt)
  if (!Number.isFinite(lastFullSyncAtMs)) return true
  return now - lastFullSyncAtMs >= FULL_RECONCILE_INTERVAL_MS
}

const CANONICAL_TO_JIRA_DEFAULT: Record<Priority, string> = {
  urgent: 'Highest',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

export class PostgresJiraProvider implements KanbanProvider {
  readonly type = 'jira' as const
  private readonly ready: Promise<void>
  private readonly cache: PostgresJiraCache
  private readonly client: JiraClient
  private readonly pollingSyncIntervalMs: number
  // When a server-side background warmer owns cache refresh, implicit request-path
  // syncs are suppressed once the cache is warm so reads never block on Jira I/O.
  private backgroundManaged = false

  constructor(
    private readonly sql: Sql,
    private readonly config: JiraProviderConfig,
    client?: JiraClient,
  ) {
    this.cache = new PostgresJiraCache(sql)
    this.ready = this.cache.ready
    this.pollingSyncIntervalMs = config.pollingSyncIntervalMs ?? DEFAULT_POLLING_SYNC_INTERVAL_MS
    this.client =
      client ??
      new JiraClient({
        baseUrl: config.baseUrl,
        email: config.email,
        apiToken: config.apiToken,
      })
  }

  async initialize(): Promise<void> {
    await this.ready
  }

  private async sync(force = false, viaWarmer = false): Promise<void> {
    await this.ready
    const meta = await this.cache.loadSyncMeta()
    const lastSyncAtMs = meta.lastSyncAt ? Date.parse(meta.lastSyncAt) : 0
    // Server mode: a background warmer (syncCache(), viaWarmer=true) owns refresh.
    // Once warm, implicit request-path reads serve the warm cache instead of
    // blocking on a Jira round-trip (a periodic full reconcile can take minutes and
    // exceed the HTTP idle timeout). Forced syncs (write read-after-write) and the
    // warmer still run; CLI mode and cold start sync synchronously.
    if (this.backgroundManaged && !force && !viaWarmer && lastSyncAtMs) return
    const now = Date.now()
    if (!force && lastSyncAtMs && now - lastSyncAtMs < this.pollingSyncIntervalMs) return
    // `force` bypasses the poll throttle (so create/move/update see their own
    // write) but must NOT force a full 1970-based reconcile: on a large project
    // that re-fetches every issue plus a per-issue changelog call (~minutes) on
    // every write. A delta sync (updated >= lastIssueUpdatedAt) is cheap and
    // still catches the just-written issue, which is always among the newest.
    const fullReconcile = shouldRunFullReconcile(meta.lastFullSyncAt, now)

    const project = await this.client.getProject(this.config.projectKey)
    await this.cache.saveTeamInfo({ id: project.id, key: project.key, name: project.name })

    // Columns + catalogs (users/priorities/issue types) UPSERT on every sync so a
    // newly-created Jira status/column/priority/user is reflected promptly; the
    // obsolete-row prune is confined to the full reconcile (see replaceColumns).
    if (this.config.boardId !== undefined) {
      const boardCfg = await this.client.getBoardColumns(this.config.boardId)
      const boardId = this.config.boardId
      await this.cache.replaceColumns(
        jiraBoardColumnRows(boardId, boardCfg.columnConfig.columns),
        fullReconcile,
      )
    } else {
      const statusCats = await this.client.getProjectStatuses(project.key)
      const seen = new Set<string>()
      const uniqueStatuses: Array<{ id: string; name: string }> = []
      for (const category of statusCats) {
        for (const status of category.statuses) {
          if (seen.has(status.id)) continue
          seen.add(status.id)
          uniqueStatuses.push({ id: status.id, name: status.name })
        }
      }
      await this.cache.replaceColumns(
        uniqueStatuses.map((status, index) => ({
          id: `status:${status.id}`,
          name: status.name,
          position: index,
          statusIds: [status.id],
          source: 'status' as const,
        })),
        fullReconcile,
      )
    }

    const [users, priorities, issueTypes] = await Promise.all([
      this.client.listAssignableUsers({
        projectKey: project.key,
        startAt: 0,
        maxResults: 100,
      }),
      this.client.listPriorities(),
      this.client.listIssueTypes({ projectId: project.id }),
    ])
    await this.cache.upsertUsers(
      users.map((user) => ({
        accountId: user.accountId,
        displayName: user.displayName,
        active: user.active ?? true,
      })),
    )
    await this.cache.replacePriorities(
      priorities.map((priority) => ({ id: priority.id, name: priority.name })),
      fullReconcile,
    )
    await this.cache.replaceIssueTypes(
      issueTypes.map((issueType) => ({ id: issueType.id, name: issueType.name })),
      fullReconcile,
    )

    // Sanitize the stored cursor once: an unsafe value is treated as absent so it
    // is never carried into the JQL or re-persisted as `newestUpdatedAt`.
    const storedSince = safeDeltaSince(meta.lastIssueUpdatedAt)
    const since = fullReconcile ? null : storedSince
    const jql = buildDeltaJql(project.key, since)
    const maxResults = 100
    let newestUpdatedAt: string | null = storedSince
    const seenIssueIds = new Set<string>()
    const issueFields = [
      'summary',
      'description',
      'status',
      'issuetype',
      'priority',
      'assignee',
      'labels',
      'comment',
      'created',
      'updated',
      'project',
    ]

    // /rest/api/3/search/jql paginates by an opaque nextPageToken and omits
    // `total`, so we follow the cursor until the server reports `isLast` or stops
    // handing back a token. The previous total/startAt loop fetched only the first
    // page (oldest 100 by updated ASC) once `total` came back undefined, so every
    // issue beyond the first page — including newly-created tickets on a project
    // with >100 issues — was never cached. seenPageTokens guards against a server
    // that repeats a cursor, which would otherwise spin this loop forever and hang
    // the poll cycle; an empty page is not treated as terminal because a non-last
    // page may legitimately carry a token with zero issues.
    const seenPageTokens = new Set<string>()
    let nextPageToken: string | undefined
    let firstPage = true
    let paginationComplete = false
    while (firstPage || nextPageToken !== undefined) {
      firstPage = false
      const page = await this.client.listIssues({
        jql,
        startAt: 0,
        maxResults,
        fields: issueFields,
        nextPageToken,
      })

      await this.cache.upsertIssues(
        page.issues.map((issue) => ({
          id: issue.id,
          key: issue.key,
          summary: issue.fields.summary,
          descriptionText: issue.fields.description
            ? adfToPlainText(issue.fields.description as AdfDocument)
            : '',
          statusId: issue.fields.status.id,
          priorityName: issue.fields.priority?.name ?? null,
          issueTypeName: issue.fields.issuetype?.name ?? '',
          assigneeAccountId: issue.fields.assignee?.accountId ?? null,
          assigneeName: issue.fields.assignee?.displayName ?? null,
          labels: issue.fields.labels ?? [],
          commentCount: issue.fields.comment?.total ?? 0,
          projectKey: issue.fields.project?.key ?? project.key,
          url: `${this.config.baseUrl}/browse/${issue.key}`,
          createdAt: issue.fields.created,
          updatedAt: issue.fields.updated,
        })),
      )

      for (const issue of page.issues) {
        if (fullReconcile) seenIssueIds.add(issue.id)
        if (newestUpdatedAt === null || issue.fields.updated > newestUpdatedAt) {
          newestUpdatedAt = issue.fields.updated
        }
      }

      for (const issue of page.issues) {
        await this.ingestIssueActivity(issue.id).catch((err) => {
          console.warn(`[jira] activity fetch for ${issue.key} failed:`, err)
        })
      }

      const decision = decideJiraPagination(page, seenPageTokens)
      if (decision.nextToken !== undefined) {
        seenPageTokens.add(decision.nextToken)
        nextPageToken = decision.nextToken
        continue
      }
      paginationComplete = decision.complete
      if (!paginationComplete) {
        // The server stopped advancing the cursor before reporting a definitive
        // end (stalled/contradictory). seenIssueIds is only a partial scan, so we
        // must not treat it as authoritative for pruning below.
        console.warn(
          `[jira] search/jql scan ended without a definitive last page; treating as incomplete`,
        )
      }
      break
    }

    if (!paginationComplete) {
      // The scan ended early (stalled/contradictory cursor). Leave sync metadata
      // unchanged so this partial result is not recorded as a clean sync: lastSyncAt
      // is not advanced, so the next sync is not throttled and retries promptly, and
      // the full-reconcile marker stays due. The issues we did fetch are already
      // cached (additive); we only skip pruning — which would delete issues that
      // exist upstream on pages we never fetched — and the metadata advance.
      return
    }

    // Prune against seenIssueIds and advance lastFullSyncAt only on a full
    // reconcile; a delta sync's seenIssueIds is intentionally partial. (The scan
    // is known complete here — an incomplete scan returned above.)
    if (fullReconcile) {
      await this.cache.pruneIssuesMissingUpstream(project.key, [...seenIssueIds])
    }

    const nextMeta: Partial<JiraSyncMeta> = {
      projectKey: project.key,
      boardId: this.config.boardId ?? null,
      lastSyncAt: new Date().toISOString(),
      lastIssueUpdatedAt: newestUpdatedAt ?? new Date().toISOString(),
    }
    if (fullReconcile) nextMeta.lastFullSyncAt = nextMeta.lastSyncAt
    await this.cache.saveSyncMeta(nextMeta)
  }

  private async resolveColumnId(input: string): Promise<string> {
    return resolveJiraColumnId(await this.cache.getColumns(), input)
  }

  private async buildBoardConfig(): Promise<BoardConfig> {
    const cache = await this.cache.getCachedConfig()
    const members = cache.users.map((user) => ({ name: user.displayName, role: 'human' as const }))
    const projects = cache.projectKey ? [cache.projectKey] : []
    const discoveredAssignees = (
      await this.sql<{ assignee_name: string }[]>`
        SELECT DISTINCT assignee_name FROM jira_issues WHERE assignee_name != '' ORDER BY assignee_name
      `
    ).map((row) => row.assignee_name)
    return {
      members,
      projects,
      provider: 'jira',
      discoveredAssignees,
      discoveredProjects: projects.slice(),
    }
  }

  async syncCache(): Promise<void> {
    // viaWarmer bypasses the backgroundManaged request-path suppression without
    // forcing a full reconcile (force=false keeps the normal delta/full cadence).
    await this.sync(false, true)
  }

  setBackgroundManaged(managed: boolean): void {
    this.backgroundManaged = managed
  }

  async getSyncStatus(): Promise<ProviderSyncStatus> {
    const meta = await this.cache.loadSyncMeta()
    return {
      lastSyncAt: meta.lastSyncAt,
      lastFullSyncAt: meta.lastFullSyncAt,
      lastWebhookAt: meta.lastWebhookAt,
    }
  }

  async getContext(): Promise<ProviderContext> {
    await this.sync()
    return {
      provider: 'jira',
      capabilities: JIRA_CAPABILITIES,
      team: await this.cache.loadTeamInfo(),
    }
  }

  async getBootstrap(): Promise<BoardBootstrap> {
    await this.sync()
    return {
      provider: 'jira',
      capabilities: JIRA_CAPABILITIES,
      board: await this.cache.getCachedBoard(),
      config: await this.buildBoardConfig(),
      metrics: null,
      activity: [],
      team: await this.cache.loadTeamInfo(),
    }
  }

  async getBoard(): Promise<BoardView> {
    await this.sync()
    return this.cache.getCachedBoard()
  }

  async listColumns(): Promise<Column[]> {
    await this.sync()
    return (await this.cache.getColumns()).map((row) => ({
      id: row.id,
      name: row.name,
      position: row.position,
      color: null,
      created_at: '',
      updated_at: '',
    }))
  }

  async listTasks(filters: TaskListFilters = {}): Promise<Task[]> {
    await this.sync()
    const columnId = filters.column ? await this.resolveColumnId(filters.column) : undefined
    let tasks = await this.cache.getCachedTasks(columnId ? { columnId } : undefined)
    if (filters.priority) tasks = tasks.filter((task) => task.priority === filters.priority)
    if (filters.assignee) tasks = tasks.filter((task) => task.assignee === filters.assignee)
    if (filters.project) tasks = tasks.filter((task) => task.project === filters.project)
    if (filters.sort === 'title') tasks = [...tasks].sort((a, b) => a.title.localeCompare(b.title))
    if (filters.sort === 'updated')
      tasks = [...tasks].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    if (filters.limit) tasks = tasks.slice(0, filters.limit)
    return tasks
  }

  async getTask(idOrRef: string): Promise<Task> {
    await this.sync()
    const task = await this.cache.getCachedTask(idOrRef)
    if (!task) throw new KanbanError(ErrorCode.TASK_NOT_FOUND, `No task with id '${idOrRef}'`)
    return task
  }

  private async resolveTaskByIdOrKey(idOrRef: string): Promise<Task> {
    const task = await this.cache.getCachedTask(idOrRef)
    if (!task) throw new KanbanError(ErrorCode.TASK_NOT_FOUND, `No task with id '${idOrRef}'`)
    return task
  }

  private issueKeyFor(task: Task): string {
    return task.externalRef ?? task.providerId ?? task.id.replace(/^jira:/, '')
  }

  private async resolveJiraPriorityName(canonical: Priority): Promise<string> {
    const wanted = CANONICAL_TO_JIRA_DEFAULT[canonical]
    const [row] = await this.sql<{ name: string }[]>`
      SELECT name FROM jira_priorities WHERE LOWER(name) = LOWER(${wanted}) LIMIT 1
    `
    if (row) return row.name
    const available = (
      await this.sql<{ name: string }[]>`SELECT name FROM jira_priorities ORDER BY name`
    ).map((priority) => priority.name)
    providerUpstreamError(
      `Canonical priority '${canonical}' maps to Jira priority '${wanted}' which is not present in this tenant's priority catalog. Available Jira priorities: [${available
        .map((name) => `"${name}"`)
        .join(', ')}]`,
    )
  }

  private async resolveAssigneeAccountId(displayName: string): Promise<string> {
    const [row] = await this.sql<{ account_id: string }[]>`
      SELECT account_id
      FROM jira_users
      WHERE active = 1 AND LOWER(display_name) = LOWER(${displayName})
      LIMIT 1
    `
    if (row) return row.account_id
    providerUpstreamError(
      `Jira assignee '${displayName}' was not found in the cached active user list. Try 'kanban task list --assignee' to see cached names.`,
    )
  }

  private async resolveIssueTypeId(name: string): Promise<string> {
    const [row] = await this.sql<{ id: string }[]>`
      SELECT id FROM jira_issue_types WHERE LOWER(name) = LOWER(${name}) LIMIT 1
    `
    if (row) return row.id
    const available = (
      await this.sql<{ name: string }[]>`SELECT name FROM jira_issue_types ORDER BY name`
    ).map((issueType) => issueType.name)
    providerUpstreamError(
      `Jira issue type '${name}' is not present in this project's issue-type catalog. Available types: [${available
        .map((availableName) => `"${availableName}"`)
        .join(', ')}]`,
    )
  }

  private normalizeProjectField(input?: string): void {
    if (!input) return
    if (input === this.config.projectKey) return
    unsupportedOperation(
      `JiraProvider is pinned to project '${this.config.projectKey}'. A different project field ('${input}') is not supported.`,
    )
  }

  private toTaskComment(task: Task, comment: JiraComment): TaskComment {
    const timestamp = comment.updated ?? comment.created ?? task.updated_at
    return {
      id: comment.id,
      task_id: task.id,
      body: comment.body ? adfToPlainText(comment.body as AdfDocument) : '',
      author: comment.author?.displayName ?? null,
      created_at: comment.created ?? timestamp,
      updated_at: timestamp,
    }
  }

  private async ingestIssueActivity(issueId: string): Promise<void> {
    const page = await this.client.getChangelog(issueId, { maxResults: 100 })
    const rows: JiraActivityRow[] = []
    for (const entry of page.values) {
      for (const item of entry.items) {
        rows.push({
          issue_id: issueId,
          history_id: entry.id,
          item_field: item.field,
          from_value: item.from ?? null,
          to_value: item.to ?? null,
          created_at: entry.created,
        })
      }
    }
    await this.cache.saveActivity(rows)
  }

  // Read-after-write via the direct issue endpoint. Unlike JQL search (used by
  // sync()), GET /issue/{key} has no search-index lag, so a just-created or
  // just-transitioned issue is reflected immediately. This replaces the previous
  // "transition/create then sync(true) then getCachedTask" pattern, which both
  // raced the search index (create reported "not yet visible"; a move's new
  // status didn't land, causing the daemon to re-issue the move in a loop) and
  // forced a full whole-project reconcile (~minutes) on every write.
  private async hydrateIssueByKey(key: string): Promise<Task> {
    // getIssue throws on a missing key (404), so reaching this method means the
    // issue exists upstream. A null read-back would therefore be a genuine cache
    // anomaly (the upsert above did not land), not an ordinary not-found — surface
    // it rather than threading an unreachable null through every caller.
    const issue = await this.client.getIssue(key)
    await this.cache.upsertIssues([
      {
        id: issue.id,
        key: issue.key,
        summary: issue.fields.summary,
        descriptionText: issue.fields.description
          ? adfToPlainText(issue.fields.description as AdfDocument)
          : '',
        statusId: issue.fields.status.id,
        priorityName: issue.fields.priority?.name ?? null,
        issueTypeName: issue.fields.issuetype?.name ?? '',
        assigneeAccountId: issue.fields.assignee?.accountId ?? null,
        assigneeName: issue.fields.assignee?.displayName ?? null,
        labels: issue.fields.labels ?? [],
        commentCount: issue.fields.comment?.total ?? 0,
        projectKey: issue.fields.project?.key ?? this.config.projectKey,
        url: `${this.config.baseUrl}/browse/${issue.key}`,
        createdAt: issue.fields.created,
        updatedAt: issue.fields.updated,
      },
    ])
    // Ingest the changelog like the sync loop does, so a just-applied transition
    // is recorded in jira_activity immediately (backs getActivity and the
    // poll-based `moved` trigger) rather than waiting for the next unthrottled
    // sync. Best-effort: activity must not fail the mutation.
    await this.ingestIssueActivity(issue.id).catch((err) => {
      console.warn(`[jira] activity fetch for ${issue.key} failed:`, err)
    })
    const task = await this.cache.getCachedTask(key)
    if (!task) {
      providerUpstreamError(
        `Jira issue ${key} was hydrated from GET /issue but is missing from the cache.`,
      )
    }
    return task
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    await this.sync()
    this.normalizeProjectField(input.project)
    const issueTypeName = this.config.defaultIssueType ?? 'Task'
    const issueTypeId = await this.resolveIssueTypeId(issueTypeName)
    const fields: Record<string, unknown> = {
      project: { key: this.config.projectKey },
      summary: input.title,
      issuetype: { id: issueTypeId },
    }
    if (input.description !== undefined) fields['description'] = plainTextToAdf(input.description)
    if (input.priority !== undefined) {
      fields['priority'] = { name: await this.resolveJiraPriorityName(input.priority) }
    }
    if (input.assignee) {
      fields['assignee'] = { accountId: await this.resolveAssigneeAccountId(input.assignee) }
    }
    const labels = normalizeJiraLabels(input.labels)
    if (labels.length > 0) fields['labels'] = labels
    const created = await this.client.createIssue({ fields })
    return this.hydrateIssueByKey(created.key)
  }

  async updateTask(idOrRef: string, input: UpdateTaskInput): Promise<Task> {
    await this.sync()
    this.normalizeProjectField(input.project)
    if (input.metadata !== undefined)
      unsupportedOperation('Jira mode does not support metadata updates')
    const task = await this.resolveTaskByIdOrKey(idOrRef)
    if (input.expectedVersion !== undefined && task.version !== input.expectedVersion) {
      throw new KanbanError(
        ErrorCode.CONFLICT,
        `Jira issue ${task.externalRef ?? idOrRef} was updated remotely (expected version ${input.expectedVersion}, current ${task.version ?? 'unknown'})`,
      )
    }
    const issueKey = this.issueKeyFor(task)
    const fields: Record<string, unknown> = {}
    if (input.title !== undefined) fields['summary'] = input.title
    if (input.description !== undefined) fields['description'] = plainTextToAdf(input.description)
    if (input.priority !== undefined) {
      fields['priority'] = { name: await this.resolveJiraPriorityName(input.priority) }
    }
    if (input.assignee !== undefined) {
      fields['assignee'] = input.assignee
        ? { accountId: await this.resolveAssigneeAccountId(input.assignee) }
        : null
    }
    if (Object.keys(fields).length > 0) await this.client.updateIssue(issueKey, { fields })
    return this.hydrateIssueByKey(issueKey)
  }

  async moveTask(idOrRef: string, column: string): Promise<Task> {
    await this.sync()
    const task = await this.resolveTaskByIdOrKey(idOrRef)
    return this.moveTaskByKey(this.issueKeyFor(task), column)
  }

  private async moveTaskByKey(issueKey: string, column: string): Promise<Task> {
    const columnId = await this.resolveColumnId(column)
    const columnRow = (await this.cache.getColumns()).find((candidate) => candidate.id === columnId)
    if (!columnRow) {
      throw new KanbanError(
        ErrorCode.COLUMN_NOT_FOUND,
        `Resolved column '${column}' but cache row missing`,
      )
    }
    const statusIds = decodeColumnStatusIds(columnRow)
    if (statusIds.length === 0) {
      providerUpstreamError(`Column '${columnRow.name}' has no mapped Jira statuses.`)
    }
    const targetStatusId = statusIds[0]!
    const { transitions } = await this.client.getTransitions(issueKey)
    const match = transitions.find((transition) => transition.to.id === targetStatusId)
    if (!match) {
      const currentStatusId = (await this.cache.getCachedTask(issueKey))?.column_id ?? '<unknown>'
      providerUpstreamError(
        `Cannot transition Jira issue ${issueKey} (current status id ${currentStatusId}) to column '${columnRow.name}' (target status id ${targetStatusId}). Available transitions: [${transitions
          .map((transition) => `"${transition.name}"`)
          .join(', ')}]`,
      )
    }
    await this.client.transitionIssue(issueKey, match.id)
    return this.hydrateIssueByKey(issueKey)
  }

  async deleteTask(_idOrRef: string): Promise<Task> {
    unsupportedOperation('Task deletion is not supported in Jira mode')
  }

  async listComments(idOrRef: string): Promise<TaskComment[]> {
    await this.sync()
    const task = await this.resolveTaskByIdOrKey(idOrRef)
    const issueKey = this.issueKeyFor(task)
    const comments: JiraComment[] = []
    let startAt = 0

    while (true) {
      const page = await this.client.getComments(issueKey, { startAt, maxResults: 100 })
      comments.push(...page.comments)
      startAt += page.comments.length
      if (comments.length >= page.total || page.comments.length === 0) break
    }

    return comments.map((comment) => this.toTaskComment(task, comment))
  }

  async getComment(idOrRef: string, commentId: string): Promise<TaskComment> {
    await this.sync()
    const task = await this.resolveTaskByIdOrKey(idOrRef)
    const comment = await this.client.getComment(this.issueKeyFor(task), commentId)
    return this.toTaskComment(task, comment)
  }

  async comment(idOrRef: string, body: string): Promise<TaskComment> {
    await this.sync()
    const task = await this.resolveTaskByIdOrKey(idOrRef)
    const created = await this.client.addComment(this.issueKeyFor(task), {
      body: plainTextToAdf(body),
    })
    await this.cache.adjustIssueCommentCount(task.providerId || task.externalRef || task.id, 1)
    return this.toTaskComment(task, created)
  }

  async updateComment(idOrRef: string, commentId: string, body: string): Promise<TaskComment> {
    await this.sync()
    const task = await this.resolveTaskByIdOrKey(idOrRef)
    const updated = await this.client.updateComment(this.issueKeyFor(task), commentId, {
      body: plainTextToAdf(body),
    })
    return this.toTaskComment(task, updated)
  }

  async getActivity(limit?: number, taskId?: string): Promise<ActivityEntry[]> {
    await this.sync()
    const lookupIssueId = taskId ? await this.resolveIssueIdFromTaskId(taskId) : undefined
    const rows = await this.cache.getCachedActivity({
      ...(lookupIssueId !== undefined ? { issueId: lookupIssueId } : {}),
      limit: limit ?? 100,
    })
    return Promise.all(rows.map((row) => this.activityRowToEntry(row)))
  }

  private async resolveIssueIdFromTaskId(taskId: string): Promise<string | undefined> {
    const normalized = taskId.startsWith('jira:') ? taskId.slice('jira:'.length) : taskId
    const [row] = await this.sql<{ id: string }[]>`
      SELECT id FROM jira_issues WHERE id = ${normalized} OR key = ${normalized} LIMIT 1
    `
    return row?.id
  }

  private async activityRowToEntry(row: JiraActivityRow): Promise<ActivityEntry> {
    const action: ActivityEntry['action'] = row.item_field === 'status' ? 'moved' : 'updated'
    let fromCol = row.from_value
    let toCol = row.to_value
    if (row.item_field === 'status') {
      fromCol = row.from_value
        ? ((await this.statusIdToColumnId(row.from_value)) ?? row.from_value)
        : null
      toCol = row.to_value ? ((await this.statusIdToColumnId(row.to_value)) ?? row.to_value) : null
    }
    return {
      id: `jira-activity:${row.issue_id}:${row.history_id}:${row.item_field}`,
      task_id: `jira:${row.issue_id}`,
      action,
      field_changed: row.item_field,
      old_value: fromCol,
      new_value: toCol,
      timestamp: row.created_at,
    }
  }

  private async statusIdToColumnId(statusId: string): Promise<string | undefined> {
    for (const column of await this.cache.getColumns()) {
      if (decodeColumnStatusIds(column).includes(statusId)) return column.id
    }
    return undefined
  }

  async getMetrics(): Promise<BoardMetrics> {
    unsupportedOperation('Metrics are not available in Jira mode')
  }

  async getConfig(): Promise<BoardConfig> {
    await this.sync()
    return this.buildBoardConfig()
  }

  async patchConfig(_input: Partial<BoardConfig>): Promise<BoardConfig> {
    unsupportedOperation('Config mutation is not supported in Jira mode')
  }

  async handleWebhook(payload: WebhookRequest): Promise<WebhookResult> {
    const meta = extractWebhookMeta('jira', payload.rawBody)
    let result: WebhookResult
    try {
      result = await this.handleWebhookInner(payload)
    } catch (err) {
      void recordWebhookEvent(this.sql, {
        provider: 'jira',
        ...meta,
        status: 'error',
        detail: { error: err instanceof Error ? err.message : String(err) },
      })
      throw err
    }
    void recordWebhookEvent(this.sql, {
      provider: 'jira',
      ...meta,
      status: webhookEventStatus(result),
    })
    return result
  }

  private async handleWebhookInner(payload: WebhookRequest): Promise<WebhookResult> {
    const auth = authorizeWebhook({
      secret: process.env['JIRA_WEBHOOK_SECRET'],
      rawBody: payload.rawBody,
      signature: headerLower(payload.headers, 'x-hub-signature'),
      verify: verifySha256HmacSignatureHeader,
    })
    if (auth) return auth
    let body: { webhookEvent?: string; issue?: JiraIssue } = {}
    try {
      body = JSON.parse(payload.rawBody) as typeof body
    } catch {
      return { handled: false, message: 'Invalid JSON body' }
    }
    const event = body.webhookEvent ?? ''
    const issue = body.issue
    if (!issue) return { handled: false, message: `No issue in payload (${event})` }

    if (event === 'jira:issue_deleted') {
      await this.cache.deleteIssue(issue.id)
      await this.cache.saveSyncMeta({ lastWebhookAt: new Date().toISOString() })
      return { handled: true }
    }

    if (event === 'jira:issue_created' || event === 'jira:issue_updated') {
      const projectKey = issue.fields.project?.key
      if (projectKey !== this.config.projectKey) {
        return {
          handled: false,
          message: `Ignoring issue from project '${projectKey ?? 'unknown'}'`,
        }
      }
      await this.cache.upsertIssues([
        {
          id: issue.id,
          key: issue.key,
          summary: issue.fields.summary,
          descriptionText: issue.fields.description
            ? adfToPlainText(issue.fields.description as AdfDocument)
            : '',
          statusId: issue.fields.status.id,
          priorityName: issue.fields.priority?.name ?? null,
          issueTypeName: issue.fields.issuetype?.name ?? '',
          assigneeAccountId: issue.fields.assignee?.accountId ?? null,
          assigneeName: issue.fields.assignee?.displayName ?? null,
          labels: issue.fields.labels ?? [],
          commentCount: issue.fields.comment?.total ?? 0,
          projectKey,
          url: `${this.config.baseUrl}/browse/${issue.key}`,
          createdAt: issue.fields.created,
          updatedAt: issue.fields.updated,
        },
      ])
      if (event === 'jira:issue_updated') {
        await this.ingestIssueActivity(issue.id).catch((err) => {
          console.warn(`[jira] activity fetch for webhook issue ${issue.key} failed:`, err)
        })
      }
      await this.cache.saveSyncMeta({ lastWebhookAt: new Date().toISOString() })
      return { handled: true }
    }

    return { handled: false, message: `Unsupported event: ${event}` }
  }
}
