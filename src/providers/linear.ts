import type { Database } from 'bun:sqlite'
import { ErrorCode, KanbanError } from '../errors'
import type {
  ActivityEntry,
  BoardBootstrap,
  BoardConfig,
  BoardMetrics,
  Column,
  TaskComment,
  Task,
} from '../types'
import { headerLower, verifyHmacSha256, type WebhookRequest, type WebhookResult } from '../webhooks'
import { LINEAR_CAPABILITIES } from './capabilities'
import {
  adjustLinearIssueCommentCount,
  deleteLinearIssue,
  getCachedBoard,
  getCachedColumns,
  getCachedConfig,
  getCachedLinearActivity,
  getCachedTask,
  getCachedTasks,
  initLinearCacheSchema,
  loadSyncMeta,
  pruneLinearIssues,
  replaceStates,
  saveLinearActivity,
  saveSyncMeta,
  upsertIssues,
  upsertProjects,
  upsertUsers,
  type LinearActivityRow,
} from './linear-cache'
import { LinearClient, type LinearComment } from './linear-client'
import { unsupportedOperation } from './errors'
import type {
  CreateTaskInput,
  KanbanProvider,
  ProviderContext,
  ProviderSyncStatus,
  TaskListFilters,
  UpdateTaskInput,
} from './types'

const SYNC_INTERVAL_MS = 30_000
const FULL_RECONCILIATION_INTERVAL_MS = 5 * 60_000

