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
  labels?: string[]
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

/**
 * The provider contract is composed from small, cohesive capability interfaces
 * rather than one monolithic type. `KanbanProvider` is their intersection, so
 * every existing consumer keeps the same surface; the split exists to document
 * which operations belong together and to let internal code depend on just the
 * capability it needs.
 *
 * Note on "unsupported" operations: providers that cannot perform a given
 * operation (e.g. Jira/Linear `deleteTask`, `getMetrics`, `patchConfig`) still
 * implement the method but throw `UNSUPPORTED_OPERATION` at runtime, and the
 * UI hides those affordances via `ProviderCapabilities`. These members are
 * therefore required on the contract — only the cache/webhook members below,
 * which a provider may genuinely not have, are optional.
 */

/** Provider self-identification. */
export interface ProviderIdentity {
  readonly type: 'local' | 'linear' | 'jira'
}

/** Board/context/config reads that materialize the current board view. */
export interface BoardReader {
  getContext(): Promise<ProviderContext>
  getBootstrap(): Promise<BoardBootstrap>
  getBoard(): Promise<BoardView>
  listColumns(): Promise<Column[]>
  getConfig(): Promise<BoardConfig>
}

/** Task reads. */
export interface TaskReader {
  listTasks(filters?: TaskListFilters): Promise<Task[]>
  getTask(idOrRef: string): Promise<Task>
}

/** Task mutations. */
export interface TaskWriter {
  createTask(input: CreateTaskInput): Promise<Task>
  updateTask(idOrRef: string, input: UpdateTaskInput): Promise<Task>
  moveTask(idOrRef: string, column: string): Promise<Task>
  deleteTask(idOrRef: string): Promise<Task>
}

/** Comment reads and writes. */
export interface CommentCapability {
  listComments(idOrRef: string): Promise<TaskComment[]>
  getComment(idOrRef: string, commentId: string): Promise<TaskComment>
  comment(idOrRef: string, body: string): Promise<TaskComment>
  updateComment(idOrRef: string, commentId: string, body: string): Promise<TaskComment>
}

/** Activity-feed reads. */
export interface ActivityReader {
  getActivity(limit?: number, taskId?: string): Promise<ActivityEntry[]>
}

/** Board-metrics reads. */
export interface MetricsReader {
  getMetrics(): Promise<BoardMetrics>
}

/** Board-config mutations. */
export interface ConfigWriter {
  patchConfig(input: Partial<BoardConfig>): Promise<BoardConfig>
}

/**
 * Optional cache-management hooks used by the server's background warmer. Only
 * providers backed by a cache (Linear/Jira) implement these; the local
 * provider omits them and the server guards every call.
 */
export interface CacheManaged {
  syncCache?(): Promise<void>
  // Signals that a background warmer owns cache refresh (server mode), so the
  // provider may serve reads from the warm cache without a blocking foreground sync.
  setBackgroundManaged?(managed: boolean): void
  getSyncStatus?(): Promise<ProviderSyncStatus | null>
}

/** Optional inbound-webhook handling (Linear/Jira only). */
export interface WebhookReceiver {
  handleWebhook?(payload: WebhookRequest): Promise<WebhookResult>
}

export type KanbanProvider = ProviderIdentity &
  BoardReader &
  TaskReader &
  TaskWriter &
  CommentCapability &
  ActivityReader &
  MetricsReader &
  ConfigWriter &
  CacheManaged &
  WebhookReceiver
