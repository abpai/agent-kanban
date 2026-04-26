import type { WebhookRequest, WebhookResult } from '../webhooks'
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
  TaskComment,
  Task,
} from '../types'

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
  expectedVersion?: string
}

export interface ProviderContext {
  provider: 'local' | 'linear' | 'jira'
  capabilities: ProviderCapabilities
  team: ProviderTeamInfo | null
}

export interface ProviderSyncStatus {
  lastSyncAt: string | null
  lastFullSyncAt: string | null
  lastWebhookAt: string | null
}

export interface KanbanProvider {
  readonly type: 'local' | 'linear' | 'jira'

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
  listComments(idOrRef: string): Promise<TaskComment[]>
  getComment(idOrRef: string, commentId: string): Promise<TaskComment>
  comment(idOrRef: string, body: string): Promise<TaskComment>
  updateComment(idOrRef: string, commentId: string, body: string): Promise<TaskComment>
  getActivity(limit?: number, taskId?: string): Promise<ActivityEntry[]>
  getMetrics(): Promise<BoardMetrics>
  getConfig(): Promise<BoardConfig>
  patchConfig(input: Partial<BoardConfig>): Promise<BoardConfig>
  syncCache?(): Promise<void>
  getSyncStatus?(): Promise<ProviderSyncStatus | null>
  handleWebhook?(payload: WebhookRequest): Promise<WebhookResult>
}
