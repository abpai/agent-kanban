import { ErrorCode, KanbanError } from '../errors'
import type {
  ActivityEntry,
  BoardBootstrap,
  BoardConfig,
  BoardMetrics,
  BoardView,
  Column,
  ProviderCapabilities,
  Task,
  TaskComment,
} from '../types'
import type {
  CreateTaskInput,
  KanbanProvider,
  ProviderContext,
  ProviderSyncStatus,
  TaskListFilters,
  UpdateTaskInput,
} from './types'

type Awaitable<T> = T | Promise<T>

export type LocalTaskRecord = Task & {
  column_name?: string
}

export interface LocalStorePort {
  readonly capabilities: ProviderCapabilities
  initialize?(): Promise<void>
  getBoard(): Awaitable<BoardView>
  listColumns(): Awaitable<Column[]>
  listTasks(filters?: TaskListFilters): Awaitable<LocalTaskRecord[]>
  getTask(idOrRef: string): Awaitable<LocalTaskRecord>
  getTaskVersion(idOrRef: string): Awaitable<string>
  createTask(input: CreateTaskInput): Awaitable<LocalTaskRecord>
  updateTask(
    idOrRef: string,
    input: Omit<UpdateTaskInput, 'expectedVersion'>,
  ): Awaitable<LocalTaskRecord>
  moveTask(idOrRef: string, column: string): Awaitable<LocalTaskRecord>
  deleteTask(idOrRef: string): Awaitable<LocalTaskRecord>
  listComments(idOrRef: string): Awaitable<TaskComment[]>
  getComment(idOrRef: string, commentId: string): Awaitable<TaskComment>
  comment(idOrRef: string, body: string): Awaitable<TaskComment>
  updateComment(idOrRef: string, commentId: string, body: string): Awaitable<TaskComment>
  getActivity(limit?: number, taskId?: string): Awaitable<ActivityEntry[]>
  getMetrics(): Awaitable<BoardMetrics>
  getConfig(context?: { metrics?: BoardMetrics }): Awaitable<BoardConfig>
  patchConfig(input: Partial<BoardConfig>): Awaitable<BoardConfig>
  countComments?(taskId: string): Awaitable<number>
  countCommentsByTask?(): Awaitable<Map<string, number>>
}

function taskHasCommentCount(task: Task): boolean {
  return typeof task.comment_count === 'number' && Number.isFinite(task.comment_count)
}

export class LocalProviderCore implements KanbanProvider {
  readonly type = 'local' as const

  constructor(private readonly store: LocalStorePort) {}

  async initialize(): Promise<void> {
    await this.store.initialize?.()
  }

  private enrichTask(task: LocalTaskRecord, commentCount?: number): LocalTaskRecord {
    const revision = task.revision ?? 0
    const assignees = task.assignees?.length ? task.assignees : task.assignee ? [task.assignee] : []
    const labels = Array.isArray(task.labels) ? task.labels : []
    return {
      ...task,
      providerId: task.providerId ?? task.id,
      externalRef: task.externalRef ?? task.id,
      url: task.url ?? null,
      assignees,
      labels,
      comment_count: commentCount ?? task.comment_count ?? 0,
      version: task.version ?? String(revision),
      source_updated_at: task.source_updated_at ?? null,
    }
  }

  private async commentCount(task: Task): Promise<number | undefined> {
    if (taskHasCommentCount(task)) return task.comment_count
    return this.store.countComments?.(task.id)
  }

  private async commentCountsFor(tasks: Task[]): Promise<Map<string, number> | undefined> {
    if (tasks.every(taskHasCommentCount)) return undefined
    return this.store.countCommentsByTask?.()
  }

  private async enrichTaskWithCount(task: LocalTaskRecord): Promise<LocalTaskRecord> {
    return this.enrichTask(task, await this.commentCount(task))
  }

  async getContext(): Promise<ProviderContext> {
    await this.initialize()
    return {
      provider: this.type,
      capabilities: this.store.capabilities,
      team: null,
    }
  }

