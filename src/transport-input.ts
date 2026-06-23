import { ErrorCode, KanbanError } from './errors'

/**
 * Parse a required integer supplied through a transport boundary (HTTP query
 * string, CLI flag) into the inclusive range `[min, max]` (max defaults to
 * `MAX_SAFE_INTEGER`). Accepts plain decimal digits only and rejects signs,
 * decimals, and exponent/hex forms like `"1e100"` / `"0x10"` that `Number()`
 * would otherwise coerce to an integer. `isSafeInteger` also rejects an
 * over-long digit string that `Number()` rounds past `MAX_SAFE_INTEGER` or
 * overflows to `Infinity`, so the parsed value stays exact. Throws
 * `KanbanError(INVALID_ARGUMENT)` on any violation. This is the single
 * digits-only integer parser the CLI/HTTP boundary parsers build on.
 */
export function parseBoundedInt(
  value: string,
  opts: { min: number; max?: number; field: string },
): number {
  const trimmed = value.trim()
  const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN
  const max = opts.max ?? Number.MAX_SAFE_INTEGER
  if (!Number.isSafeInteger(parsed) || parsed < opts.min || parsed > max) {
    const range = opts.max === undefined ? `>= ${opts.min}` : `between ${opts.min} and ${opts.max}`
    throw new KanbanError(ErrorCode.INVALID_ARGUMENT, `${opts.field} must be an integer ${range}`)
  }
  return parsed
}

/**
 * Parse an optional positive integer supplied through a transport boundary.
 * Returns `undefined` when the value is absent, otherwise delegates to
 * {@link parseBoundedInt} (min 1) and re-frames the error as "positive integer"
 * so invalid limits don't leak into provider logic (SQL `LIMIT`, `slice`, PG).
 */
export function parsePositiveInt(
  value: string | null | undefined,
  field = 'limit',
): number | undefined {
  if (value === null || value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  try {
    return parseBoundedInt(trimmed, { min: 1, field })
  } catch {
    throw new KanbanError(
      ErrorCode.INVALID_ARGUMENT,
      `${field} must be a positive integer (received '${value}')`,
    )
  }
}
