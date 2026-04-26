import { beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initSchema, seedDefaultColumns, addTask } from '../db'
import { LocalProvider } from '../providers/local'

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
  test('creates a stored comment, updates task counts, and advertises comment capability', async () => {
    const task = addTask(db, 'Comment me')

    const comment = await provider.comment(task.id, 'hello from local')

    expect(comment.task_id).toBe(task.id)
    expect(comment.body).toBe('hello from local')
    expect((await provider.getTask(task.id)).comment_count).toBe(1)
    const activity = await provider.getActivity(10, task.id)
    expect(activity[0]?.action).toBe('updated')
    expect(activity[0]?.field_changed).toBe('comment')
    expect(activity[0]?.new_value).toBe('hello from local')

    const context = await provider.getContext()
    expect(context.capabilities.comment).toBe(true)
  })

  test('lists stored comments in creation order', async () => {
    const task = addTask(db, 'Comment me')

    const first = await provider.comment(task.id, 'first comment')
    const second = await provider.comment(task.id, 'second comment')
    const comments = await provider.listComments(task.id)

    expect(comments.map((comment) => comment.id)).toEqual([first.id, second.id])
    expect(comments.map((comment) => comment.body)).toEqual(['first comment', 'second comment'])
  })

  test('updates a stored comment body', async () => {
    const task = addTask(db, 'Comment me')
    const comment = await provider.comment(task.id, 'hello from local')

    const updated = await provider.updateComment(task.id, comment.id, 'edited local comment')

    expect(updated.id).toBe(comment.id)
    expect(updated.body).toBe('edited local comment')
    const activity = await provider.getActivity(10, task.id)
    expect(activity[0]?.action).toBe('updated')
    expect(activity[0]?.field_changed).toBe('comment')
    expect(activity[0]?.old_value).toBe('hello from local')
    expect(activity[0]?.new_value).toBe('edited local comment')
  })
})
