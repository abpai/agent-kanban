import { normalizeLabels } from './labels'
import type {
  CreateTaskInput,
  KanbanProvider,
  ProviderContext,
  TaskListFilters,
  UpdateTaskInput,
} from './providers/types'
import type {
  ActivityEntry,
  BoardBootstrap,
  BoardConfig,
  BoardMetrics,
  BoardView,
  Column,
  Task,
  TaskComment,
} from './types'

/**
 * Typed use-case layer shared by every transport (CLI, HTTP, MCP).
 *
 * Each function is the single, typed seam between a transport and the
 * provider: transports own their own concerns — argument parsing and
 * transport-specific error messages, HTTP routing and WebSocket events, MCP
 * authorization policy and hooks — then delegate the actual provider call
 * here. Keeping that call in one place means cross-cutting concerns (label
 * normalization today; future auditing/validation) have a single insertion
 * point instead of being re-derived in three transports.
 *
 * These functions intentionally do NOT perform required-argument validation:
 * the transports raise their own (differently worded) errors before calling
 * in, so the contract each surface already advertises is preserved.
 */

/**
 * Create-task input as a transport supplies it. Identical to CreateTaskInput
 * except `labels` is accepted in any raw form (CLI flag arrays, a JSON array,
 * a comma-separated string) and normalized here so no transport re-implements
 * the normalization.
 */
export type CreateTaskCommand = Omit<CreateTaskInput, 'labels'> & { labels?: unknown }

export function createTask(provider: KanbanProvider, input: CreateTaskCommand): Promise<Task> {
  const { labels, ...rest } = input
  return provider.createTask({ ...rest, labels: normalizeLabels(labels) })
}

export function listTasks(provider: KanbanProvider, filters?: TaskListFilters): Promise<Task[]> {
  return provider.listTasks(filters)
}

export function getTask(provider: KanbanProvider, idOrRef: string): Promise<Task> {
  return provider.getTask(idOrRef)
}

export function updateTask(
  provider: KanbanProvider,
  idOrRef: string,
  input: UpdateTaskInput,
): Promise<Task> {
  return provider.updateTask(idOrRef, input)
}

export function moveTask(provider: KanbanProvider, idOrRef: string, column: string): Promise<Task> {
  return provider.moveTask(idOrRef, column)
}

export function deleteTask(provider: KanbanProvider, idOrRef: string): Promise<Task> {
  return provider.deleteTask(idOrRef)
}

export function listComments(provider: KanbanProvider, idOrRef: string): Promise<TaskComment[]> {
  return provider.listComments(idOrRef)
}

export function getComment(
  provider: KanbanProvider,
  idOrRef: string,
  commentId: string,
): Promise<TaskComment> {
  return provider.getComment(idOrRef, commentId)
}

export function addComment(
  provider: KanbanProvider,
  idOrRef: string,
  body: string,
): Promise<TaskComment> {
  return provider.comment(idOrRef, body)
}

export function updateComment(
  provider: KanbanProvider,
  idOrRef: string,
  commentId: string,
  body: string,
): Promise<TaskComment> {
  return provider.updateComment(idOrRef, commentId, body)
}

export function getBoard(provider: KanbanProvider): Promise<BoardView> {
  return provider.getBoard()
}

export function getBootstrap(provider: KanbanProvider): Promise<BoardBootstrap> {
  return provider.getBootstrap()
}

export function getContext(provider: KanbanProvider): Promise<ProviderContext> {
  return provider.getContext()
}

export function listColumns(provider: KanbanProvider): Promise<Column[]> {
  return provider.listColumns()
}

export function getActivity(
  provider: KanbanProvider,
  limit?: number,
  taskId?: string,
): Promise<ActivityEntry[]> {
  return provider.getActivity(limit, taskId)
}

export function getMetrics(provider: KanbanProvider): Promise<BoardMetrics> {
  return provider.getMetrics()
}

export function getConfig(provider: KanbanProvider): Promise<BoardConfig> {
  return provider.getConfig()
}

export function patchConfig(
  provider: KanbanProvider,
  input: Partial<BoardConfig>,
): Promise<BoardConfig> {
  return provider.patchConfig(input)
}
