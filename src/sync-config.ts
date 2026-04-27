import { ErrorCode, KanbanError } from './errors'

export const DEFAULT_POLLING_SYNC_INTERVAL_MS = 30_000
export const MIN_POLLING_SYNC_INTERVAL_MS = 1_000

export function resolvePollingSyncIntervalMs(raw = process.env['KANBAN_SYNC_INTERVAL_MS']): number {
  const value = raw?.trim()
  if (!value) return DEFAULT_POLLING_SYNC_INTERVAL_MS

  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < MIN_POLLING_SYNC_INTERVAL_MS) {
    throw new KanbanError(
      ErrorCode.INVALID_CONFIG,
      `KANBAN_SYNC_INTERVAL_MS must be an integer >= ${MIN_POLLING_SYNC_INTERVAL_MS}`,
    )
  }
  return parsed
}