  async getBootstrap(): Promise<BoardBootstrap> {
    await this.initialize()
    const metrics = await this.getMetrics()
    return {
      provider: this.type,
      capabilities: this.store.capabilities,
      board: await this.getBoard(),
      config: await this.store.getConfig({ metrics }),
      metrics,
      activity: await this.getActivity(50),
      team: null,
    }
  }

  async getBoard(): Promise<BoardView> {
    await this.initialize()
    const board = await this.store.getBoard()
    const tasks = board.columns.flatMap((column) => column.tasks)
    const counts = await this.commentCountsFor(tasks)
    return {
      columns: board.columns.map((column) => ({
        ...column,
        tasks: column.tasks.map((task) => this.enrichTask(task, counts?.get(task.id))),
      })),
    }
  }

  async listColumns(): Promise<Column[]> {
    await this.initialize()
    return this.store.listColumns()
  }

  async listTasks(filters: TaskListFilters = {}): Promise<Task[]> {
    await this.initialize()
    const tasks = await this.store.listTasks(filters)
    const counts = await this.commentCountsFor(tasks)
    return tasks.map((task) => this.enrichTask(task, counts?.get(task.id)))
  }

  async getTask(idOrRef: string): Promise<Task> {
    await this.initialize()
    return this.enrichTaskWithCount(await this.store.getTask(idOrRef))
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    await this.initialize()
    return this.enrichTaskWithCount(await this.store.createTask(input))
  }

  async updateTask(idOrRef: string, input: UpdateTaskInput): Promise<Task> {
    await this.initialize()
    if (input.expectedVersion !== undefined) {
      const currentVersion = await this.store.getTaskVersion(idOrRef)
      if (currentVersion !== input.expectedVersion) {
        throw new KanbanError(
          ErrorCode.CONFLICT,
          `Task ${idOrRef} was modified since you loaded it (expected version ${input.expectedVersion}, current ${currentVersion})`,
        )
      }
    }
    const updates: Omit<UpdateTaskInput, 'expectedVersion'> = { ...input }
    delete (updates as UpdateTaskInput).expectedVersion
    return this.enrichTaskWithCount(await this.store.updateTask(idOrRef, updates))
  }

  async moveTask(idOrRef: string, column: string): Promise<Task> {
    await this.initialize()
    return this.enrichTaskWithCount(await this.store.moveTask(idOrRef, column))
  }

  async deleteTask(idOrRef: string): Promise<Task> {
    await this.initialize()
    return this.enrichTaskWithCount(await this.store.deleteTask(idOrRef))
  }

  async listComments(idOrRef: string): Promise<TaskComment[]> {
    await this.initialize()
    return this.store.listComments(idOrRef)
  }

  async getComment(idOrRef: string, commentId: string): Promise<TaskComment> {
    await this.initialize()
    return this.store.getComment(idOrRef, commentId)
  }

  async comment(idOrRef: string, body: string): Promise<TaskComment> {
    await this.initialize()
    return this.store.comment(idOrRef, body)
  }

  async updateComment(idOrRef: string, commentId: string, body: string): Promise<TaskComment> {
    await this.initialize()
    return this.store.updateComment(idOrRef, commentId, body)
  }

  async getActivity(limit?: number, taskId?: string): Promise<ActivityEntry[]> {
    await this.initialize()
    return this.store.getActivity(limit, taskId)
  }

  async getMetrics(): Promise<BoardMetrics> {
    await this.initialize()
    return this.store.getMetrics()
  }

  async getConfig(): Promise<BoardConfig> {
    await this.initialize()
    return this.store.getConfig()
  }

  async patchConfig(input: Partial<BoardConfig>): Promise<BoardConfig> {
    await this.initialize()
    return this.store.patchConfig(input)
  }

  async getSyncStatus(): Promise<ProviderSyncStatus | null> {
    return null
  }
}
