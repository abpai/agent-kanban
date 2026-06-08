import { beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initSchema, seedDefaultColumns } from '../db'
import { createProvider } from '../providers/index'
import type { KanbanProvider } from '../providers/types'
import * as useCases from '../use-cases'

let db: Database
let provider: KanbanProvider

beforeEach(() => {
  db = new Database(':memory:')
  db.run('PRAGMA foreign_keys = ON')
  initSchema(db)
  seedDefaultColumns(db)
  provider = createProvider(db, { provider: 'local' }, ':memory:')
})

describe('use-cases label normalization', () => {
  // The use-case layer owns label normalization so every transport feeds raw
  // labels in its own shape and gets the same result.
  test('normalizes CLI-style nested flag arrays', async () => {
    const task = await useCases.createTask(provider, {
      title: 'cli',
      labels: [['bug', 'ui'], undefined],
    })
    expect(task.labels).toEqual(['bug', 'ui'])
  })

  test('normalizes HTTP-style string arrays', async () => {
    const task = await useCases.createTask(provider, {
      title: 'http',
      labels: ['bug', 'ui'],
    })
    expect(task.labels).toEqual(['bug', 'ui'])
  })

  test('normalizes a comma-separated string and de-dupes', async () => {
    const task = await useCases.createTask(provider, {
      title: 'csv',
      labels: 'bug, ui, bug',
    })
    expect(task.labels).toEqual(['bug', 'ui'])
  })

  test('treats omitted labels as none', async () => {
    const task = await useCases.createTask(provider, { title: 'none' })
    expect(task.labels).toEqual([])
  })
})

describe('use-cases provider forwarding', () => {
  test('createTask then getTask/listTasks round-trip', async () => {
    const created = await useCases.createTask(provider, { title: 'roundtrip', column: 'backlog' })
    const fetched = await useCases.getTask(provider, created.id)
    expect(fetched.id).toBe(created.id)
    const all = await useCases.listTasks(provider)
    expect(all.map((t) => t.id)).toContain(created.id)
  })

  test('moveTask forwards to the target column and returns the task', async () => {
    const created = await useCases.createTask(provider, { title: 'mover', column: 'backlog' })
    const columns = await useCases.listColumns(provider)
    const target = columns.find((c) => c.name.toLowerCase() === 'in-progress')!
    const moved = await useCases.moveTask(provider, created.id, target.name)
    expect(moved.column_id).toBe(target.id)
  })

  test('addComment / listComments / updateComment forward correctly', async () => {
    const task = await useCases.createTask(provider, { title: 'commented' })
    const comment = await useCases.addComment(provider, task.id, 'first')
    const listed = await useCases.listComments(provider, task.id)
    expect(listed.map((c) => c.body)).toContain('first')
    const updated = await useCases.updateComment(provider, task.id, comment.id, 'edited')
    expect(updated.body).toBe('edited')
  })
})
