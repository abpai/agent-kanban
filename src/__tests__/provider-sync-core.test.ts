import { describe, expect, test } from 'bun:test'
import type { Task } from '../types'
import {
  applyTaskFilters,
  mapWithConcurrency,
  maxSyncTimestamp,
  parseSyncTimestamp,
  SyncGate,
  syncStatusFromMeta,
} from '../providers/sync-core'

function task(overrides: Partial<Task>): Task {
  return {
    id: overrides.id ?? 't_1',
    providerId: overrides.providerId ?? overrides.id ?? 't_1',
    title: overrides.title ?? 'Task',
    description: '',
    column_id: overrides.column_id ?? 'todo',
    position: overrides.position ?? 0,
    priority: overrides.priority ?? 'low',
    assignee: overrides.assignee ?? '',
    assignees: overrides.assignees ?? [],
    labels: overrides.labels ?? [],
    comment_count: overrides.comment_count ?? 0,
    project: overrides.project ?? '',
    metadata: '{}',
    created_at: overrides.created_at ?? '2026-01-01T00:00:00Z',
    updated_at: overrides.updated_at ?? '2026-01-01T00:00:00Z',
    version: overrides.version ?? overrides.updated_at ?? '2026-01-01T00:00:00Z',
    source_updated_at:
      overrides.source_updated_at ?? overrides.updated_at ?? '2026-01-01T00:00:00Z',
    url: overrides.url,
    externalRef: overrides.externalRef,
  }
}

describe('provider sync core helpers', () => {
  test('SyncGate shares throttle and background-managed suppression rules', () => {
    const gate = new SyncGate(30_000)
    const syncedAt = '2026-01-01T00:00:00.000Z'
    const justAfterSync = Date.parse('2026-01-01T00:00:10.000Z')
    const afterThrottle = Date.parse('2026-01-01T00:00:31.000Z')

    expect(
      gate.shouldSkip({ force: false, viaWarmer: false, lastSyncAt: syncedAt, now: justAfterSync }),
    ).toBe(true)
    expect(
      gate.shouldSkip({ force: true, viaWarmer: false, lastSyncAt: syncedAt, now: justAfterSync }),
    ).toBe(false)
    expect(
      gate.shouldSkip({
        force: false,
        viaWarmer: false,
        lastSyncAt: syncedAt,
        now: afterThrottle,
      }),
    ).toBe(false)

    gate.setBackgroundManaged(true)
    expect(
      gate.shouldSkip({
        force: false,
        viaWarmer: false,
        lastSyncAt: syncedAt,
        now: afterThrottle,
      }),
    ).toBe(true)
    expect(
      gate.shouldSkip({
        force: false,
        viaWarmer: true,
        lastSyncAt: syncedAt,
        now: afterThrottle,
      }),
    ).toBe(false)
  })

  test('applyTaskFilters centralizes priority, assignee, project, sort, and limit behavior', () => {
    const tasks = [
      task({
        id: 'older',
        title: 'Zulu',
        priority: 'high',
        assignee: 'Ada',
        project: 'Core',
        updated_at: '2026-01-01T00:00:00Z',
      }),
      task({
        id: 'newer',
        title: 'Alpha',
        priority: 'high',
        assignee: 'Ada',
        project: 'Core',
        updated_at: '2026-01-02T00:00:00Z',
      }),
      task({
        id: 'other',
        title: 'Beta',
        priority: 'low',
        assignee: 'Grace',
        project: 'Ops',
        updated_at: '2026-01-03T00:00:00Z',
      }),
    ]

    expect(
      applyTaskFilters(tasks, {
        priority: 'high',
        assignee: 'Ada',
        project: 'Core',
        sort: 'updated',
        limit: 1,
      }).map((item) => item.id),
    ).toEqual(['newer'])
    expect(applyTaskFilters(tasks, { sort: 'title' }).map((item) => item.id)).toEqual([
      'newer',
      'other',
      'older',
    ])
  })

  test('mapWithConcurrency preserves order while bounding in-flight work', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 2))
      inFlight -= 1
      return item * 2
    })

    expect(results).toEqual([2, 4, 6, 8, 10])
    expect(maxInFlight).toBe(2)
  })

  test('timestamp helpers and sync status projection keep provider metadata behavior shared', () => {
    expect(parseSyncTimestamp('not-a-date')).toBe(0)
    expect(maxSyncTimestamp('2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z')).toBe(
      '2026-01-02T00:00:00Z',
    )
    expect(
      syncStatusFromMeta({
        lastSyncAt: 'sync',
        lastFullSyncAt: 'full',
        lastWebhookAt: null,
      }),
    ).toEqual({ lastSyncAt: 'sync', lastFullSyncAt: 'full', lastWebhookAt: null })
  })
})
