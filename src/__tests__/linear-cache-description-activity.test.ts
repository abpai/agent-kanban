import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

import {
  deleteLinearIssue,
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

function freshDb(): Database {
  const db = new Database(':memory:')
  initLinearCacheSchema(db)
  return db
}

function descriptionRows(db: Database, issueId = 'issue-1') {
  return getCachedLinearActivity(db, { issueId }).filter((r) => r.item_field === 'description')
}

describe('upsertIssues description activity', () => {
  test('emits an activity row when description changes between upserts', () => {
    const db = freshDb()
    upsertIssues(db, [mkIssue({ description: 'first' })])
    upsertIssues(db, [mkIssue({ description: 'second', updatedAt: '2026-04-19T00:01:00.000Z' })])
    const rows = descriptionRows(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.from_value).toBe('first')
    expect(rows[0]!.to_value).toBe('second')
    expect(rows[0]!.created_at).toBe('2026-04-19T00:01:00.000Z')
  })

  test('does not emit on first insert (no prior value to diff)', () => {
    const db = freshDb()
    upsertIssues(db, [mkIssue({ description: 'hello' })])
    expect(descriptionRows(db)).toHaveLength(0)
  })

  test('skips unchanged descriptions', () => {
    const db = freshDb()
    upsertIssues(db, [mkIssue({ description: 'same' })])
    upsertIssues(db, [mkIssue({ description: 'same', updatedAt: '2026-04-19T00:01:00.000Z' })])
    expect(descriptionRows(db)).toHaveLength(0)
  })

  test('is idempotent when the same updatedAt is replayed', () => {
    const db = freshDb()
    upsertIssues(db, [mkIssue({ description: 'a' })])
    const edited = mkIssue({ description: 'b', updatedAt: '2026-04-19T00:01:00.000Z' })
    upsertIssues(db, [edited])
    upsertIssues(db, [edited])
    expect(descriptionRows(db)).toHaveLength(1)
  })

  test('treats null/undefined descriptions as empty string', () => {
    const db = freshDb()
    upsertIssues(db, [mkIssue({ description: 'had content' })])
    upsertIssues(db, [mkIssue({ description: null, updatedAt: '2026-04-19T00:01:00.000Z' })])
    const rows = descriptionRows(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.from_value).toBe('had content')
    expect(rows[0]!.to_value).toBe('')
  })

  test('emits when an empty description is populated', () => {
    const db = freshDb()
    upsertIssues(db, [mkIssue({ description: '' })])
    upsertIssues(db, [
      mkIssue({ description: 'now has content', updatedAt: '2026-04-19T00:01:00.000Z' }),
    ])
    const rows = descriptionRows(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.from_value).toBe('')
    expect(rows[0]!.to_value).toBe('now has content')
  })

  test('truncates very long description values to cap storage growth', () => {
    const db = freshDb()
    upsertIssues(db, [mkIssue({ description: 'x'.repeat(10_000) })])
    upsertIssues(db, [
      mkIssue({ description: 'y'.repeat(10_000), updatedAt: '2026-04-19T00:01:00.000Z' }),
    ])
    const row = descriptionRows(db)[0]!
    expect(row.from_value!.length).toBeLessThanOrEqual(4096)
    expect(row.to_value!.length).toBeLessThanOrEqual(4096)
    expect(row.from_value!.endsWith('…[truncated]')).toBe(true)
    expect(row.to_value!.endsWith('…[truncated]')).toBe(true)
  })

  test('preserves existing comment_count when an upsert omits it', () => {
    const db = freshDb()
    upsertIssues(db, [mkIssue({ commentCount: 4 })])
    upsertIssues(db, [
      mkIssue({
        title: 'Task renamed',
        commentCount: undefined,
        updatedAt: '2026-04-19T00:01:00.000Z',
      }),
    ])

    const row = db
      .query('SELECT comment_count, title FROM linear_issues WHERE id = $id')
      .get({ $id: 'issue-1' }) as { comment_count: number; title: string } | null

    expect(row?.title).toBe('Task renamed')
    expect(row?.comment_count).toBe(4)
  })

  test('deleteLinearIssue clears cached activity rows for the deleted issue', () => {
    const db = freshDb()
    upsertIssues(db, [mkIssue({ description: 'first' })])
    upsertIssues(db, [mkIssue({ description: 'second', updatedAt: '2026-04-19T00:01:00.000Z' })])

    expect(getCachedLinearActivity(db, { issueId: 'issue-1' })).toHaveLength(1)
    deleteLinearIssue(db, 'issue-1')

    expect(getCachedLinearActivity(db, { issueId: 'issue-1' })).toHaveLength(0)
  })
})
