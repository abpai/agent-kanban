import { ErrorCode, KanbanError } from '../errors'
import type {
  ActivityEntry,
  BoardBootstrap,
  BoardConfig,
  BoardMetrics,
  BoardView,
  Column,
  ProviderTeamInfo,
  Task,
  TaskComment,
} from '../types'
import {
  authorizeWebhook,
  headerLower,
  verifyHmacSha256,
  type WebhookRequest,
  type WebhookResult,
} from '../webhooks'
import { LINEAR_CAPABILITIES } from './capabilities'
import {
  LinearClient,
  resolveLabelIdsForCreate,
  type LinearComment,
  type LinearIssue,
} from './linear-client'
import type { LinearActivityRow, LinearStateRow, LinearSyncMeta } from './linear-cache'
import { providerUpstreamError, unsupportedOperation } from './errors'
import type {
  CreateTaskInput,
  KanbanProvider,
  ProviderContext,
  TaskListFilters,
  UpdateTaskInput,
} from './types'
import { DEFAULT_POLLING_SYNC_INTERVAL_MS } from '../sync-config'
import { warnOnce } from './warn-once'
import {
  applyTaskFilters,
  mapWithConcurrency,
  maxSyncTimestamp,
  parseSyncTimestamp,
  SyncGate,
  syncStatusFromMeta,
} from './sync-core'

const FULL_RECONCILIATION_INTERVAL_MS = 5 * 60_000

function toLinearPriority(priority: Task['priority'] | undefined): number | undefined {
  switch (priority) {
    case 'urgent':
      return 1
    case 'high':
      return 2
    case 'medium':
      return 3
    case 'low':
      return 4
    default:
      return undefined
  }
}

type CacheIssue = Parameters<LinearCachePort['upsertIssues']>[0][number]

// Map a Linear API issue to the cache upsert row. Shared by the bulk sync and
// the single-issue hydrate path so a read-after-write refresh caches exactly the
// same shape as a full sync.
function toCacheIssue(issue: LinearIssue): CacheIssue {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? '',
    priority: issue.priority ?? 0,
    assigneeId: issue.assignee?.id ?? null,
    assigneeName: issue.assignee?.name ?? null,
    projectId: issue.project?.id ?? null,
    projectName: issue.project?.name ?? null,
    stateId: issue.state.id,
    stateName: issue.state.name,
    statePosition: issue.state.position,
    labels: issue.labels ?? [],
    commentCount: issue.commentCount,
    url: issue.url ?? null,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  }
}

/**
 * Storage-agnostic cache/repository port the Linear core depends on. The SQLite
 * (linear.ts) and Postgres (postgres-linear.ts) backends each provide an
 * implementation; the core never touches a Database or Sql client directly. All
 * methods are async so the Postgres backend is native and the SQLite backend
 * wraps its synchronous bun:sqlite calls.
 */
export interface LinearCachePort {
  readonly ready: Promise<void>

  loadSyncMeta(): Promise<LinearSyncMeta>
  saveSyncMeta(meta: Partial<LinearSyncMeta>): Promise<void>

  replaceStates(
    states: Array<{
      id: string
      name: string
      position: number
      color?: string | null
      type?: string | null
    }>,
  ): Promise<void>
  upsertUsers(users: Array<{ id: string; name: string; active?: boolean }>): Promise<void>
  upsertProjects(
    projects: Array<{ id: string; name: string; url?: string | null; state?: string | null }>,
  ): Promise<void>

  upsertIssues(
    issues: Array<{
      id: string
      identifier: string
      title: string
      description?: string | null
      priority?: number | null
      assigneeId?: string | null
      assigneeName?: string | null
      projectId?: string | null
      projectName?: string | null
      stateId: string
      stateName: string
      statePosition: number
      labels?: string[] | null
      commentCount?: number | null
      url?: string | null
      createdAt: string
      updatedAt: string
    }>,
  ): Promise<void>
  deleteIssue(idOrIdentifier: string): Promise<void>
  pruneIssues(liveIssueIds: string[]): Promise<void>
  adjustIssueCommentCount(idOrIdentifier: string, delta: number): Promise<void>

