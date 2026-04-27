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
    for (const raw of ['999', '5s', '1000.5', '0']) {
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
