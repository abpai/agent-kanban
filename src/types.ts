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
