import type { Sql } from 'postgres'

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
import { DEFAULT_POLLING_SYNC_INTERVAL_MS } from '../sync-config'
import {
  authorizeWebhook,
  headerLower,
  verifyHmacSha256,
  type WebhookRequest,
  type WebhookResult,
} from '../webhooks'
import { extractWebhookMeta, recordWebhookEvent, webhookEventStatus } from '../webhook-events'
import { LINEAR_CAPABILITIES } from './capabilities'
import { unsupportedOperation } from './errors'
import { LinearClient, resolveLabelIdsForCreate, type LinearComment } from './linear-client'
import { PostgresLinearCache, type LinearActivityRow } from './postgres-linear-cache'
import type {
  CreateTaskInput,
  KanbanProvider,
  ProviderContext,
  ProviderSyncStatus,
  TaskListFilters,
  UpdateTaskInput,
} from './types'

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

export class PostgresLinearProvider implements KanbanProvider {
  readonly type = 'linear' as const
  private readonly ready: Promise<void>
  private readonly cache: PostgresLinearCache
  private readonly client: LinearClient
  // When a server-side background warmer owns cache refresh, implicit request-path
  // syncs are suppressed once the cache is warm so reads never block on Linear I/O.
  private backgroundManaged = false

  constructor(
    private readonly sql: Sql,
    private readonly teamId: string,
    apiKey: string,
    private readonly pollingSyncIntervalMs = DEFAULT_POLLING_SYNC_INTERVAL_MS,
    client?: LinearClient,
  ) {
    this.cache = new PostgresLinearCache(sql)
    this.ready = this.cache.ready
    this.client = client ?? new LinearClient(apiKey)
  }

  async initialize(): Promise<void> {
    await this.ready
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

  private async sync(force = false, viaWarmer = false): Promise<void> {
    await this.ready
    const meta = await this.cache.loadSyncMeta()
    const lastSyncAtMs = parseTimestamp(meta.lastSyncAt)
    const lastFullSyncAtMs = parseTimestamp(meta.lastFullSyncAt)
    // Server mode: a background warmer (syncCache(), viaWarmer=true) owns refresh.
    // Once warm, implicit request-path reads serve the warm cache instead of
    // blocking on a Linear round-trip that could exceed the HTTP idle timeout.
    // Forced syncs (write read-after-write) and the warmer still run; CLI mode and
    // cold start sync synchronously.
    if (this.backgroundManaged && !force && !viaWarmer && lastSyncAtMs) return
    const now = Date.now()
    if (!force && lastSyncAtMs && now - lastSyncAtMs < this.pollingSyncIntervalMs) return

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

    await this.cache.replaceStates(team.states)
    await this.cache.upsertUsers(users)
    await this.cache.upsertProjects(projects)
    await this.cache.upsertIssues(
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
    if (shouldFullSync) await this.cache.pruneIssues(issues.map((issue) => issue.id))

    const newestIssueTimestamp = maxTimestamp(
      meta.lastIssueUpdatedAt,
      issues.length > 0
        ? issues.reduce(
            (latest, issue) => (issue.updatedAt > latest ? issue.updatedAt : latest),
            issues[0]!.updatedAt,
          )
        : null,
    )

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
      const results = await Promise.all(
        batch.map((issueId) => this.fetchIssueHistory(issueId, sinceIso)),
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

  private async resolveAssigneeId(name?: string): Promise<string | undefined> {
    if (!name) return undefined
    const [row] = await this.sql<{ id: string }[]>`
      SELECT id FROM linear_users WHERE LOWER(name) = LOWER(${name}) LIMIT 1
    `
    return row?.id
  }

  private async resolveProjectId(name?: string): Promise<string | undefined> {
    if (!name) return undefined
    const [row] = await this.sql<{ id: string }[]>`
      SELECT id FROM linear_projects WHERE LOWER(name) = LOWER(${name}) LIMIT 1
    `
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
      provider: 'linear',
      capabilities: LINEAR_CAPABILITIES,
      team: (await this.cache.loadSyncMeta()).team,
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
      assigneeId: await this.resolveAssigneeId(input.assignee),
      projectId: await this.resolveProjectId(input.project),
      labelIds,
    })
    if (!result.success || !result.issue) {
      throw new KanbanError(ErrorCode.PROVIDER_UPSTREAM_ERROR, 'Linear issue creation failed')
    }
    const issue = result.issue
    await this.cache.upsertIssues([
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
        ? ((await this.resolveAssigneeId(input.assignee)) ?? null)
        : null
    if (input.project !== undefined)
      updateInput['projectId'] = input.project
        ? ((await this.resolveProjectId(input.project)) ?? null)
        : null
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

  async moveTask(idOrRef: string, column: string): Promise<Task> {
    await this.sync()
    const task = await this.resolveTask(idOrRef)
    const state = await this.resolveState(column)
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
    const task = await this.resolveTask(idOrRef)
    const comments = await this.client.listComments(task.providerId || task.id)
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
    const result = await this.client.commentCreate(task.providerId || task.id, body)
    if (!result.success || !result.comment) {
      throw new KanbanError(ErrorCode.PROVIDER_UPSTREAM_ERROR, 'Linear comment creation failed')
    }
    await this.cache.adjustIssueCommentCount(task.providerId || task.id, 1)
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
    const issueId = taskId ? await this.resolveIssueIdFromTaskId(taskId) : undefined
    const rows = await this.cache.getCachedActivity({
      ...(issueId !== undefined ? { issueId } : {}),
      limit: limit ?? 100,
    })
    return rows.map((row) => this.activityRowToEntry(row))
  }

  private async resolveIssueIdFromTaskId(taskId: string): Promise<string | undefined> {
    const normalized = taskId.startsWith('linear:') ? taskId.slice('linear:'.length) : taskId
    const [row] = await this.sql<{ id: string }[]>`
      SELECT id FROM linear_issues WHERE id = ${normalized} OR identifier = ${normalized} LIMIT 1
    `
    return row?.id
  }

  private activityRowToEntry(row: LinearActivityRow): ActivityEntry {
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
    const meta = extractWebhookMeta('linear', payload.rawBody)
    let result: WebhookResult
    try {
      result = await this.handleWebhookInner(payload)
    } catch (err) {
      void recordWebhookEvent(this.sql, {
        provider: 'linear',
        ...meta,
        status: 'error',
        detail: { error: err instanceof Error ? err.message : String(err) },
      })
      throw err
    }
    void recordWebhookEvent(this.sql, {
      provider: 'linear',
      ...meta,
      status: webhookEventStatus(result),
    })
    return result
  }

  private async handleWebhookInner(payload: WebhookRequest): Promise<WebhookResult> {
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
          labels: (data.labels ?? []).map((label) => label.name),
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
