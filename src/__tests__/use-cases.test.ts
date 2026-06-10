import { beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initSchema, seedDefaultColumns } from '../db'
import { createProvider } from '../providers/index'
import type { KanbanProvider } from '../providers/types'
import { normalizeCreateTaskInput } from '../use-cases'

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
  // The use-case seam owns label normalization so every transport feeds raw
  // labels in its own shape and gets the same result.
  test('normalizes CLI-style nested flag arrays', async () => {
    const task = await provider.createTask(
      normalizeCreateTaskInput({
        title: 'cli',
        labels: [['bug', 'ui'], undefined],
      }),
    )
    expect(task.labels).toEqual(['bug', 'ui'])
  })

  test('normalizes HTTP-style string arrays', async () => {
    const task = await provider.createTask(
      normalizeCreateTaskInput({
        title: 'http',
        labels: ['bug', 'ui'],
      }),
    )
    expect(task.labels).toEqual(['bug', 'ui'])
  })

  test('normalizes a comma-separated string and de-dupes', async () => {
    const task = await provider.createTask(
      normalizeCreateTaskInput({
        title: 'csv',
        labels: 'bug, ui, bug',
      }),
    )
    expect(task.labels).toEqual(['bug', 'ui'])
  })

  test('treats omitted labels as none', async () => {
    const task = await provider.createTask(normalizeCreateTaskInput({ title: 'none' }))
    expect(task.labels).toEqual([])
  })
})