  saveActivity(rows: LinearActivityRow[]): Promise<void>
  getCachedActivity(params?: { issueId?: string; limit?: number }): Promise<LinearActivityRow[]>

  getCachedColumns(): Promise<LinearStateRow[]>
  getCachedBoard(): Promise<BoardView>
  getCachedTask(lookup: string): Promise<Task | null>
  getCachedTasks(): Promise<Task[]>
  getCachedConfig(): Promise<BoardConfig>

  // Lookups used by the write paths
  findUserIdByName(name: string): Promise<string | null>
  findProjectIdByName(name: string): Promise<string | null>
  resolveIssueId(lookup: string): Promise<string | null>
}

/**
 * Shared Linear provider business logic (sync orchestration, issue-history
 * ingest, writes, state transitions, comments, webhook dispatch, activity
 * mapping). Concrete providers (LinearProvider over SQLite, PostgresLinearProvider
 * over Postgres) subclass this and inject a LinearCachePort plus the API client.
 */
export class LinearProviderCore implements KanbanProvider {
  readonly type = 'linear' as const
  private readonly syncGate: SyncGate

  constructor(
    protected readonly cache: LinearCachePort,
    protected readonly teamId: string,
    protected readonly client: LinearClient,
    protected readonly pollingSyncIntervalMs = DEFAULT_POLLING_SYNC_INTERVAL_MS,
  ) {
    this.syncGate = new SyncGate(this.pollingSyncIntervalMs)
  }

  async initialize(): Promise<void> {
    await this.cache.ready
  }

  private async resolvedTeamId(): Promise<string> {
    return (await this.cache.loadSyncMeta()).team?.id ?? this.teamId
  }

  private async getConfiguredTeam(): Promise<ProviderTeamInfo> {
    const metaTeam = (await this.cache.loadSyncMeta()).team
    if (metaTeam) return metaTeam

    const team = await this.client.getTeam(this.teamId)
    const configuredTeam = { id: team.id, key: team.key, name: team.name }
    await this.cache.saveSyncMeta({ team: configuredTeam })
    return configuredTeam
  }

  protected async sync(force = false, viaWarmer = false): Promise<void> {
    await this.cache.ready
    const meta = await this.cache.loadSyncMeta()
    const lastFullSyncAtMs = parseSyncTimestamp(meta.lastFullSyncAt)
    // Server mode: a background warmer (syncCache(), viaWarmer=true) owns refresh.
    // Once the cache has synced at least once, implicit request-path reads serve the
    // warm cache instead of blocking on a Linear round-trip, which could exceed the
    // HTTP idle timeout. Forced syncs (writes' read-after-write) and the warmer
    // still run; CLI mode and cold start sync synchronously.
    if (this.syncGate.shouldSkip({ force, viaWarmer, lastSyncAt: meta.lastSyncAt })) return
    const now = Date.now()

    // `force` bypasses the poll throttle (above) for read-after-write freshness,
    // but does NOT imply a full workspace reconcile — that stays on its own
    // cadence so a single write isn't coupled to team-wide prune/refetch.
    const shouldFullSync =
      !lastFullSyncAtMs ||
      !meta.lastIssueUpdatedAt ||
      now - lastFullSyncAtMs >= FULL_RECONCILIATION_INTERVAL_MS

    const team = await this.client.getTeam(this.teamId)
    const [users, projects, issues] = await Promise.all([
      this.client.listUsers(),
      this.client.listProjects(),
      this.client.listIssues(
        team.id,
        shouldFullSync ? undefined : (meta.lastIssueUpdatedAt ?? undefined),
      ),
    ])

    await this.cache.replaceStates(team.states)
    await this.cache.upsertUsers(users)
    await this.cache.upsertProjects(projects)
    await this.cache.upsertIssues(issues.map(toCacheIssue))
    if (shouldFullSync) {
      await this.cache.pruneIssues(issues.map((issue) => issue.id))
    }

    const newestIssueTimestamp = maxSyncTimestamp(
      meta.lastIssueUpdatedAt,
      issues.length > 0
        ? issues.reduce(
            (latest, issue) => (issue.updatedAt > latest ? issue.updatedAt : latest),
            issues[0]!.updatedAt,
          )
        : null,
    )

    // Best-effort changelog ingest; failures don't fail the main sync.
    await this.ingestTeamHistory(
      issues.map((issue) => issue.id),
      meta.lastIssueUpdatedAt,
    ).catch((err) => {
      console.warn('[linear] issueHistory ingest failed:', err)
    })

    const syncedAt = new Date().toISOString()
    await this.cache.saveSyncMeta({
      team: { id: team.id, key: team.key, name: team.name },
      lastSyncAt: syncedAt,
      lastFullSyncAt: shouldFullSync ? syncedAt : undefined,
      lastIssueUpdatedAt: newestIssueTimestamp ?? syncedAt,
    })
  }

