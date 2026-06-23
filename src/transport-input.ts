import { ErrorCode, KanbanError } from './errors'

/**
 * Parse a plain decimal-digit string into an exact non-negative integer, or
 * `null` if it is not one. Rejects signs, decimals, and exponent/hex forms like
 * `"-1"` / `"3.5"` / `"1e100"` / `"0x10"` that `Number()` would otherwise coerce
 * to an integer, and rejects an over-long digit string that `Number()` rounds
 * past `MAX_SAFE_INTEGER` or overflows to `Infinity`, so the result is always
 * exact. Surrounding whitespace is trimmed. This is the shared digits-only
 * primitive the throwing boundary/config parsers (`parseBoundedInt`,
 * `resolvePollingSyncIntervalMs`, the JIRA_BOARD_ID loader) build on — keeping a
 * single definition of "what counts as an integer" so they can't drift.
 */
export function parseDecimalDigits(value: string): number | null {
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const parsed = Number(trimmed)
  return Number.isSafeInteger(parsed) ? parsed : null
}

/**
 * Parse a required integer supplied through a transport boundary (HTTP query
 * string, CLI flag) into the inclusive range `[min, max]` (max defaults to
 * `MAX_SAFE_INTEGER`), via {@link parseDecimalDigits}. Throws
 * `KanbanError(INVALID_ARGUMENT)` on any violation.
 */
export function parseBoundedInt(
  value: string,
  opts: { min: number; max?: number; field: string },
): number {
  const parsed = parseDecimalDigits(value)
  const max = opts.max ?? Number.MAX_SAFE_INTEGER
  if (parsed === null || parsed < opts.min || parsed > max) {
    const range = opts.max === undefined ? `>= ${opts.min}` : `between ${opts.min} and ${opts.max}`
    throw new KanbanError(ErrorCode.INVALID_ARGUMENT, `${opts.field} must be an integer ${range}`)
  }
  return parsed
}

/**
 * Parse an optional positive integer supplied through a transport boundary.
 * Returns `undefined` when the value is absent/blank, otherwise resolves via
 * {@link parseDecimalDigits} (which trims and caps at `MAX_SAFE_INTEGER`) and
 * enforces `>= 1`, throwing `KanbanError(INVALID_ARGUMENT)` framed as "positive
 * integer" so invalid limits don't leak into provider logic (SQL `LIMIT`,
 * `slice`, PG).
 */
export function parsePositiveInt(
  value: string | null | undefined,
  field = 'limit',
): number | undefined {
  if (value === null || value === undefined) return undefined
  if (value.trim() === '') return undefined
  const parsed = parseDecimalDigits(value)
  if (parsed === null || parsed < 1) {
    throw new KanbanError(
      ErrorCode.INVALID_ARGUMENT,
      `${field} must be a positive integer (received '${value}')`,
    )
  }
  return parsed
}
