import { ErrorCode, KanbanError } from './errors'

export const DEFAULT_POLLING_SYNC_INTERVAL_MS = 30_000
export const MIN_POLLING_SYNC_INTERVAL_MS = 1_000

export function resolvePollingSyncIntervalMs(
  raw = process.env['KANBAN_SYNC_INTERVAL_MS'],
  opts: { label?: string } = {},
): number {
  const value = raw?.trim()
  if (!value) return DEFAULT_POLLING_SYNC_INTERVAL_MS

  // Plain decimal digits only: reject hex/scientific notation (`0x3e8`, `1e3`)
  // that `Number()` would otherwise coerce, and use `isSafeInteger` so an
  // over-long digit string rounded past MAX_SAFE_INTEGER / overflowed to
  // Infinity is rejected rather than silently accepted with precision loss.
  const parsed = /^\d+$/.test(value) ? Number(value) : NaN
  if (!Number.isSafeInteger(parsed) || parsed < MIN_POLLING_SYNC_INTERVAL_MS) {
    throw new KanbanError(
      ErrorCode.INVALID_CONFIG,
      `${opts.label ?? 'KANBAN_SYNC_INTERVAL_MS'} must be an integer >= ${MIN_POLLING_SYNC_INTERVAL_MS}`,
    )
  }
  return parsed
}
