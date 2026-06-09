import { ErrorCode, KanbanError } from './errors'

/**
 * Parse an optional positive integer supplied through a transport boundary
 * (HTTP query string, CLI flag). Returns `undefined` when the value is absent,
 * and throws a `KanbanError(INVALID_ARGUMENT)` for anything that is not a
 * positive integer — `NaN`, negatives, zero, decimals, and trailing-garbage
 * strings like `"5abc"`. Centralizing this keeps invalid limits from leaking
 * into provider logic, where they would otherwise produce inconsistent
 * behavior across SQL `LIMIT`, `Array.prototype.slice`, and Postgres.
 */
export function parsePositiveInt(
  value: string | null | undefined,
  field = 'limit',
): number | undefined {
  if (value === null || value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  // Plain decimal digits only — reject signs, decimals, and exponent forms like
  // "1e100" that Number() would otherwise treat as integers and let escape into
  // SQL `LIMIT`. Cap at MAX_SAFE_INTEGER so the parsed value stays exact.
  const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > Number.MAX_SAFE_INTEGER) {
    throw new KanbanError(
      ErrorCode.INVALID_ARGUMENT,
      `${field} must be a positive integer (received '${value}')`,
    )
  }
  return parsed
}
