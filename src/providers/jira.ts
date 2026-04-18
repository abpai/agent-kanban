import type { Database } from 'bun:sqlite'
import { ErrorCode, KanbanError } from '../errors.ts'
import type {
  ActivityEntry,
  BoardBootstrap,
  BoardConfig,
  BoardMetrics,
  BoardView,
  Column,
  Priority,
  Task,
} from '../types.ts'
import {
  headerLower,
  verifyHmacSha256,
  type WebhookRequest,
  type WebhookResult,
} from '../webhooks.ts'
import { adfToPlainText, plainTextToAdf, type AdfDocument } from './jira-adf.ts'
import { JIRA_CAPABILITIES } from './capabilities.ts'
import { providerUpstreamError, unsupportedOperation } from './errors.ts'
import { JiraClient, type JiraIssue } from './jira-client.ts'
import {
  decodeColumnStatusIds,
  deleteJiraIssue,
  getCachedBoard,
  getCachedColumns,
  getCachedConfig,
  getCachedTask,
  getCachedTasks,
  initJiraCacheSchema,
  loadJiraSyncMeta,
  loadTeamInfo,
  replaceJiraColumns,
  replaceJiraIssueTypes,
  replaceJiraPriorities,
  saveJiraSyncMeta,
  saveTeamInfo,
  upsertJiraIssues,
  upsertJiraUsers,
} from './jira-cache.ts'
import type {
  CreateTaskInput,
  KanbanProvider,
  ProviderContext,
  TaskListFilters,
  UpdateTaskInput,
} from './types.ts'

const SYNC_INTERVAL_MS = 30_000
const WEBHOOK_STRETCH_WINDOW_MS = 5 * 60_000
const WEBHOOK_STRETCHED_INTERVAL_MS = 5 * 60_000

function effectiveSyncInterval(lastWebhookAt: string | null, now: number): number {
  if (!lastWebhookAt) return SYNC_INTERVAL_MS
  const lastWebhookMs = Date.parse(lastWebhookAt)
  if (!Number.isFinite(lastWebhookMs)) return SYNC_INTERVAL_MS
  return now - lastWebhookMs < WEBHOOK_STRETCH_WINDOW_MS
    ? WEBHOOK_STRETCHED_INTERVAL_MS
    : SYNC_INTERVAL_MS
}

// Default canonical->Jira priority name mapping. A Jira admin may rename
// priorities; the write path looks up the resolved name (case-insensitive)
// in the cached `jira_priorities` table, so renames that preserve the default
// casing still resolve.
const CANONICAL_TO_JIRA_DEFAULT: Record<Priority, string> = {
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
}

export class JiraProvider implements KanbanProvider {
  readonly type = 'jira' as const
  private readonly client: JiraClient
  private projectId: string | null = null

  constructor(
    private readonly db: Database,
    private readonly config: JiraProviderConfig,
    client?: JiraClient,
  ) {
    initJiraCacheSchema(db)
    this.client =
      client ??
      new JiraClient({
        baseUrl: config.baseUrl,
        email: config.email,
        apiToken: config.apiToken,
      })
  }

