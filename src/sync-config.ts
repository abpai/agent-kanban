import { ErrorCode, KanbanError } from './errors'
import { parseDecimalDigits } from './transport-input'

export const DEFAULT_POLLING_SYNC_INTERVAL_MS = 30_000
export const MIN_POLLING_SYNC_INTERVAL_MS = 1_000

export function resolvePollingSyncIntervalMs(
  raw = process.env['KANBAN_SYNC_INTERVAL_MS'],
  opts: { label?: string } = {},
): number {
  const value = raw?.trim()
  if (!value) return DEFAULT_POLLING_SYNC_INTERVAL_MS

  // Digits-only via the shared parser (rejects hex/scientific like `0x3e8`/`1e3`
  // and over-long strings that round past MAX_SAFE_INTEGER / overflow to
  // Infinity); a set-but-invalid value is a config error, not a fall-back to the
  // default, mirroring the strict --sync-interval-ms CLI flag.
  const parsed = parseDecimalDigits(value)
  if (parsed === null || parsed < MIN_POLLING_SYNC_INTERVAL_MS) {
    throw new KanbanError(
      ErrorCode.INVALID_CONFIG,
      `${opts.label ?? 'KANBAN_SYNC_INTERVAL_MS'} must be an integer >= ${MIN_POLLING_SYNC_INTERVAL_MS}`,
    )
  }
  return parsed
}
