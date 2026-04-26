import type { Database } from 'bun:sqlite'
import { listActivity } from '../activity'
import { getConfigPath, loadConfig, saveConfig } from '../config'
import {
  addComment,
  countComments,
  countCommentsByTask,
  addTask,
  deleteTask,
  getBoardView,
  getComment as getTaskComment,
  getDbPath,
  getTask,
  listComments as listTaskComments,
  listColumns,
  listTasks,
  moveTask,
  updateComment as updateTaskComment,
  updateTask,
} from '../db'
import { getBoardMetrics, getDiscoveredAssignees, getDiscoveredProjects } from '../metrics'
import type { BoardBootstrap, BoardConfig, Task, TaskComment } from '../types'
import { ErrorCode, KanbanError } from '../errors'
import { LOCAL_CAPABILITIES } from './capabilities'
import type {
  CreateTaskInput,
  KanbanProvider,
  ProviderContext,
  ProviderSyncStatus,
  TaskListFilters,
  UpdateTaskInput,
} from './types'

function buildLocalConfig(
  db: Database,
  dbPath: string,
  discoveredAssignees = getDiscoveredAssignees(db),
  discoveredProjects = getDiscoveredProjects(db),
): BoardConfig {
  return {
    ...loadConfig(dbPath),
    provider: 'local',
    discoveredAssignees,
    discoveredProjects,
  }
}

export class LocalProvider implements KanbanProvider {
  readonly type = 'local' as const

  constructor(
    private readonly db: Database,
    private readonly dbPath = getDbPath(),
  ) {}

  private enrichTask(task: Task, commentCount?: number): Task {
    const revision = task.revision ?? 0
    const assignees = task.assignee ? [task.assignee] : []
    return {
      ...task,
      providerId: task.id,
      externalRef: task.id,
      url: null,
      assignees,
      labels: [],
      comment_count: commentCount ?? countComments(this.db, task.id),
      version: String(revision),
      source_updated_at: null,
    }
  }

  async getContext(): Promise<ProviderContext> {
    return {
      provider: this.type,
      capabilities: LOCAL_CAPABILITIES,
      team: null,
    }
  }

  async getBootstrap(): Promise<BoardBootstrap> {
    const metrics = getBoardMetrics(this.db)
    return {
      provider: this.type,
      capabilities: LOCAL_CAPABILITIES,
      board: await this.getBoard(),
      config: buildLocalConfig(this.db, this.dbPath, metrics.assignees, metrics.projects),
      metrics,
      activity: listActivity(this.db, { limit: 50 }),
      team: null,
    }
  }

  async getBoard() {
    const board = getBoardView(this.db)
    const counts = countCommentsByTask(this.db)
    return {
      columns: board.columns.map((column) => ({
        ...column,
        tasks: column.tasks.map((task) => this.enrichTask(task, counts.get(task.id) ?? 0)),
      })),
    }
  }

  async listColumns() {
    return listColumns(this.db)
  }

  async listTasks(filters: TaskListFilters = {}) {
    const counts = countCommentsByTask(this.db)
    return listTasks(this.db, filters).map((task) =>
      this.enrichTask(task, counts.get(task.id) ?? 0),
    )
  }

  async getTask(idOrRef: string) {
    return this.enrichTask(getTask(this.db, idOrRef))
  }

  async createTask(input: CreateTaskInput) {
    return this.enrichTask(addTask(this.db, input.title, input))
  }

  async updateTask(idOrRef: string, input: UpdateTaskInput) {
    if (input.expectedVersion !== undefined) {
      const current = getTask(this.db, idOrRef)
      const currentVersion = String(current.revision ?? 0)
      if (currentVersion !== input.expectedVersion) {
        throw new KanbanError(
          ErrorCode.CONFLICT,
          `Task ${idOrRef} was modified since you loaded it (expected version ${input.expectedVersion}, current ${currentVersion})`,
        )
      }
    }
    const updates: Omit<UpdateTaskInput, 'expectedVersion'> = { ...input }
    delete (updates as UpdateTaskInput).expectedVersion
    return this.enrichTask(updateTask(this.db, idOrRef, updates))
  }

  async moveTask(idOrRef: string, column: string) {
    return this.enrichTask(moveTask(this.db, idOrRef, column))
  }

  async deleteTask(idOrRef: string) {
    return this.enrichTask(deleteTask(this.db, idOrRef))
  }

  async listComments(idOrRef: string): Promise<TaskComment[]> {
    return listTaskComments(this.db, idOrRef)
  }

  async getComment(idOrRef: string, commentId: string): Promise<TaskComment> {
    return getTaskComment(this.db, idOrRef, commentId)
  }

  async comment(idOrRef: string, body: string): Promise<TaskComment> {
    return addComment(this.db, idOrRef, body)
  }

  async updateComment(idOrRef: string, commentId: string, body: string): Promise<TaskComment> {
    return updateTaskComment(this.db, idOrRef, commentId, body)
  }

  async getActivity(limit?: number, taskId?: string) {
    return listActivity(this.db, { limit, taskId })
  }

  async getMetrics() {
    return getBoardMetrics(this.db)
  }

  async getConfig(): Promise<BoardConfig> {
    return buildLocalConfig(this.db, this.dbPath)
  }

  async patchConfig(input: Partial<BoardConfig>) {
    const config = loadConfig(this.dbPath)
    if (input.members) config.members = input.members
    if (input.projects) config.projects = input.projects
    saveConfig(getConfigPath(this.dbPath), config)
    return this.getConfig()
  }

  async getSyncStatus(): Promise<ProviderSyncStatus | null> {
    return null
  }
}