  private async sync(force = false): Promise<void> {
    const meta = loadJiraSyncMeta(this.db)
    const lastSyncAtMs = meta.lastSyncAt ? Date.parse(meta.lastSyncAt) : 0
    const now = Date.now()
    const interval = effectiveSyncInterval(meta.lastWebhookAt, now)
    if (!force && lastSyncAtMs && now - lastSyncAtMs < interval) return

    // 1. Resolve project.
    const project = await this.client.getProject(this.config.projectKey)
    this.projectId = project.id
    saveTeamInfo(this.db, { id: project.id, key: project.key, name: project.name })

    // 2. Columns: board path OR status fallback path.
    if (this.config.boardId !== undefined) {
      const boardCfg = await this.client.getBoardColumns(this.config.boardId)
      const boardId = this.config.boardId
      const rows = boardCfg.columnConfig.columns.map((col, i) => ({
        id: `board:${boardId}:${col.name}`,
        name: col.name,
        position: i,
        statusIds: col.statuses.map((s) => s.id),
        source: 'board' as const,
      }))
      replaceJiraColumns(this.db, rows)
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
      replaceJiraColumns(this.db, rows)
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
    upsertJiraUsers(
      this.db,
      users.map((u) => ({
        accountId: u.accountId,
        displayName: u.displayName,
        active: u.active ?? true,
      })),
    )
    replaceJiraPriorities(
      this.db,
      priorities.map((p) => ({ id: p.id, name: p.name })),
    )
    replaceJiraIssueTypes(
      this.db,
      issueTypes.map((t) => ({ id: t.id, name: t.name })),
    )

    // 4. Delta issue fetch (paginated).
    const since = force ? null : meta.lastIssueUpdatedAt
    const sinceClause = since ?? '1970-01-01 00:00'
    const jql = `project = ${project.key} AND updated >= "${sinceClause}" ORDER BY updated ASC`

    let startAt = 0
    const maxResults = 100
    let accumulated = 0
    let total = Infinity
    let newestUpdatedAt: string | null = meta.lastIssueUpdatedAt
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
    // Terminates when accumulated reaches total, or when the server returns
    // an empty page (defensive against buggy servers not advancing startAt).
    while (accumulated < total) {
      const page = await this.client.listIssues({ jql, startAt, maxResults, fields: issueFields })
      total = page.total
      if (page.issues.length === 0) break

      upsertJiraIssues(
        this.db,
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
        if (newestUpdatedAt === null || issue.fields.updated > newestUpdatedAt) {
          newestUpdatedAt = issue.fields.updated
        }
      }

      accumulated += page.issues.length
      startAt += page.issues.length
    }

    // 5. Save sync meta.
    saveJiraSyncMeta(this.db, {
      projectKey: project.key,
      boardId: this.config.boardId ?? null,
      lastSyncAt: new Date().toISOString(),
      lastIssueUpdatedAt: newestUpdatedAt ?? new Date().toISOString(),
    })
  }

  private resolveColumnId(input: string): string {
    const columns = getCachedColumns(this.db)
    // Priority 1: exact id.
    const byId = columns.find((c) => c.id === input)
    if (byId) return byId.id
    // Priority 2: case-insensitive name.
    const lower = input.toLowerCase()
    const byName = columns.find((c) => c.name.toLowerCase() === lower)
    if (byName) return byName.id
    // Priority 3: status_ids containment (raw status id).
    const byStatus = columns.find((c) => decodeColumnStatusIds(c).includes(input))
    if (byStatus) return byStatus.id
    throw new KanbanError(ErrorCode.COLUMN_NOT_FOUND, `No Jira column matching '${input}'`)
  }

  private async buildBoardConfig(): Promise<BoardConfig> {
    const cache = getCachedConfig(this.db)
    const members = cache.users.map((u) => ({
      name: u.displayName,
      role: 'human' as const,
    }))
    const projects = cache.projectKey ? [cache.projectKey] : []
    const discoveredAssignees = (
      this.db
        .query("SELECT DISTINCT assignee_name FROM jira_issues WHERE assignee_name != ''")
        .all() as { assignee_name: string }[]
    )
      .map((r) => r.assignee_name)
      .sort()
    const discoveredProjects = projects.slice()
    return {
      members,
      projects,
      provider: 'jira',
      discoveredAssignees,
      discoveredProjects,
    }
  }

  async getContext(): Promise<ProviderContext> {
    await this.sync()
    return {
      provider: 'jira',
      capabilities: JIRA_CAPABILITIES,
      team: loadTeamInfo(this.db),
    }
  }

  async getBootstrap(): Promise<BoardBootstrap> {
    await this.sync()
    return {
      provider: 'jira',
      capabilities: JIRA_CAPABILITIES,
      board: getCachedBoard(this.db),
      config: await this.buildBoardConfig(),
      metrics: null,
      activity: [],
      team: loadTeamInfo(this.db),
    }
  }

  async getBoard(): Promise<BoardView> {
    await this.sync()
    return getCachedBoard(this.db)
  }

  async listColumns(): Promise<Column[]> {
    await this.sync()
    return getCachedColumns(this.db).map((r) => ({
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
    const columnId = filters.column ? this.resolveColumnId(filters.column) : undefined
    let tasks = getCachedTasks(this.db, columnId ? { columnId } : undefined)
    if (filters.priority) tasks = tasks.filter((t) => t.priority === filters.priority)
    if (filters.assignee) tasks = tasks.filter((t) => t.assignee === filters.assignee)
    if (filters.project) tasks = tasks.filter((t) => t.project === filters.project)
    if (filters.sort === 'title') tasks = [...tasks].sort((a, b) => a.title.localeCompare(b.title))
    if (filters.sort === 'updated')
      tasks = [...tasks].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    if (filters.limit) tasks = tasks.slice(0, filters.limit)
    return tasks
  }

  async getTask(idOrRef: string): Promise<Task> {
    await this.sync()
    const task = getCachedTask(this.db, idOrRef)
    if (!task) {
      throw new KanbanError(ErrorCode.TASK_NOT_FOUND, `No task with id '${idOrRef}'`)
    }
    return task
  }

  private resolveJiraPriorityName(canonical: Priority): string {
    const wanted = CANONICAL_TO_JIRA_DEFAULT[canonical]
    const row = this.db
      .query('SELECT name FROM jira_priorities WHERE LOWER(name) = LOWER($name) LIMIT 1')
      .get({ $name: wanted }) as { name: string } | null
    if (row) return row.name
    const available = (
      this.db.query('SELECT name FROM jira_priorities ORDER BY name').all() as { name: string }[]
    ).map((r) => r.name)
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
  private resolveAssigneeAccountId(displayName: string): string {
    const row = this.db
      .query(
        'SELECT account_id FROM jira_users WHERE active = 1 AND LOWER(display_name) = LOWER($name) LIMIT 1',
      )
      .get({ $name: displayName }) as { account_id: string } | null
    if (row) return row.account_id
    providerUpstreamError(
      `Jira assignee '${displayName}' was not found in the cached active user list. Try 'kanban task list --assignee' to see cached names.`,
    )
  }

  private resolveIssueTypeId(name: string): string {
    const row = this.db
      .query('SELECT id FROM jira_issue_types WHERE LOWER(name) = LOWER($name) LIMIT 1')
      .get({ $name: name }) as { id: string } | null
    if (row) return row.id
    const available = (
      this.db.query('SELECT name FROM jira_issue_types ORDER BY name').all() as { name: string }[]
    ).map((r) => r.name)
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

  private resolveTaskByIdOrKey(idOrRef: string): Task {
    const task = getCachedTask(this.db, idOrRef)
    if (!task) {
      throw new KanbanError(ErrorCode.TASK_NOT_FOUND, `No task with id '${idOrRef}'`)
    }
    return task
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    await this.sync()
    this.normalizeProjectField(input.project)
    const issueTypeName = this.config.defaultIssueType ?? 'Task'
    const issueTypeId = this.resolveIssueTypeId(issueTypeName)
    const fields: Record<string, unknown> = {
      project: { key: this.config.projectKey },
      summary: input.title,
      issuetype: { id: issueTypeId },
    }
    if (input.description !== undefined) {
      fields['description'] = plainTextToAdf(input.description)
    }
    if (input.priority !== undefined) {
      fields['priority'] = { name: this.resolveJiraPriorityName(input.priority) }
    }
    if (input.assignee) {
      fields['assignee'] = {
        accountId: this.resolveAssigneeAccountId(input.assignee),
      }
    }
    // Column at create-time is intentionally unsupported in Jira mode: new
    // issues land in the project workflow's default start state. Use
    // `moveTask` after create to change status.
    const created = await this.client.createIssue({ fields })
    await this.sync(true)
    const fresh = getCachedTask(this.db, created.key)
    if (!fresh) {
      providerUpstreamError(
        `Jira issue ${created.key} was created but is not yet visible in the cache after sync.`,
      )
    }
    return fresh
  }

  async updateTask(idOrRef: string, input: UpdateTaskInput): Promise<Task> {
    await this.sync()
    this.normalizeProjectField(input.project)
    if (input.metadata !== undefined) {
      unsupportedOperation('Jira mode does not support metadata updates')
    }
    const task = this.resolveTaskByIdOrKey(idOrRef)
    if (input.expectedVersion !== undefined && task.version !== input.expectedVersion) {
      throw new KanbanError(
        ErrorCode.CONFLICT,
        `Jira issue ${task.externalRef ?? idOrRef} was updated remotely (expected version ${input.expectedVersion}, current ${task.version ?? 'unknown'})`,
      )
    }
    const issueKey = task.externalRef ?? task.providerId ?? task.id.replace(/^jira:/, '')
    const fields: Record<string, unknown> = {}
    if (input.title !== undefined) fields['summary'] = input.title
    if (input.description !== undefined) {
      fields['description'] = plainTextToAdf(input.description)
    }
    if (input.priority !== undefined) {
      fields['priority'] = { name: this.resolveJiraPriorityName(input.priority) }
    }
    if (input.assignee !== undefined) {
      // Empty-string sentinel (or null) clears the assignee. Jira PUT body
      // explicitly sends null to unassign; undefined would be stripped.
      fields['assignee'] = input.assignee
        ? { accountId: this.resolveAssigneeAccountId(input.assignee) }
        : null
    }
    if (Object.keys(fields).length > 0) {
      await this.client.updateIssue(issueKey, { fields })
    }
    await this.sync(true)
    const fresh = getCachedTask(this.db, issueKey)
    if (!fresh) {
      providerUpstreamError(`Jira issue ${issueKey} disappeared from cache after update.`)
    }
    return fresh
  }

  async moveTask(idOrRef: string, column: string): Promise<Task> {
    await this.sync()
    const task = this.resolveTaskByIdOrKey(idOrRef)
    const issueKey = task.externalRef ?? task.providerId ?? task.id.replace(/^jira:/, '')
    return this.moveTaskByKey(issueKey, column)
  }

  private async moveTaskByKey(issueKey: string, column: string): Promise<Task> {
    const columnId = this.resolveColumnId(column)
    const columnRow = getCachedColumns(this.db).find((c) => c.id === columnId)
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
      const currentStatusId = getCachedTask(this.db, issueKey)?.column_id ?? '<unknown>'
      providerUpstreamError(
        `Cannot transition Jira issue ${issueKey} (current status id ${currentStatusId}) to column '${columnRow.name}' (target status id ${targetStatusId}). Available transitions: [${transitions
          .map((t) => `"${t.name}"`)
          .join(', ')}]`,
      )
    }
    await this.client.transitionIssue(issueKey, match.id)
    await this.sync(true)
    const fresh = getCachedTask(this.db, issueKey)
    if (!fresh) {
      providerUpstreamError(`Jira issue ${issueKey} missing from cache after transition.`)
    }
    return fresh
  }

  async deleteTask(_idOrRef: string): Promise<Task> {
    unsupportedOperation('Task deletion is not supported in Jira mode')
  }

  async getActivity(_limit?: number, _taskId?: string): Promise<ActivityEntry[]> {
    unsupportedOperation('Activity is not available in Jira mode')
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
    const secret = process.env['JIRA_WEBHOOK_SECRET']
    if (secret) {
      const sig = headerLower(payload.headers, 'x-hub-signature-256')
      if (!verifyHmacSha256(secret, payload.rawBody, sig)) {
        return { handled: false, unauthorized: true, message: 'Invalid signature' }
      }
    }
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
      deleteJiraIssue(this.db, issue.id)
      saveJiraSyncMeta(this.db, { lastWebhookAt: new Date().toISOString() })
      return { handled: true }
    }

    if (event === 'jira:issue_created' || event === 'jira:issue_updated') {
      upsertJiraIssues(this.db, [
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
      saveJiraSyncMeta(this.db, { lastWebhookAt: new Date().toISOString() })
      return { handled: true }
    }

    return { handled: false, message: `Unsupported event: ${event}` }
  }
}