  private async ingestTeamHistory(issueIds: string[], sinceIso: string | null): Promise<void> {
    if (issueIds.length === 0) return
    const concurrency = 5
    for (let i = 0; i < issueIds.length; i += concurrency) {
      const batch = issueIds.slice(i, i + concurrency)
      const results = await mapWithConcurrency(batch, concurrency, (issueId) =>
        this.fetchIssueHistory(issueId, sinceIso),
      )
      const rows = results.flat()
      if (rows.length > 0) await this.cache.saveActivity(rows)
    }
  }

  private async fetchIssueHistory(
    issueId: string,
    sinceIso: string | null,
  ): Promise<LinearActivityRow[]> {
    const rows: LinearActivityRow[] = []
    let cursor: string | null = null
    for (let page = 0; page < 10; page++) {
      const batch = await this.client.listIssueHistory({ issueId, first: 50, after: cursor })
      let reachedKnown = false
      for (const node of batch.nodes) {
        // Linear returns history newest-first; once we hit an entry we've already ingested,
        // every subsequent page is older still, so break out of pagination entirely.
        if (sinceIso && node.createdAt <= sinceIso) {
          reachedKnown = true
          break
        }
        if (!node.fromState && !node.toState) continue
        rows.push({
          issue_id: issueId,
          history_id: node.id,
          item_field: 'state',
          from_value: node.fromState?.id ?? null,
          to_value: node.toState?.id ?? null,
          created_at: node.createdAt,
        })
      }
      if (reachedKnown) break
      if (!batch.pageInfo.hasNextPage || !batch.pageInfo.endCursor) break
      cursor = batch.pageInfo.endCursor
    }
    return rows
  }

  private async resolveTask(idOrRef: string): Promise<Task> {
    const task = await this.cache.getCachedTask(idOrRef)
    if (!task) {
      throw new KanbanError(ErrorCode.TASK_NOT_FOUND, `No task with id '${idOrRef}'`)
    }
    return task
  }

  private issueIdFor(task: Task): string {
    return task.providerId || task.id.replace(/^linear:/, '')
  }

  // Read-after-write refresh of a single issue. Re-fetching just the mutated
  // issue (and its history) keeps the post-write read fresh without paying for a
  // full team sync(true)/prune on every update or move.
  private async hydrateIssue(issueId: string): Promise<Task> {
    const issue = await this.client.getIssue(issueId)
    // Mirror the bulk sync's team scoping: it only caches issues from the
    // configured team. If the issue vanished upstream or moved out of the team,
    // drop the now out-of-scope local row instead of re-caching it, matching what
    // a full reconcile would eventually prune.
    if (!issue || (issue.teamId && issue.teamId !== (await this.resolvedTeamId()))) {
      await this.cache.deleteIssue(issueId)
      throw new KanbanError(ErrorCode.TASK_NOT_FOUND, `No task with id '${issueId}'`)
    }
    await this.cache.upsertIssues([toCacheIssue(issue)])
    // Best-effort changelog ingest for the moved/updated issue so activity stays
    // current; failures don't fail the write's read-after-write.
    await this.ingestTeamHistory(
      [issue.id],
      (await this.cache.loadSyncMeta()).lastIssueUpdatedAt,
    ).catch((err) => {
      console.warn('[linear] issueHistory ingest failed:', err)
    })
    return this.resolveTask(issue.id)
  }

  private async resolveState(column: string): Promise<Column> {
    const states = await this.cache.getCachedColumns()
    const match = states.find(
      (state) => state.id === column || state.name.toLowerCase() === column.toLowerCase(),
    )
    if (!match) {
      throw new KanbanError(
        ErrorCode.COLUMN_NOT_FOUND,
        `No Linear workflow state matching '${column}'`,
      )
    }
    return match
  }

