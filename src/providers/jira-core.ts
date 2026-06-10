import { ErrorCode, KanbanError } from '../errors'
import type {
  ActivityEntry,
  BoardBootstrap,
  BoardConfig,
  BoardMetrics,
  BoardView,
  Column,
  Priority,
  ProviderTeamInfo,
  Task,
  TaskComment,
} from '../types'
import {
  authorizeWebhook,
  headerLower,
  verifySha256HmacSignatureHeader,
  type WebhookRequest,
  type WebhookResult,
} from '../webhooks'
import { adfToPlainText, plainTextToAdf, type AdfDocument } from './jira-adf'
import { buildDeltaJql, safeDeltaSince } from './jira-jql'
import { JIRA_CAPABILITIES } from './capabilities'
import { providerUpstreamError, unsupportedOperation } from './errors'
import {
  JiraClient,
  decideJiraPagination,
  normalizeJiraLabels,
  type JiraComment,
  type JiraIssue,
} from './jira-client'
import {
  decodeColumnStatusIds,
  jiraBoardColumnRows,
  resolveJiraColumnId,
  type JiraActivityRow,
  type JiraCacheConfig,
  type JiraColumnRow,
  type JiraSyncMeta,
} from './jira-cache'
import type {
  CreateTaskInput,
  KanbanProvider,
  ProviderContext,
  TaskListFilters,
  UpdateTaskInput,
} from './types'
import { DEFAULT_POLLING_SYNC_INTERVAL_MS } from '../sync-config'
import { warnOnce } from './warn-once'
import { applyTaskFilters, forEachWithConcurrency, SyncGate, syncStatusFromMeta } from './sync-core'

export const FULL_RECONCILE_INTERVAL_MS = 5 * 60_000

export function shouldRunFullReconcile(lastFullSyncAt: string | null, now: number): boolean {
  if (!lastFullSyncAt) return true
  const lastFullSyncAtMs = Date.parse(lastFullSyncAt)
  if (!Number.isFinite(lastFullSyncAtMs)) return true
  return now - lastFullSyncAtMs >= FULL_RECONCILE_INTERVAL_MS
}

