import { normalizeLabels } from './labels'
import type { CreateTaskInput } from './providers/types'

/**
 * Create-task input as a transport supplies it. It accepts `labels` in raw
 * transport forms (CLI flag arrays, JSON arrays, comma-separated strings), then
 * normalizes them before the provider call. Other provider operations are direct
 * enough for transports to call the provider without a use-case wrapper.
 */
export type CreateTaskCommand = Omit<CreateTaskInput, 'labels'> & { labels?: unknown }

export function normalizeCreateTaskInput(input: CreateTaskCommand): CreateTaskInput {
  const { labels, ...rest } = input
  return { ...rest, labels: normalizeLabels(labels) }
}
