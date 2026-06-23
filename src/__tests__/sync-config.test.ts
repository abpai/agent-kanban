import { describe, expect, test } from 'bun:test'
import { ErrorCode, KanbanError } from '../errors'
import {
  DEFAULT_POLLING_SYNC_INTERVAL_MS,
  MIN_POLLING_SYNC_INTERVAL_MS,
  resolvePollingSyncIntervalMs,
} from '../sync-config'

describe('sync config', () => {
  test('defaults when unset or blank', () => {
    expect(resolvePollingSyncIntervalMs(undefined)).toBe(DEFAULT_POLLING_SYNC_INTERVAL_MS)
    expect(resolvePollingSyncIntervalMs('   ')).toBe(DEFAULT_POLLING_SYNC_INTERVAL_MS)
  })

  test('accepts an integer millisecond interval', () => {
    expect(resolvePollingSyncIntervalMs('5000')).toBe(5_000)
  })

  test('rejects invalid or too-aggressive intervals', () => {
    // OBS-1: digits-only — hex/scientific notation (which Number() would accept)
    // and over-long digit strings (precision loss / Infinity) are now rejected
    // for the env var too, matching the strict --sync-interval-ms CLI flag.
    for (const raw of [
      '999',
      '5s',
      '1000.5',
      '0',
      '0x3e8',
      '1e3',
      '1_000',
      '9007199254740993',
      '9'.repeat(309),
    ]) {
      let err: unknown
      try {
        resolvePollingSyncIntervalMs(raw)
      } catch (caught) {
        err = caught
      }
      expect(err).toBeInstanceOf(KanbanError)
      expect((err as KanbanError).code).toBe(ErrorCode.INVALID_CONFIG)
      expect((err as Error).message).toContain(String(MIN_POLLING_SYNC_INTERVAL_MS))
    }
  })
})