  // Only invoked for non-empty names. A name that the cache cannot resolve is a
  // hard error rather than a silent drop/clear: callers handle "not provided"
  // (undefined) and "clear" (empty string) before calling this.
  private async resolveAssigneeId(name: string): Promise<string> {
    const id = await this.cache.findUserIdByName(name)
    if (!id) {
      providerUpstreamError(
        `Linear assignee '${name}' was not found in the cached user list. Try 'kanban task list --assignee' to see cached names.`,
      )
    }
    return id
  }

  private async resolveProjectId(name: string): Promise<string> {
    const id = await this.cache.findProjectIdByName(name)
    if (!id) {
      providerUpstreamError(`Linear project '${name}' was not found in the cached project list.`)
    }
    return id
  }

  private toTaskComment(task: Task, comment: LinearComment): TaskComment {
    return {
      id: comment.id,
      task_id: task.id,
      body: comment.body,
      author: comment.user?.displayName || comment.user?.name || null,
      created_at: comment.createdAt,
      updated_at: comment.updatedAt,
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
    const meta = await this.cache.loadSyncMeta()
    return {
      provider: 'linear',
      capabilities: LINEAR_CAPABILITIES,
      team: meta.team,
    }
  }

  async getBootstrap(): Promise<BoardBootstrap> {
    await this.sync()
    return {
      provider: 'linear',
      capabilities: LINEAR_CAPABILITIES,
      board: await this.cache.getCachedBoard(),
      config: await this.cache.getCachedConfig(),
      metrics: null,
      activity: [],
      team: (await this.cache.loadSyncMeta()).team,
    }
  }

  async getBoard(): Promise<BoardView> {
    await this.sync()
    return this.cache.getCachedBoard()
  }

  async listColumns(): Promise<Column[]> {
    await this.sync()
    return this.cache.getCachedColumns()
  }

  async listTasks(filters: TaskListFilters = {}): Promise<Task[]> {
    await this.sync()
    let tasks = await this.cache.getCachedTasks()
    if (filters.column) {
      const column = await this.resolveState(filters.column)
      tasks = tasks.filter((task) => task.column_id === column.id)
    }
    return applyTaskFilters(tasks, filters)
  }

  async getTask(idOrRef: string): Promise<Task> {
    await this.sync()
    return this.resolveTask(idOrRef)
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    await this.sync()
    const state = input.column ? await this.resolveState(input.column) : undefined
    const labelIds = await resolveLabelIdsForCreate(this.client, input.labels)
    const result = await this.client.createIssue({
      teamId: await this.resolvedTeamId(),
      stateId: state?.id,
      title: input.title,
      description: input.description,
      priority: toLinearPriority(input.priority),
      assigneeId: input.assignee ? await this.resolveAssigneeId(input.assignee) : undefined,
      projectId: input.project ? await this.resolveProjectId(input.project) : undefined,
      labelIds,
    })
    if (!result.success || !result.issue) {
      throw new KanbanError(ErrorCode.PROVIDER_UPSTREAM_ERROR, 'Linear issue creation failed')
    }
    const issue = result.issue
    await this.cache.upsertIssues([toCacheIssue(issue)])
    return this.resolveTask(issue.id)
  }

  async updateTask(idOrRef: string, input: UpdateTaskInput): Promise<Task> {
    await this.sync()
    const task = await this.resolveTask(idOrRef)
    if (input.expectedVersion !== undefined && task.version !== input.expectedVersion) {
      throw new KanbanError(
        ErrorCode.CONFLICT,
        `Linear issue ${task.externalRef ?? idOrRef} was updated remotely (expected version ${input.expectedVersion}, current ${task.version ?? 'unknown'})`,
      )
    }
    const updateInput: Record<string, unknown> = {}
    if (input.title !== undefined) updateInput['title'] = input.title
    if (input.description !== undefined) updateInput['description'] = input.description
    if (input.priority !== undefined) updateInput['priority'] = toLinearPriority(input.priority)
    if (input.assignee !== undefined)
      updateInput['assigneeId'] = input.assignee
        ? await this.resolveAssigneeId(input.assignee)
        : null
    if (input.project !== undefined)
      updateInput['projectId'] = input.project ? await this.resolveProjectId(input.project) : null
    if (input.metadata !== undefined) {
      unsupportedOperation('Linear mode does not support metadata updates')
    }
    const issueId = this.issueIdFor(task)
    const result = await this.client.updateIssue(issueId, updateInput)
    if (!result.success) {
      throw new KanbanError(ErrorCode.PROVIDER_UPSTREAM_ERROR, 'Linear issue update failed')
    }
    return this.hydrateIssue(issueId)
  }

  async moveTask(idOrRef: string, column: string): Promise<Task> {
    await this.sync()
    const task = await this.resolveTask(idOrRef)
    const state = await this.resolveState(column)
    const issueId = this.issueIdFor(task)
    const result = await this.client.updateIssue(issueId, { stateId: state.id })
    if (!result.success) {
      throw new KanbanError(ErrorCode.PROVIDER_UPSTREAM_ERROR, 'Linear issue move failed')
    }
    return this.hydrateIssue(issueId)
  }

  async deleteTask(_idOrRef: string): Promise<Task> {
    unsupportedOperation('Task deletion is not supported in Linear mode')
  }

  async listComments(idOrRef: string): Promise<TaskComment[]> {
    await this.sync()
    const task = await this.resolveTask(idOrRef)
    const comments = await this.client.listComments(this.issueIdFor(task))
    return comments.map((comment) => this.toTaskComment(task, comment))
  }

  async getComment(idOrRef: string, commentId: string): Promise<TaskComment> {
    await this.sync()
    const task = await this.resolveTask(idOrRef)
    const comment = await this.client.getComment(commentId)
    return this.toTaskComment(task, comment)
  }

  async comment(idOrRef: string, body: string): Promise<TaskComment> {
    await this.sync()
    const task = await this.resolveTask(idOrRef)
    const issueId = this.issueIdFor(task)
    const result = await this.client.commentCreate(issueId, body)
    if (!result.success || !result.comment) {
      throw new KanbanError(ErrorCode.PROVIDER_UPSTREAM_ERROR, 'Linear comment creation failed')
    }
    await this.cache.adjustIssueCommentCount(issueId, 1)
    return this.toTaskComment(task, result.comment)
  }

  async updateComment(idOrRef: string, commentId: string, body: string): Promise<TaskComment> {
    await this.sync()
    const task = await this.resolveTask(idOrRef)
    const result = await this.client.commentUpdate(commentId, body)
    if (!result.success || !result.comment) {
      throw new KanbanError(ErrorCode.PROVIDER_UPSTREAM_ERROR, 'Linear comment update failed')
    }
    return this.toTaskComment(task, result.comment)
  }

  async getActivity(limit?: number, taskId?: string): Promise<ActivityEntry[]> {
    await this.sync()
    const issueId = taskId ? ((await this.cache.resolveIssueId(taskId)) ?? undefined) : undefined
    const rows = await this.cache.getCachedActivity({
      ...(issueId !== undefined ? { issueId } : {}),
      limit: limit ?? 100,
    })
    return rows.map((row) => this.activityRowToEntry(row))
  }

  private activityRowToEntry(row: LinearActivityRow): ActivityEntry {
    // fromState/toState already reference state ids which agent-kanban
    // surfaces 1:1 as column ids (see linear_states/getCachedColumns),
    // so no lookup is needed here.
    return {
      id: `linear-activity:${row.issue_id}:${row.history_id}:${row.item_field}`,
      task_id: `linear:${row.issue_id}`,
      action: row.item_field === 'state' ? 'moved' : 'updated',
      field_changed: row.item_field,
      old_value: row.from_value,
      new_value: row.to_value,
      timestamp: row.created_at,
    }
  }

  async getMetrics(): Promise<BoardMetrics> {
    unsupportedOperation('Metrics are not available in Linear mode')
  }

  async getConfig(): Promise<BoardConfig> {
    await this.sync()
    return this.cache.getCachedConfig()
  }

  async patchConfig(_input: Partial<BoardConfig>): Promise<BoardConfig> {
    unsupportedOperation('Config mutation is not supported in Linear mode')
  }

  async handleWebhook(payload: WebhookRequest): Promise<WebhookResult> {
    return this.handleWebhookCore(payload)
  }

  // Shared webhook dispatch. Postgres wraps this with webhook-event auditing;
  // SQLite calls it directly via the default handleWebhook above.
  protected async handleWebhookCore(payload: WebhookRequest): Promise<WebhookResult> {
    if (!process.env['LINEAR_WEBHOOK_SECRET']) {
      warnOnce(
        'linear-webhook-open-dev-mode',
        '[linear] LINEAR_WEBHOOK_SECRET is not set — accepting webhook without signature verification (open dev mode)',
      )
    }
    const auth = authorizeWebhook({
      secret: process.env['LINEAR_WEBHOOK_SECRET'],
      rawBody: payload.rawBody,
      signature: headerLower(payload.headers, 'linear-signature'),
      verify: verifyHmacSha256,
    })
    if (auth) return auth
    let body: {
      action?: 'create' | 'update' | 'remove'
      type?: string
      data?: {
        id: string
        identifier?: string
        title?: string
        description?: string | null
        priority?: number | null
        url?: string | null
        createdAt?: string
        updatedAt?: string
        assignee?: { id: string; name?: string | null } | null
        assigneeId?: string | null
        project?: { id: string; name: string } | null
        projectId?: string | null
        state?: { id: string; name: string; position?: number } | null
        stateId?: string | null
        team?: { id?: string | null; key?: string | null } | null
        teamId?: string | null
        labels?: Array<{ id: string; name: string }> | null
        commentCount?: number | null
      }
    } = {}
    try {
      body = JSON.parse(payload.rawBody) as typeof body
    } catch {
      return { handled: false, message: 'Invalid JSON body' }
    }
    if (body.type !== 'Issue') {
      return { handled: false, message: `Ignoring ${body.type ?? 'unknown'} event` }
    }
    const data = body.data
    if (!data) return { handled: false, message: 'No data in payload' }

    if (body.action === 'remove') {
      await this.cache.deleteIssue(data.id)
      await this.cache.saveSyncMeta({ lastWebhookAt: new Date().toISOString() })
      return { handled: true }
    }

    if (body.action === 'create' || body.action === 'update') {
      const configuredTeam = await this.getConfiguredTeam()
      const payloadTeamId = data.team?.id ?? data.teamId ?? null
      if (payloadTeamId && payloadTeamId !== configuredTeam.id) {
        return {
          handled: false,
          message: `Ignoring issue from team '${payloadTeamId}'`,
        }
      }

      if (!payloadTeamId) {
        const issueTeam = await this.client.getIssueTeam(data.id)
        if (!issueTeam) {
          return {
            handled: false,
            message: `Ignoring issue '${data.id}' because its team could not be verified`,
          }
        }
        if (issueTeam.id !== configuredTeam.id) {
          return {
            handled: false,
            message: `Ignoring issue from team '${issueTeam.key}'`,
          }
        }
      }

      if (!data.identifier || !data.title || !data.createdAt || !data.updatedAt) {
        return { handled: false, message: 'Missing required issue fields' }
      }
      const stateId = data.state?.id ?? data.stateId ?? null
      if (!stateId) return { handled: false, message: 'Missing state id' }
      await this.cache.upsertIssues([
        {
          id: data.id,
          identifier: data.identifier,
          title: data.title,
          description: data.description ?? '',
          priority: data.priority ?? 0,
          assigneeId: data.assignee?.id ?? data.assigneeId ?? null,
          assigneeName: data.assignee?.name ?? null,
          projectId: data.project?.id ?? data.projectId ?? null,
          projectName: data.project?.name ?? null,
          stateId,
          stateName: data.state?.name ?? '',
          statePosition: data.state?.position ?? 0,
          labels: (data.labels ?? []).map((l) => l.name),
          commentCount: data.commentCount,
          url: data.url ?? null,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
        },
      ])
      await this.cache.saveSyncMeta({ lastWebhookAt: new Date().toISOString() })
      return { handled: true }
    }

    return { handled: false, message: `Unsupported action: ${body.action}` }
  }
}
