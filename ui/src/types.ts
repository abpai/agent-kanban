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
  title: string
  description: string
  column_id: string
  position: number
  priority: Priority
  assignee: string
  project: string
  metadata: string
  created_at: string
  updated_at: string
}

export interface BoardView {
  columns: (Column & { tasks: Task[] })[]
}

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

export interface BoardConfig {
  members: { name: string; role: 'human' | 'agent' }[]
  projects: string[]
}
