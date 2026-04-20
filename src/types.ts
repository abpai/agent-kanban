export type Priority = 'low' | 'medium' | 'high' | 'urgent'

export interface Column {
  id: string
  name: string
  position: number
  color: string | null
  created_at: string
  updated_at: string
}

export interface Task {
  id: string
  providerId?: string
  externalRef?: string | null
  url?: string | null
  title: string
  description: string
  column_id: string
  position: number
  priority: Priority
  assignee: string
  assignees: string[]
  labels: string[]
  comment_count: number
  project: string
  metadata: string
  revision?: number
  created_at: string
  updated_at: string
  version: string | null
  source_updated_at: string | null
}

export interface TaskComment {
  id: string
  task_id: string
  body: string
  author: string | null
  created_at: string
  updated_at: string
}

export interface TaskWithColumn extends Task {
  column_name: string
}

export interface BoardView {
  columns: (Column & { tasks: Task[] })[]
}

export interface CliResult<T = unknown> {
  ok: true
  data: T
}

export interface CliError {
  ok: false
  error: { code: string; message: string }
}

export type CliOutput<T = unknown> = CliResult<T> | CliError

export type ActivityAction =
  | 'created'
  | 'moved'
  | 'updated'
  | 'deleted'
  | 'assigned'
  | 'prioritized'

export interface ActivityEntry {
  id: string
  task_id: string
  action: ActivityAction
  field_changed: string | null
  old_value: string | null
  new_value: string | null
  timestamp: string
}

export interface ColumnTimeEntry {
  id: string
  task_id: string
  column_id: string
  entered_at: string
  exited_at: string | null
}

export interface BoardConfig {
  members: { name: string; role: 'human' | 'agent' }[]
  projects: string[]
  provider?: 'local' | 'linear' | 'jira'
  discoveredAssignees?: string[]
  discoveredProjects?: string[]
}

export interface BoardMetrics {
  tasksByColumn: { column_name: string; count: number }[]
  tasksByPriority: { priority: string; count: number }[]
  totalTasks: number
  completedTasks: number
  avgCompletionHours: number | null
  recentActivity: ActivityEntry[]
  tasksCreatedThisWeek: number
  inProgressCount: number
  completionPercent: number
  assignees: string[]
  projects: string[]
}

export interface ProviderCapabilities {
  taskCreate: boolean
  taskUpdate: boolean
  taskMove: boolean
  taskDelete: boolean
  comment: boolean
  activity: boolean
  metrics: boolean
  columnCrud: boolean
  bulk: boolean
  configEdit: boolean
}

export interface ProviderTeamInfo {
  id: string
  key: string
  name: string
}

export interface BoardBootstrap {
  provider: 'local' | 'linear' | 'jira'
  capabilities: ProviderCapabilities
  board: BoardView
  config: BoardConfig
  metrics: BoardMetrics | null
  activity: ActivityEntry[]
  team: ProviderTeamInfo | null
}
