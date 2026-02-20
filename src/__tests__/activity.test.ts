import { describe, expect, test, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  initSchema,
  seedDefaultColumns,
  addTask,
  updateTask,
  deleteTask,
  moveTask,
  bulkMoveAll,
  bulkClearDone,
} from '../db.ts'
import { listActivity, getTaskActivity, getColumnTimeEntries } from '../activity.ts'

let db: Database

beforeEach(() => {
  db = new Database(':memory:')
  db.run('PRAGMA foreign_keys = ON')
  initSchema(db)
  seedDefaultColumns(db)
})

describe('activity logging', () => {
  test('addTask logs created activity', () => {
    const task = addTask(db, 'Test task')
    const activities = getTaskActivity(db, task.id)
    expect(activities).toHaveLength(1)
    expect(activities[0]!.action).toBe('created')
    expect(activities[0]!.new_value).toBe('Test task')
  })

  test('updateTask logs field changes', () => {
    const task = addTask(db, 'Original')
    updateTask(db, task.id, { title: 'Updated', priority: 'high' })
    const activities = getTaskActivity(db, task.id)
    const actions = activities.map((a) => a.action)
    expect(actions).toContain('updated')
    expect(actions).toContain('prioritized')
  })

  test('updateTask logs assignee change as assigned', () => {
    const task = addTask(db, 'Task')
    updateTask(db, task.id, { assignee: 'alice' })
    const activities = getTaskActivity(db, task.id)
    const assigned = activities.find((a) => a.action === 'assigned')
    expect(assigned).toBeDefined()
    expect(assigned!.new_value).toBe('alice')
  })

  test('updateTask does not log when value unchanged', () => {
    const task = addTask(db, 'Task', { priority: 'high' })
    updateTask(db, task.id, { priority: 'high' })
    const activities = getTaskActivity(db, task.id)
    expect(activities.filter((a) => a.action === 'prioritized')).toHaveLength(0)
  })

  test('deleteTask logs deleted activity', () => {
    const task = addTask(db, 'Doomed')
    const taskId = task.id
    deleteTask(db, taskId)
    const activities = listActivity(db)
    const deleted = activities.find((a) => a.task_id === taskId && a.action === 'deleted')
    expect(deleted).toBeDefined()
    expect(deleted!.old_value).toBe('Doomed')
  })

  test('moveTask logs moved activity', () => {
    const task = addTask(db, 'Mobile', { column: 'recurring' })
    moveTask(db, task.id, 'in-progress')
    const activities = getTaskActivity(db, task.id)
    const moved = activities.find((a) => a.action === 'moved')
    expect(moved).toBeDefined()
    expect(moved!.old_value).toBe('recurring')
    expect(moved!.new_value).toBe('in-progress')
  })

  test('bulkMoveAll logs moved activity for each task', () => {
    addTask(db, 'A', { column: 'recurring' })
    addTask(db, 'B', { column: 'recurring' })
    bulkMoveAll(db, 'recurring', 'in-progress')
    const activities = listActivity(db)
    const moves = activities.filter((a) => a.action === 'moved')
    expect(moves).toHaveLength(2)
  })

  test('bulkClearDone logs deleted activity for each task', () => {
    addTask(db, 'Done A', { column: 'done' })
    addTask(db, 'Done B', { column: 'done' })
    bulkClearDone(db)
    const activities = listActivity(db)
    const deletes = activities.filter((a) => a.action === 'deleted')
    expect(deletes).toHaveLength(2)
  })

  test('listActivity returns most recent first', () => {
    const task = addTask(db, 'Task')
    updateTask(db, task.id, { title: 'Updated' })
    const activities = getTaskActivity(db, task.id)
    expect(activities[0]!.action).toBe('updated')
    expect(activities[1]!.action).toBe('created')
  })

  test('listActivity respects limit', () => {
    const task = addTask(db, 'Task')
    updateTask(db, task.id, { title: 'V2' })
    updateTask(db, task.id, { title: 'V3' })
    const activities = listActivity(db, { limit: 2 })
    expect(activities).toHaveLength(2)
  })
})

describe('column time tracking', () => {
  test('addTask creates enter record', () => {
    const task = addTask(db, 'Task', { column: 'recurring' })
    const entries = getColumnTimeEntries(db, task.id)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.exited_at).toBeNull()
  })

  test('moveTask creates exit and enter records', () => {
    const task = addTask(db, 'Task', { column: 'recurring' })
    moveTask(db, task.id, 'in-progress')
    const entries = getColumnTimeEntries(db, task.id)
    expect(entries).toHaveLength(2)
    expect(entries[0]!.exited_at).not.toBeNull()
    expect(entries[1]!.exited_at).toBeNull()
  })

  test('deleteTask closes open time entry', () => {
    const task = addTask(db, 'Task', { column: 'recurring' })
    const taskId = task.id
    deleteTask(db, taskId)
    const entries = db
      .query('SELECT * FROM column_time_tracking WHERE task_id = $id')
      .all({ $id: taskId }) as { exited_at: string | null }[]
    expect(entries[0]!.exited_at).not.toBeNull()
  })
})
