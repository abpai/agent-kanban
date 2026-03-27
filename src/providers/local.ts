import type { Database } from 'bun:sqlite'
import { listActivity } from '../activity.ts'
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
  return {
    ...task,
    providerId: task.id,
    externalRef: task.id,
    url: null,
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
    return enrichTask(updateTask(this.db, idOrRef, input))
  }

  async moveTask(idOrRef: string, column: string) {
    return enrichTask(moveTask(this.db, idOrRef, column))
  }

  async deleteTask(idOrRef: string) {
    return enrichTask(deleteTask(this.db, idOrRef))
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
