import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

import {
  getCachedLinearActivity,
  initLinearCacheSchema,
  upsertIssues,
} from '../providers/linear-cache.ts'

function mkIssue(overrides: Partial<Parameters<typeof upsertIssues>[1][0]> = {}) {
  return {
    id: 'issue-1',
    identifier: 'ABC-1',
    title: 'Task',
    description: '',
    priority: 0,
    assigneeId: null,
    assigneeName: null,
    projectId: null,
    projectName: null,
    stateId: 'state-1',
    stateName: 'Todo',
    statePosition: 0,
    labels: [],
    commentCount: 0,
    url: null,
    createdAt: '2026-04-19T00:00:00.000Z',
    updatedAt: '2026-04-19T00:00:00.000Z',
    ...overrides,
  }
}

describe('upsertIssues description activity', () => {
  test('emits an activity row when description changes between upserts', () => {
    const db = new Database(':memory:')
    initLinearCacheSchema(db)
    upsertIssues(db, [mkIssue({ description: 'first' })])
    upsertIssues(db, [mkIssue({ description: 'second', updatedAt: '2026-04-19T00:01:00.000Z' })])
    const rows = getCachedLinearActivity(db, { issueId: 'issue-1' })
    const descRows = rows.filter((r) => r.item_field === 'description')
    expect(descRows).toHaveLength(1)
    expect(descRows[0]!.from_value).toBe('first')
    expect(descRows[0]!.to_value).toBe('second')
    expect(descRows[0]!.created_at).toBe('2026-04-19T00:01:00.000Z')
  })

  test('does not emit on first insert (no prior value to diff)', () => {
    const db = new Database(':memory:')
    initLinearCacheSchema(db)
    upsertIssues(db, [mkIssue({ description: 'hello' })])
    const rows = getCachedLinearActivity(db, { issueId: 'issue-1' })
    expect(rows.filter((r) => r.item_field === 'description')).toHaveLength(0)
  })

  test('skips unchanged descriptions', () => {
    const db = new Database(':memory:')
    initLinearCacheSchema(db)
    upsertIssues(db, [mkIssue({ description: 'same' })])
    upsertIssues(db, [mkIssue({ description: 'same', updatedAt: '2026-04-19T00:01:00.000Z' })])
    const rows = getCachedLinearActivity(db, { issueId: 'issue-1' })
    expect(rows.filter((r) => r.item_field === 'description')).toHaveLength(0)
  })

  test('is idempotent when the same updatedAt is replayed', () => {
    const db = new Database(':memory:')
    initLinearCacheSchema(db)
    upsertIssues(db, [mkIssue({ description: 'a' })])
    const edited = mkIssue({ description: 'b', updatedAt: '2026-04-19T00:01:00.000Z' })
    upsertIssues(db, [edited])
    upsertIssues(db, [edited])
    const rows = getCachedLinearActivity(db, { issueId: 'issue-1' })
    expect(rows.filter((r) => r.item_field === 'description')).toHaveLength(1)
  })

  test('treats null/undefined descriptions as empty string', () => {
    const db = new Database(':memory:')
    initLinearCacheSchema(db)
    upsertIssues(db, [mkIssue({ description: 'had content' })])
    upsertIssues(db, [mkIssue({ description: null, updatedAt: '2026-04-19T00:01:00.000Z' })])
    const rows = getCachedLinearActivity(db, { issueId: 'issue-1' })
    const descRows = rows.filter((r) => r.item_field === 'description')
    expect(descRows).toHaveLength(1)
    expect(descRows[0]!.from_value).toBe('had content')
    expect(descRows[0]!.to_value).toBe('')
  })
})