function parseTimestamp(value: string | null | undefined): number {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function maxTimestamp(a: string | null | undefined, b: string | null | undefined): string | null {
  const aMs = parseTimestamp(a)
  const bMs = parseTimestamp(b)
  if (!aMs && !bMs) return null
  return aMs >= bMs ? (a ?? null) : (b ?? null)
}

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

export class LinearProvider implements KanbanProvider {
  readonly type = 'linear' as const
  private readonly client: LinearClient

  constructor(
    private readonly db: Database,
    private readonly teamId: string,
    apiKey: string,
  ) {
    initLinearCacheSchema(db)
    this.client = new LinearClient(apiKey)
  }

  private resolvedTeamId(): string {
    return loadSyncMeta(this.db).team?.id ?? this.teamId
  }

  private async getConfiguredTeam(): Promise<{ id: string; key: string; name: string }> {
    const metaTeam = loadSyncMeta(this.db).team
    if (metaTeam) return metaTeam

    const team = await this.client.getTeam(this.teamId)
    const configuredTeam = { id: team.id, key: team.key, name: team.name }
    saveSyncMeta(this.db, { team: configuredTeam })
    return configuredTeam
  }

  private async sync(force = false): Promise<void> {
    const meta = loadSyncMeta(this.db)
    const lastSyncAtMs = parseTimestamp(meta.lastSyncAt)
    const lastFullSyncAtMs = parseTimestamp(meta.lastFullSyncAt)
    const now = Date.now()
    if (!force && lastSyncAtMs && now - lastSyncAtMs < SYNC_INTERVAL_MS) return

    const shouldFullSync =
      force ||
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

    replaceStates(this.db, team.states)
    upsertUsers(this.db, users)
    upsertProjects(this.db, projects)
    upsertIssues(
      this.db,
      issues.map((issue) => ({
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
      })),
    )
    if (shouldFullSync) {
      pruneLinearIssues(
        this.db,
        issues.map((issue) => issue.id),
      )
    }

    const newestIssueTimestamp = maxTimestamp(
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
    saveSyncMeta(this.db, {
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
      const results = await Promise.all(
        batch.map((issueId) => this.fetchIssueHistory(issueId, sinceIso)),
      )
      const rows = results.flat()
      if (rows.length > 0) saveLinearActivity(this.db, rows)
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

  private resolveTask(idOrRef: string): Task {
    const task = getCachedTask(this.db, idOrRef)
    if (!task) {
      throw new KanbanError(ErrorCode.TASK_NOT_FOUND, `No task with id '${idOrRef}'`)
    }
    return task
  }

  private resolveState(column: string): Column {
    const states = getCachedColumns(this.db)
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

  private resolveAssigneeId(name?: string): string | undefined {
    if (!name) return undefined
    const row = this.db
      .query('SELECT id FROM linear_users WHERE LOWER(name) = LOWER($name) LIMIT 1')
      .get({ $name: name }) as { id: string } | null
    return row?.id
  }

  private resolveProjectId(name?: string): string | undefined {
    if (!name) return undefined
    const row = this.db
      .query('SELECT id FROM linear_projects WHERE LOWER(name) = LOWER($name) LIMIT 1')
      .get({ $name: name }) as { id: string } | null
    return row?.id
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
    await this.sync()
  }

  async getSyncStatus(): Promise<ProviderSyncStatus> {
    const meta = loadSyncMeta(this.db)
    return {
      lastSyncAt: meta.lastSyncAt,
      lastFullSyncAt: meta.lastFullSyncAt,
      lastWebhookAt: meta.lastWebhookAt,
    }
  }

  async getContext(): Promise<ProviderContext> {
    await this.sync()
    const meta = loadSyncMeta(this.db)
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
      board: getCachedBoard(this.db),
      config: getCachedConfig(this.db),
      metrics: null,
      activity: [],
      team: loadSyncMeta(this.db).team,
    }
  }

  async getBoard() {
    await this.sync()
    return getCachedBoard(this.db)
  }

  async listColumns() {
    await this.sync()
    return getCachedColumns(this.db)
  }

  async listTasks(filters: TaskListFilters = {}) {
    await this.sync()
    let tasks = getCachedTasks(this.db)
    if (filters.column) {
      const column = this.resolveState(filters.column)
      tasks = tasks.filter((task) => task.column_id === column.id)
    }
    if (filters.priority) tasks = tasks.filter((task) => task.priority === filters.priority)
    if (filters.assignee) tasks = tasks.filter((task) => task.assignee === filters.assignee)
    if (filters.project) tasks = tasks.filter((task) => task.project === filters.project)
    if (filters.sort === 'title') tasks = [...tasks].sort((a, b) => a.title.localeCompare(b.title))
    if (filters.sort === 'updated')
      tasks = [...tasks].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    if (filters.limit) tasks = tasks.slice(0, filters.limit)
    return tasks
  }

  async getTask(idOrRef: string) {
    await this.sync()
    return this.resolveTask(idOrRef)
  }

  async createTask(input: CreateTaskInput) {
    await this.sync()
    const state = input.column ? this.resolveState(input.column) : undefined
    const result = await this.client.createIssue({
      teamId: this.resolvedTeamId(),
      stateId: state?.id,
      title: input.title,
      description: input.description,
      priority: toLinearPriority(input.priority),
      assigneeId: this.resolveAssigneeId(input.assignee),
      projectId: this.resolveProjectId(input.project),
    })
    if (!result.success || !result.issue) {
      throw new KanbanError(ErrorCode.PROVIDER_UPSTREAM_ERROR, 'Linear issue creation failed')
    }
    const issue = result.issue
    upsertIssues(this.db, [
      {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? '',
        priority: issue.priority ?? 0,
        assigneeId: issue.assignee?.id ?? null,
        assigneeName: issue.assignee?.name ?? issue.assignee?.displayName ?? '',
        projectId: issue.project?.id ?? null,
        projectName: issue.project?.name ?? '',
        stateId: issue.state.id,
        stateName: issue.state.name,
        statePosition: issue.state.position,
        labels: issue.labels ?? [],
        commentCount: issue.commentCount,
        url: issue.url ?? null,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
      },
    ])
    return this.resolveTask(issue.id)
  }

  async updateTask(idOrRef: string, input: UpdateTaskInput) {
    await this.sync()
    const task = this.resolveTask(idOrRef)
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
      updateInput['assigneeId'] = this.resolveAssigneeId(input.assignee) ?? null
    if (input.project !== undefined)
      updateInput['projectId'] = this.resolveProjectId(input.project) ?? null
    if (input.metadata !== undefined) {
      unsupportedOperation('Linear mode does not support metadata updates')
    }
    const result = await this.client.updateIssue(task.providerId || task.id, updateInput)
    if (!result.success) {
      throw new KanbanError(ErrorCode.PROVIDER_UPSTREAM_ERROR, 'Linear issue update failed')
    }
    await this.sync(true)
    return this.resolveTask(task.providerId || task.id)
  }

  async moveTask(idOrRef: string, column: string) {
    await this.sync()
    const task = this.resolveTask(idOrRef)
    const state = this.resolveState(column)
    const result = await this.client.updateIssue(task.providerId || task.id, { stateId: state.id })
    if (!result.success) {
      throw new KanbanError(ErrorCode.PROVIDER_UPSTREAM_ERROR, 'Linear issue move failed')
    }
    await this.sync(true)
    return this.resolveTask(task.providerId || task.id)
  }

  async deleteTask(_idOrRef: string): Promise<Task> {
    unsupportedOperation('Task deletion is not supported in Linear mode')
  }

  async listComments(idOrRef: string): Promise<TaskComment[]> {
    await this.sync()
    const task = this.resolveTask(idOrRef)
    const comments = await this.client.listComments(task.providerId || task.id)
    return comments.map((comment) => this.toTaskComment(task, comment))
  }

  async getComment(idOrRef: string, commentId: string): Promise<TaskComment> {
    await this.sync()
    const task = this.resolveTask(idOrRef)
    const comment = await this.client.getComment(commentId)
    return this.toTaskComment(task, comment)
  }

  async comment(idOrRef: string, body: string): Promise<TaskComment> {
    await this.sync()
    const task = this.resolveTask(idOrRef)
    const result = await this.client.commentCreate(task.providerId || task.id, body)
    if (!result.success || !result.comment) {
      throw new KanbanError(ErrorCode.PROVIDER_UPSTREAM_ERROR, 'Linear comment creation failed')
    }
    adjustLinearIssueCommentCount(this.db, task.providerId || task.id, 1)
    return this.toTaskComment(task, result.comment)
  }

  async updateComment(idOrRef: string, commentId: string, body: string): Promise<TaskComment> {
    await this.sync()
    const task = this.resolveTask(idOrRef)
    const result = await this.client.commentUpdate(commentId, body)
    if (!result.success || !result.comment) {
      throw new KanbanError(ErrorCode.PROVIDER_UPSTREAM_ERROR, 'Linear comment update failed')
    }
    return this.toTaskComment(task, result.comment)
  }

  async getActivity(limit?: number, taskId?: string): Promise<ActivityEntry[]> {
    await this.sync()
    const issueId = taskId ? this.resolveIssueIdFromTaskId(taskId) : undefined
    const rows = getCachedLinearActivity(this.db, {
      ...(issueId !== undefined ? { issueId } : {}),
      limit: limit ?? 100,
    })
    return rows.map((row) => this.activityRowToEntry(row))
  }

  private resolveIssueIdFromTaskId(taskId: string): string | undefined {
    const normalized = taskId.startsWith('linear:') ? taskId.slice('linear:'.length) : taskId
    const row = this.db
      .query<
        { id: string },
        Record<string, string>
      >(`SELECT id FROM linear_issues WHERE id = $lookup OR identifier = $lookup LIMIT 1`)
      .get({ $lookup: normalized })
    return row?.id
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
    return getCachedConfig(this.db)
  }

  async patchConfig(_input: Partial<BoardConfig>): Promise<BoardConfig> {
    unsupportedOperation('Config mutation is not supported in Linear mode')
  }

  async handleWebhook(payload: WebhookRequest): Promise<WebhookResult> {
    const secret = process.env['LINEAR_WEBHOOK_SECRET']
    if (secret) {
      const sig = headerLower(payload.headers, 'linear-signature')
      if (!verifyHmacSha256(secret, payload.rawBody, sig)) {
        return { handled: false, unauthorized: true, message: 'Invalid signature' }
      }
    }
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
      deleteLinearIssue(this.db, data.id)
      saveSyncMeta(this.db, { lastWebhookAt: new Date().toISOString() })
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
      upsertIssues(this.db, [
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
      saveSyncMeta(this.db, { lastWebhookAt: new Date().toISOString() })
      return { handled: true }
    }

    return { handled: false, message: `Unsupported action: ${body.action}` }
  }
}
