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
  /**
   * Hash of the description exactly as the provider stores it (Jira: the raw
   * ADF JSON), as `sha256:<hex>`. It changes only when the stored description
   * changes, never when the markdown converter changes. `null` when there is no
   * description; absent for providers whose description is the markdown itself.
   */
  description_hash?: string | null
  /** Present only on a fresh read (`getTask(id, { fresh: true })`) from Jira. */
  fresh_read?: FreshTaskRead
}

/** A warning about content the markdown description cannot show as-is. */
export interface DescriptionWarning {
  code: string
  node_type: string
  /** JSON path into the provider's stored description, e.g. `content[2].content[0]`. */
  path: string
  message: string
}

export interface FreshTaskAttachment extends TaskAttachment {
  /** `sha256:<hex>` of the attachment's metadata. Jira attachments never change in place. */
  digest: string
}

/** What a fresh read observed, beyond the task itself. */
export interface FreshTaskRead {
  read_at: string
  converter_version: string
  /** True when the markdown parses back to the same stored document. */
  description_lossless: boolean
  description_warnings: DescriptionWarning[]
  attachments: FreshTaskAttachment[]
  /** `sha256:<hex>` over the attachment digests, sorted by attachment id. */
  attachments_digest: string
}

export interface TaskComment {
  id: string
  task_id: string
  body: string
  author: string | null
  created_at: string
  updated_at: string
}

/** A file stored on a task by the provider. Metadata only; bytes come from `readAttachment`. */
export interface TaskAttachment {
  id: string
  task_id: string
  /** The provider's filename, unchanged. Consumers decide how to display it. */
  filename: string
  /** Provider-reported; may be `application/octet-stream`. */
  media_type: string
  byte_size: number
  author: string | null
  created_at: string
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
  /** True when provider-backed bootstrap/dashboard activity is exposed, not merely cached internally. */
  activity: boolean
  metrics: boolean
  columnCrud: boolean
  bulk: boolean
  configEdit: boolean
  /**
   * True when `UpdateTaskInput.labels` is honored as exact replacement
   * (present → set to that array including `[]`; absent → untouched).
   */
  labelReplacement: boolean
  /** True when `listAttachments` and `readAttachment` read task files from the provider. */
  attachments: boolean
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
