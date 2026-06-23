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
  getTask,
  listComments as listTaskComments,
  listColumns,
  listTasks,
  moveTask,
  updateComment as updateTaskComment,
  updateTask,
} from '../db'
import { getBoardMetrics, getDiscoveredAssignees, getDiscoveredProjects } from '../metrics'
import type { BoardConfig, BoardMetrics, TaskComment } from '../types'
import { LOCAL_CAPABILITIES } from './capabilities'
import type { CreateTaskInput, TaskListFilters, UpdateTaskInput } from './types'
import type { LocalStorePort } from './local-core'

export class SqliteLocalStore implements LocalStorePort {
  readonly capabilities = LOCAL_CAPABILITIES

  constructor(
    private readonly db: Database,
    private readonly dbPath: string,
    private readonly defaultTaskColumn?: string,
  ) {}

  getBoard() {
    return getBoardView(this.db)
  }

  listColumns() {
    return listColumns(this.db)
  }

  listTasks(filters: TaskListFilters = {}) {
    return listTasks(this.db, filters)
  }

  getTask(idOrRef: string) {
    return getTask(this.db, idOrRef)
  }

  getTaskVersion(idOrRef: string): string {
    return String(getTask(this.db, idOrRef).revision ?? 0)
  }

  createTask(input: CreateTaskInput) {
    return addTask(this.db, input.title, {
      ...input,
      column: input.column ?? this.defaultTaskColumn,
    })
  }

  updateTask(idOrRef: string, input: Omit<UpdateTaskInput, 'expectedVersion'>) {
    return updateTask(this.db, idOrRef, input)
  }

  moveTask(idOrRef: string, column: string) {
    return moveTask(this.db, idOrRef, column)
  }

  deleteTask(idOrRef: string) {
    return deleteTask(this.db, idOrRef)
  }

  listComments(idOrRef: string): TaskComment[] {
    return listTaskComments(this.db, idOrRef)
  }

  getComment(idOrRef: string, commentId: string): TaskComment {
    return getTaskComment(this.db, idOrRef, commentId)
  }

  comment(idOrRef: string, body: string): TaskComment {
    return addComment(this.db, idOrRef, body)
  }

  updateComment(idOrRef: string, commentId: string, body: string): TaskComment {
    return updateTaskComment(this.db, idOrRef, commentId, body)
  }

  getActivity(limit?: number, taskId?: string) {
    return listActivity(this.db, { limit, taskId })
  }

  getMetrics() {
    return getBoardMetrics(this.db)
  }

  getConfig(context: { metrics?: BoardMetrics } = {}): BoardConfig {
    const discoveredAssignees = context.metrics?.assignees ?? getDiscoveredAssignees(this.db)
    const discoveredProjects = context.metrics?.projects ?? getDiscoveredProjects(this.db)
    return {
      ...loadConfig(this.dbPath),
      provider: 'local',
      discoveredAssignees,
      discoveredProjects,
    }
  }

  patchConfig(input: Partial<BoardConfig>): BoardConfig {
    const config = loadConfig(this.dbPath)
    if (input.members) config.members = input.members
    if (input.projects) config.projects = input.projects
    saveConfig(getConfigPath(this.dbPath), config)
    return this.getConfig()
  }

  countComments(taskId: string): number {
    return countComments(this.db, taskId)
  }

  countCommentsByTask(): Map<string, number> {
    return countCommentsByTask(this.db)
  }
}