// Default canonical->Jira priority name mapping. A Jira admin may rename
// priorities; the write path looks up the resolved name (case-insensitive)
// in the cached `jira_priorities` table, so renames that preserve the default
// casing still resolve.
export const CANONICAL_TO_JIRA_DEFAULT: Record<Priority, string> = {
  urgent: 'Highest',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

export interface JiraProviderConfig {
  baseUrl: string
  email: string
  apiToken: string
  projectKey: string
  boardId?: number
  defaultIssueType?: string
  pollingSyncIntervalMs?: number
}

/**
 * Storage-agnostic cache/repository port the Jira core depends on. The SQLite
 * (jira.ts) and Postgres (postgres-jira.ts) backends each provide an
 * implementation; the core never touches a Database or Sql client directly.
 * All methods are async so the Postgres backend is native and the SQLite backend
 * wraps its synchronous bun:sqlite calls.
 */
export interface JiraCachePort {
  readonly ready: Promise<void>

  // Sync metadata + team info
  loadSyncMeta(): Promise<JiraSyncMeta>
  saveSyncMeta(meta: Partial<JiraSyncMeta>): Promise<void>
  loadTeamInfo(): Promise<ProviderTeamInfo | null>
  saveTeamInfo(team: ProviderTeamInfo | null): Promise<void>

  // Catalog writes. `prune` deletes obsolete rows (full reconcile only); a delta
  // sync upserts the current rows and leaves the rest in place (self-healing).
  replaceColumns(
    columns: Array<{
      id: string
      name: string
      position: number
      statusIds: string[]
      source: 'board' | 'status'
    }>,
    prune: boolean,
  ): Promise<void>
  upsertUsers(
    users: Array<{ accountId: string; displayName: string; active?: boolean }>,
  ): Promise<void>
  replacePriorities(priorities: Array<{ id: string; name: string }>, prune: boolean): Promise<void>
  replaceIssueTypes(types: Array<{ id: string; name: string }>, prune: boolean): Promise<void>

  // Issue writes
  upsertIssues(
    issues: Array<{
      id: string
      key: string
      summary: string
      descriptionText: string
      statusId: string
      priorityName?: string | null
      issueTypeName?: string | null
      assigneeAccountId?: string | null
      assigneeName?: string | null
      labels?: string[] | null
      commentCount?: number | null
      projectKey: string
      url?: string | null
      createdAt: string
      updatedAt: string
    }>,
  ): Promise<void>
  deleteIssue(idOrKey: string): Promise<void>
  pruneIssuesMissingUpstream(projectKey: string, upstreamIssueIds: string[]): Promise<void>
  adjustIssueCommentCount(idOrKey: string, delta: number): Promise<void>

  // Activity
  saveActivity(rows: JiraActivityRow[]): Promise<void>
  getCachedActivity(params?: { issueId?: string; limit?: number }): Promise<JiraActivityRow[]>

  // Reads / materialization
  getColumns(): Promise<JiraColumnRow[]>
  getCachedBoard(): Promise<BoardView>
  getCachedTask(lookup: string): Promise<Task | null>
  getCachedTasks(params?: { columnId?: string }): Promise<Task[]>
  getCachedConfig(): Promise<JiraCacheConfig>

  // Catalog/issue lookups used by the write paths
  getDiscoveredAssignees(): Promise<string[]>
  findPriorityName(wanted: string): Promise<string | null>
  getPriorityNames(): Promise<string[]>
  findActiveAssigneeAccountId(displayName: string): Promise<string | null>
  findIssueTypeId(name: string): Promise<string | null>
  getIssueTypeNames(): Promise<string[]>
  resolveIssueId(lookup: string): Promise<string | null>
}

type JiraCacheIssue = Parameters<JiraCachePort['upsertIssues']>[0][number]

// Map a Jira API issue to the cache upsert row. Shared by bulk sync, direct
// hydrate, and webhook ingest so every path caches the same issue shape.
function toCacheIssue(
  issue: JiraIssue,
  baseUrl: string,
  fallbackProjectKey: string,
): JiraCacheIssue {
  return {
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
    projectKey: issue.fields.project?.key ?? fallbackProjectKey,
    url: `${baseUrl}/browse/${issue.key}`,
    createdAt: issue.fields.created,
    updatedAt: issue.fields.updated,
  }
}

/**
 * Shared Jira provider business logic (sync orchestration, hydration, writes,
 * transitions, comments, webhook dispatch, activity mapping). Concrete providers
 * (JiraProvider over SQLite, PostgresJiraProvider over Postgres) subclass this
 * and inject a JiraCachePort plus the API client.
 */
export class JiraProviderCore implements KanbanProvider {
  readonly type = 'jira' as const
  protected readonly client: JiraClient
  protected readonly pollingSyncIntervalMs: number
  private readonly syncGate: SyncGate

  constructor(
    protected readonly cache: JiraCachePort,
    protected readonly config: JiraProviderConfig,
    client?: JiraClient,
  ) {
    this.pollingSyncIntervalMs = config.pollingSyncIntervalMs ?? DEFAULT_POLLING_SYNC_INTERVAL_MS
    this.syncGate = new SyncGate(this.pollingSyncIntervalMs)
    this.client =
      client ??
      new JiraClient({
        baseUrl: config.baseUrl,
        email: config.email,
        apiToken: config.apiToken,
      })
  }

  async initialize(): Promise<void> {
    await this.cache.ready
  }

  protected async sync(force = false, viaWarmer = false): Promise<void> {
    await this.cache.ready
    const meta = await this.cache.loadSyncMeta()
    // Server mode: a background warmer (syncCache(), viaWarmer=true) owns refresh.
    // Once the cache has synced at least once (lastSyncAt persisted), implicit
    // request-path reads serve the warm cache instead of blocking on a Jira
    // round-trip — a foreground sync here can run a periodic full reconcile
    // (~minutes) and would otherwise exceed the HTTP idle timeout. Forced syncs
    // (writes' read-after-write) and the warmer still run; CLI mode and cold start
    // (no prior sync) fall through and sync synchronously, preserving freshness.
    if (this.syncGate.shouldSkip({ force, viaWarmer, lastSyncAt: meta.lastSyncAt })) return
    const now = Date.now()
    // `force` only bypasses the poll throttle; it must NOT imply a full
    // 1970-based reconcile, which re-fetches every issue plus a per-issue
    // changelog call (~minutes). Writes get read-after-write freshness from
    // hydrateIssueByKey instead, so a forced sync stays a cheap delta.
    const fullReconcile = shouldRunFullReconcile(meta.lastFullSyncAt, now)

    // 1. Resolve project.
    const project = await this.client.getProject(this.config.projectKey)
    await this.cache.saveTeamInfo({ id: project.id, key: project.key, name: project.name })

    // 2. Columns: board path OR status fallback path.
    if (this.config.boardId !== undefined) {
      const boardCfg = await this.client.getBoardColumns(this.config.boardId)
      const boardId = this.config.boardId
      const rows = jiraBoardColumnRows(boardId, boardCfg.columnConfig.columns)
      await this.cache.replaceColumns(rows, fullReconcile)
    } else {
      const statusCats = await this.client.getProjectStatuses(project.key)
      const seen = new Set<string>()
      const uniqueStatuses: Array<{ id: string; name: string }> = []
      for (const cat of statusCats) {
        for (const s of cat.statuses) {
          if (seen.has(s.id)) continue
          seen.add(s.id)
          uniqueStatuses.push({ id: s.id, name: s.name })
        }
      }
      const rows = uniqueStatuses.map((s, i) => ({
        id: `status:${s.id}`,
        name: s.name,
        position: i,
        statusIds: [s.id],
        source: 'status' as const,
      }))
      await this.cache.replaceColumns(rows, fullReconcile)
    }

    // 3. Catalogs: users + priorities + issue types in parallel.
    // NOTE: listAssignableUsers is capped at 100 in T04; tenants with more
    // assignable users are truncated. Pagination is out of scope for this pass.
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
      users.map((u) => ({
        accountId: u.accountId,
        displayName: u.displayName,
        active: u.active ?? true,
      })),
    )
    await this.cache.replacePriorities(
      priorities.map((p) => ({ id: p.id, name: p.name })),
      fullReconcile,
    )
    await this.cache.replaceIssueTypes(
      issueTypes.map((t) => ({ id: t.id, name: t.name })),
      fullReconcile,
    )

    // 4. Delta issue fetch (paginated).
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
        page.issues.map((issue) => toCacheIssue(issue, this.config.baseUrl, project.key)),
      )

      for (const issue of page.issues) {
        if (fullReconcile) seenIssueIds.add(issue.id)
        if (newestUpdatedAt === null || issue.fields.updated > newestUpdatedAt) {
          newestUpdatedAt = issue.fields.updated
        }
      }

      // Fetch changelog per changed issue so the poll-based
      // `moved` trigger in @garage/dispatch works. Server-side dedupe
      // keyed on (issue_id, history_id, item_field) keeps this cheap
      // even if the same issue is updated repeatedly.
      await forEachWithConcurrency(page.issues, 5, async (issue) => {
        await this.ingestIssueActivity(issue.id).catch((err) => {
          // Activity is best-effort; the main sync shouldn't fail if
          // one changelog call 404s or rate-limits.
          console.warn(`[jira] activity fetch for ${issue.key} failed:`, err)
        })
      })

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

    // 5. Save sync meta.
    const nextMeta: Partial<JiraSyncMeta> = {
      projectKey: project.key,
      boardId: this.config.boardId ?? null,
      lastSyncAt: new Date().toISOString(),
      lastIssueUpdatedAt: newestUpdatedAt ?? new Date().toISOString(),
    }
    if (fullReconcile) {
      nextMeta.lastFullSyncAt = nextMeta.lastSyncAt
    }
    await this.cache.saveSyncMeta(nextMeta)
  }

  private async resolveColumnId(input: string): Promise<string> {
    return resolveJiraColumnId(await this.cache.getColumns(), input)
  }

  private async buildBoardConfig(): Promise<BoardConfig> {
    const cache = await this.cache.getCachedConfig()
    const members = cache.users.map((u) => ({
      name: u.displayName,
      role: 'human' as const,
    }))
    const projects = cache.projectKey ? [cache.projectKey] : []
    const discoveredAssignees = await this.cache.getDiscoveredAssignees()
    const discoveredProjects = projects.slice()
    return {
      members,
      projects,
      provider: 'jira',
      discoveredAssignees,
      discoveredProjects,
    }
  }

  async syncCache(): Promise<void> {
    // viaWarmer bypasses the backgroundManaged request-path suppression without
    // forcing a full reconcile (force=false keeps the normal delta/full cadence).
    await this.sync(false, true)
  }

  setBackgroundManaged(managed: boolean): void {
    this.syncGate.setBackgroundManaged(managed)
  }

  async getSyncStatus() {
    const meta = await this.cache.loadSyncMeta()
    return syncStatusFromMeta(meta)
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
    return (await this.cache.getColumns()).map((r) => ({
      id: r.id,
      name: r.name,
      position: r.position,
      color: null,
      created_at: '',
      updated_at: '',
    }))
  }

  async listTasks(filters: TaskListFilters = {}): Promise<Task[]> {
    await this.sync()
    const columnId = filters.column ? await this.resolveColumnId(filters.column) : undefined
    return applyTaskFilters(
      await this.cache.getCachedTasks(columnId ? { columnId } : undefined),
      filters,
    )
  }

  async getTask(idOrRef: string): Promise<Task> {
    await this.sync()
    const task = await this.cache.getCachedTask(idOrRef)
    if (!task) {
      throw new KanbanError(ErrorCode.TASK_NOT_FOUND, `No task with id '${idOrRef}'`)
    }
    return task
  }

  private async resolveJiraPriorityName(canonical: Priority): Promise<string> {
    const wanted = CANONICAL_TO_JIRA_DEFAULT[canonical]
    const found = await this.cache.findPriorityName(wanted)
    if (found) return found
    const available = await this.cache.getPriorityNames()
    providerUpstreamError(
      `Canonical priority '${canonical}' maps to Jira priority '${wanted}' which is not present in this tenant's priority catalog. Available Jira priorities: [${available
        .map((n) => `"${n}"`)
        .join(', ')}]`,
    )
  }

  // Empty-string / null assignee means "clear" — handled by callers; this
  // resolver is only invoked for non-empty displayName values.
  // Jira Cloud REST only accepts accountId for assignee writes; we never
  // write `emailAddress`.
  private async resolveAssigneeAccountId(displayName: string): Promise<string> {
    const accountId = await this.cache.findActiveAssigneeAccountId(displayName)
    if (accountId) return accountId
    providerUpstreamError(
      `Jira assignee '${displayName}' was not found in the cached active user list. Try 'kanban task list --assignee' to see cached names.`,
    )
  }

  private async resolveIssueTypeId(name: string): Promise<string> {
    const id = await this.cache.findIssueTypeId(name)
    if (id) return id
    const available = await this.cache.getIssueTypeNames()
    providerUpstreamError(
      `Jira issue type '${name}' is not present in this project's issue-type catalog. Available types: [${available
        .map((n) => `"${n}"`)
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

  private async resolveTaskByIdOrKey(idOrRef: string): Promise<Task> {
    const task = await this.cache.getCachedTask(idOrRef)
    if (!task) {
      throw new KanbanError(ErrorCode.TASK_NOT_FOUND, `No task with id '${idOrRef}'`)
    }
    return task
  }

  private issueKeyFor(task: Task): string {
    return task.externalRef ?? task.providerId ?? task.id.replace(/^jira:/, '')
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

  // Read-after-write via the direct issue endpoint. Unlike JQL search (used by
  // sync()), GET /issue/{key} has no search-index lag, so a just-created or
  // just-transitioned issue is reflected immediately. This replaces the previous
  // "create/transition then sync(true) then getCachedTask" pattern, which raced
  // the search index (creates reported "not yet visible"; a move's new status
  // sometimes didn't land) and forced a full whole-project reconcile per write.
  private async hydrateIssueByKey(key: string): Promise<Task> {
    // getIssue throws on a missing key (404), so reaching this method means the
    // issue exists upstream. A null read-back would therefore be a genuine cache
    // anomaly (the upsert above did not land), not an ordinary not-found — surface
    // it rather than threading an unreachable null through every caller.
    const issue = await this.client.getIssue(key)
    await this.cache.upsertIssues([
      toCacheIssue(issue, this.config.baseUrl, this.config.projectKey),
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
    if (input.description !== undefined) {
      fields['description'] = plainTextToAdf(input.description)
    }
    if (input.priority !== undefined) {
      fields['priority'] = { name: await this.resolveJiraPriorityName(input.priority) }
    }
    if (input.assignee) {
      fields['assignee'] = {
        accountId: await this.resolveAssigneeAccountId(input.assignee),
      }
    }
    const labels = normalizeJiraLabels(input.labels)
    if (labels.length > 0) fields['labels'] = labels
    // Column at create-time is intentionally unsupported in Jira mode: new
    // issues land in the project workflow's default start state. Use
    // `moveTask` after create to change status.
    const created = await this.client.createIssue({ fields })
    return this.hydrateIssueByKey(created.key)
  }

  async updateTask(idOrRef: string, input: UpdateTaskInput): Promise<Task> {
    await this.sync()
    this.normalizeProjectField(input.project)
    if (input.metadata !== undefined) {
      unsupportedOperation('Jira mode does not support metadata updates')
    }
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
    if (input.description !== undefined) {
      fields['description'] = plainTextToAdf(input.description)
    }
    if (input.priority !== undefined) {
      fields['priority'] = { name: await this.resolveJiraPriorityName(input.priority) }
    }
    if (input.assignee !== undefined) {
      // Empty-string sentinel (or null) clears the assignee. Jira PUT body
      // explicitly sends null to unassign; undefined would be stripped.
      fields['assignee'] = input.assignee
        ? { accountId: await this.resolveAssigneeAccountId(input.assignee) }
        : null
    }
    if (Object.keys(fields).length > 0) {
      await this.client.updateIssue(issueKey, { fields })
    }
    return this.hydrateIssueByKey(issueKey)
  }

  async moveTask(idOrRef: string, column: string): Promise<Task> {
    await this.sync()
    const task = await this.resolveTaskByIdOrKey(idOrRef)
    return this.moveTaskByKey(this.issueKeyFor(task), column)
  }

  private async moveTaskByKey(issueKey: string, column: string): Promise<Task> {
    const columnId = await this.resolveColumnId(column)
    const columnRow = (await this.cache.getColumns()).find((c) => c.id === columnId)
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
    // First-mapped-status deterministic choice: board columns can map to
    // multiple Jira statuses; we transition to statusIds[0]. Operators who
    // want a different target must reorder the board column's statuses in Jira.
    const targetStatusId = statusIds[0]!
    const { transitions } = await this.client.getTransitions(issueKey)
    const match = transitions.find((t) => t.to.id === targetStatusId)
    if (!match) {
      const currentStatusId = (await this.cache.getCachedTask(issueKey))?.column_id ?? '<unknown>'
      providerUpstreamError(
        `Cannot transition Jira issue ${issueKey} (current status id ${currentStatusId}) to column '${columnRow.name}' (target status id ${targetStatusId}). Available transitions: [${transitions
          .map((t) => `"${t.name}"`)
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
    const lookupIssueId = taskId
      ? ((await this.cache.resolveIssueId(taskId)) ?? undefined)
      : undefined
    const rows = await this.cache.getCachedActivity({
      ...(lookupIssueId !== undefined ? { issueId: lookupIssueId } : {}),
      limit: limit ?? 100,
    })
    return Promise.all(rows.map((row) => this.activityRowToEntry(row)))
  }

  private async activityRowToEntry(row: JiraActivityRow): Promise<ActivityEntry> {
    // Map status field items to the same 'moved' shape the local provider
    // emits, so dispatch's collector can trigger uniformly. Translate status
    // ids into column ids via the cached column mapping; fall back to the raw
    // status name for unmapped rows so we never drop activity silently.
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
    const cols = await this.cache.getColumns()
    for (const col of cols) {
      if (decodeColumnStatusIds(col).includes(statusId)) return col.id
    }
    return undefined
  }

  protected async ingestIssueActivity(issueId: string): Promise<void> {
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
    return this.handleWebhookCore(payload)
  }

  // Shared webhook dispatch. Postgres wraps this with webhook-event auditing;
  // SQLite calls it directly via the default handleWebhook above.
  protected async handleWebhookCore(payload: WebhookRequest): Promise<WebhookResult> {
    if (!process.env['JIRA_WEBHOOK_SECRET']) {
      warnOnce(
        'jira-webhook-open-dev-mode',
        '[jira] JIRA_WEBHOOK_SECRET is not set — accepting webhook without signature verification (open dev mode)',
      )
    }
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
        toCacheIssue(issue, this.config.baseUrl, this.config.projectKey),
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
