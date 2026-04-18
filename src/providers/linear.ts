import type { Database } from 'bun:sqlite'
import { ErrorCode, KanbanError } from '../errors.ts'
import type {
  ActivityEntry,
  BoardBootstrap,
  BoardConfig,
  BoardMetrics,
  Column,
  Task,
} from '../types.ts'
import {
  headerLower,
  verifyHmacSha256,
  type WebhookRequest,
  type WebhookResult,
} from '../webhooks.ts'
import { LINEAR_CAPABILITIES } from './capabilities.ts'
import {
  deleteLinearIssue,
  getCachedBoard,
  getCachedColumns,
  getCachedConfig,
  getCachedTask,
  getCachedTasks,
  initLinearCacheSchema,
  loadSyncMeta,
  replaceStates,
  saveSyncMeta,
  upsertIssues,
  upsertProjects,
  upsertUsers,
} from './linear-cache.ts'
import { LinearClient } from './linear-client.ts'
import { unsupportedOperation } from './errors.ts'
import type {
  CreateTaskInput,
  KanbanProvider,
  ProviderContext,
  TaskListFilters,
  UpdateTaskInput,
} from './types.ts'

const SYNC_INTERVAL_MS = 30_000

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

  private async sync(force = false): Promise<void> {
    const meta = loadSyncMeta(this.db)
    const lastSyncAtMs = meta.lastSyncAt ? Date.parse(meta.lastSyncAt) : 0
    if (!force && lastSyncAtMs && Date.now() - lastSyncAtMs < SYNC_INTERVAL_MS) return

    const [team, users, projects, issues] = await Promise.all([
      this.client.getTeam(this.teamId),
      this.client.listUsers(),
      this.client.listProjects(),
      this.client.listIssues(
        this.teamId,
        force ? undefined : (meta.lastIssueUpdatedAt ?? undefined),
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
        commentCount: issue.commentCount ?? 0,
        url: issue.url ?? null,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
      })),
    )

    const newestIssueTimestamp =
      issues.length > 0
        ? issues.reduce(
            (latest, issue) => (issue.updatedAt > latest ? issue.updatedAt : latest),
            issues[0]!.updatedAt,
          )
        : meta.lastIssueUpdatedAt

    saveSyncMeta(this.db, {
      team: { id: team.id, key: team.key, name: team.name },
      lastSyncAt: new Date().toISOString(),
      lastIssueUpdatedAt: newestIssueTimestamp ?? new Date().toISOString(),
    })
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
      teamId: this.teamId,
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
        commentCount: issue.commentCount ?? 0,
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

  async getActivity(_limit?: number, _taskId?: string): Promise<ActivityEntry[]> {
    unsupportedOperation('Activity is not available in Linear mode')
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
        identifier: string
        title: string
        description?: string | null
        priority?: number | null
        url?: string | null
        createdAt: string
        updatedAt: string
        assignee?: { id: string; name?: string | null } | null
        assigneeId?: string | null
        project?: { id: string; name: string } | null
        projectId?: string | null
        state?: { id: string; name: string; position?: number } | null
        stateId?: string | null
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
      saveSyncMeta(this.db, {
        team: null,
        lastSyncAt: new Date().toISOString(),
        lastIssueUpdatedAt: null,
      })
      return { handled: true }
    }

    if (body.action === 'create' || body.action === 'update') {
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
          commentCount: data.commentCount ?? 0,
          url: data.url ?? null,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
        },
      ])
      return { handled: true }
    }

    return { handled: false, message: `Unsupported action: ${body.action}` }
  }
}
