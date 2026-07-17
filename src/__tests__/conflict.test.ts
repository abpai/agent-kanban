import { beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initSchema, seedDefaultColumns, resolveColumn, bulkMoveAll } from '../db'
import { LocalProvider } from '../providers/local'
import { ErrorCode, KanbanError } from '../errors'

let db: Database
let provider: LocalProvider

beforeEach(() => {
  db = new Database(':memory:')
  initSchema(db)
  seedDefaultColumns(db)
  provider = new LocalProvider(db, ':memory:')
})

describe('local provider conflict detection', () => {
  test('update without expectedVersion succeeds', async () => {
    const created = await provider.createTask({ title: 'T1' })
    const updated = await provider.updateTask(created.id, { title: 'T1-a' })
    expect(updated.title).toBe('T1-a')
  })

  test('update with matching expectedVersion succeeds', async () => {
    const created = await provider.createTask({ title: 'T1' })
    const updated = await provider.updateTask(created.id, {
      title: 'T1-a',
      expectedVersion: created.version ?? undefined,
    })
    expect(updated.title).toBe('T1-a')
    expect(updated.version).not.toBe(created.version)
  })

  test('update with stale expectedVersion throws CONFLICT', async () => {
    const created = await provider.createTask({ title: 'T1' })
    await provider.updateTask(created.id, { title: 'bumped' })
    let err: unknown
    try {
      await provider.updateTask(created.id, {
        title: 'stale',
        expectedVersion: created.version ?? undefined,
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(KanbanError)
    expect((err as KanbanError).code).toBe(ErrorCode.CONFLICT)
  })

  test('task exposes version and source_updated_at', async () => {
    const created = await provider.createTask({ title: 'T1' })
    expect(created.version).toBe('0')
    expect(created.source_updated_at).toBeNull()
  })

  test('version bumps on each update', async () => {
    const created = await provider.createTask({ title: 'T1' })
    expect(created.version).toBe('0')
    const v1 = await provider.updateTask(created.id, { title: 'a' })
    expect(v1.version).toBe('1')
    const v2 = await provider.updateTask(created.id, { title: 'b' })
    expect(v2.version).toBe('2')
  })

  test('bulkMoveAll bumps the task version so a stale expectedVersion conflicts', async () => {
    const created = await provider.createTask({ title: 'T1', column: 'backlog' })
    expect(created.version).toBe('0')

    const { moved } = bulkMoveAll(db, 'backlog', 'in-progress')
    expect(moved).toBe(1)

    // The move is a real mutation, so the version must change.
    const after = await provider.getTask(created.id)
    expect(after.version).toBe('1')

    let err: unknown
    try {
      await provider.updateTask(created.id, {
        title: 'stale',
        expectedVersion: created.version ?? undefined,
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(KanbanError)
    expect((err as KanbanError).code).toBe(ErrorCode.CONFLICT)
  })

  // moveTask(id, column) intentionally has no expectedVersion parameter, so moves
  // are last-write-wins by design (drag-and-drop has no loaded version to check).
  // This locks in that contract so a move is never rejected for a stale version.
  test('moveTask has no expectedVersion contract (move after an update still succeeds)', async () => {
    const created = await provider.createTask({ title: 'T1', column: 'backlog' })
    await provider.updateTask(created.id, { title: 'bumped' })
    const moved = await provider.moveTask(created.id, 'in-progress')
    expect(moved.column_id).toBe(resolveColumn(db, 'in-progress').id)
  })
})

describe('local provider label replacement', () => {
  test('advertises labelReplacement capability', async () => {
    const ctx = await provider.getContext()
    expect(ctx.capabilities.labelReplacement).toBe(true)
  })

  test('updateTask replaces labels exactly when labels is provided', async () => {
    const created = await provider.createTask({
      title: 'Labeled',
      labels: ['keep-me', 'retire-me'],
    })
    const updated = await provider.updateTask(created.id, {
      labels: ['garage-smoke', 'kept'],
    })
    expect(updated.labels).toEqual(['garage-smoke', 'kept'])
  })

  test('updateTask clears labels when labels is []', async () => {
    const created = await provider.createTask({
      title: 'Clear me',
      labels: ['intake-blocked'],
    })
    const updated = await provider.updateTask(created.id, { labels: [] })
    expect(updated.labels).toEqual([])
  })

  test('updateTask leaves labels untouched when labels is absent', async () => {
    const created = await provider.createTask({
      title: 'Untouched',
      labels: ['alpha', 'beta'],
    })
    const updated = await provider.updateTask(created.id, { title: 'Renamed' })
    expect(updated.title).toBe('Renamed')
    expect(updated.labels).toEqual(['alpha', 'beta'])
  })
})
