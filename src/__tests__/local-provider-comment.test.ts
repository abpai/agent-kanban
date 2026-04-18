import { beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initSchema, seedDefaultColumns, addTask } from '../db.ts'
import { LocalProvider } from '../providers/local.ts'

let db: Database
let provider: LocalProvider

beforeEach(() => {
  db = new Database(':memory:')
  db.run('PRAGMA foreign_keys = ON')
  initSchema(db)
  seedDefaultColumns(db)
  provider = new LocalProvider(db, ':memory:')
})

describe('LocalProvider.comment', () => {
  test('records a comment activity entry and advertises comment capability', async () => {
    const task = addTask(db, 'Comment me')

    await provider.comment(task.id, 'hello from local')

    const activity = await provider.getActivity(10, task.id)
    expect(activity[0]?.action).toBe('updated')
    expect(activity[0]?.field_changed).toBe('comment')
    expect(activity[0]?.new_value).toBe('hello from local')

    const context = await provider.getContext()
    expect(context.capabilities.comment).toBe(true)
  })
})
