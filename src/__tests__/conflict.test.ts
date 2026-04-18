import { beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initSchema, seedDefaultColumns } from '../db.ts'
import { LocalProvider } from '../providers/local.ts'
import { ErrorCode, KanbanError } from '../errors.ts'

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
})
