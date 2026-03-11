import type {
  ActivityEntry,
  BoardBootstrap,
  BoardConfig,
  BoardMetrics,
  BoardView,
  Column,
  Priority,
  ProviderCapabilities,
  ProviderTeamInfo,
  Task,
} from '../types.ts'

export interface TaskListFilters {
  column?: string
  priority?: string
  assignee?: string
  project?: string
  limit?: number
  sort?: string
}

export interface CreateTaskInput {
  title: string
  description?: string
  column?: string
  priority?: Priority
  assignee?: string
  project?: string
  metadata?: string
}

export interface UpdateTaskInput {
  title?: string
  description?: string
  priority?: Priority
  assignee?: string
  project?: string
  metadata?: string
}

export interface ProviderContext {
  provider: 'local' | 'linear'
  capabilities: ProviderCapabilities
  team: ProviderTeamInfo | null
}

export interface KanbanProvider {
  readonly type: 'local' | 'linear'

  getContext(): Promise<ProviderContext>
  getBootstrap(): Promise<BoardBootstrap>
  getBoard(): Promise<BoardView>
  listColumns(): Promise<Column[]>
  listTasks(filters?: TaskListFilters): Promise<Task[]>
  getTask(idOrRef: string): Promise<Task>
  createTask(input: CreateTaskInput): Promise<Task>
  updateTask(idOrRef: string, input: UpdateTaskInput): Promise<Task>
  moveTask(idOrRef: string, column: string): Promise<Task>
  deleteTask(idOrRef: string): Promise<Task>
  getActivity(limit?: number, taskId?: string): Promise<ActivityEntry[]>
  getMetrics(): Promise<BoardMetrics>
  getConfig(): Promise<BoardConfig>
  patchConfig(input: Partial<BoardConfig>): Promise<BoardConfig>
}
