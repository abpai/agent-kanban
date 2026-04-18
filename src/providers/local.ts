import type { Database } from 'bun:sqlite'
import { listActivity, logActivity } from '../activity.ts'
import { getConfigPath, loadConfig, saveConfig } from '../config.ts'
import {
  addTask,
  deleteTask,
  getBoardView,
  getDbPath,
  getTask,
  listColumns,
  listTasks,
  moveTask,
  updateTask,
} from '../db.ts'
import { getBoardMetrics, getDiscoveredAssignees, getDiscoveredProjects } from '../metrics.ts'
import type { BoardBootstrap, BoardConfig, Task } from '../types.ts'
import { ErrorCode, KanbanError } from '../errors.ts'
import { LOCAL_CAPABILITIES } from './capabilities.ts'
import type {
  CreateTaskInput,
  KanbanProvider,
  ProviderContext,
  TaskListFilters,
  UpdateTaskInput,
} from './types.ts'

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

function enrichTask(task: Task): Task {
  const revision = task.revision ?? 0
  const assignees = task.assignee ? [task.assignee] : []
  return {
    ...task,
    providerId: task.id,
    externalRef: task.id,
    url: null,
    assignees,
    labels: [],
    comment_count: 0,
    version: String(revision),
    source_updated_at: null,
  }
}

export class LocalProvider implements KanbanProvider {
  readonly type = 'local' as const

  constructor(
    private readonly db: Database,
    private readonly dbPath = getDbPath(),
  ) {}

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
    return {
      columns: board.columns.map((column) => ({
        ...column,
        tasks: column.tasks.map(enrichTask),
      })),
    }
  }

  async listColumns() {
    return listColumns(this.db)
  }

  async listTasks(filters: TaskListFilters = {}) {
    return listTasks(this.db, filters).map(enrichTask)
  }

  async getTask(idOrRef: string) {
    return enrichTask(getTask(this.db, idOrRef))
  }

  async createTask(input: CreateTaskInput) {
    return enrichTask(addTask(this.db, input.title, input))
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
    return enrichTask(updateTask(this.db, idOrRef, updates))
  }

  async moveTask(idOrRef: string, column: string) {
    return enrichTask(moveTask(this.db, idOrRef, column))
  }

  async deleteTask(idOrRef: string) {
    return enrichTask(deleteTask(this.db, idOrRef))
  }

  async comment(idOrRef: string, body: string): Promise<void> {
    const task = getTask(this.db, idOrRef)
    logActivity(this.db, task.id, 'updated', {
      field: 'comment',
      new_value: body,
    })
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
}
