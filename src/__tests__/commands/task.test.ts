import { describe, expect, test, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initSchema, seedDefaultColumns } from '../../db.ts'
import {
  taskAdd,
  taskList,
  taskView,
  taskUpdate,
  taskDelete,
  taskMove,
  taskAssign,
  taskPrioritize,
} from '../../commands/task.ts'
import { KanbanError } from '../../errors.ts'
import type { TaskWithColumn } from '../../types.ts'

let db: Database

beforeEach(() => {
  db = new Database(':memory:')
  db.run('PRAGMA foreign_keys = ON')
  initSchema(db)
  seedDefaultColumns(db)
})

describe('taskAdd', () => {
  test('adds a task with all options', () => {
    const result = taskAdd(db, {
      title: 'Build feature',
      description: 'Do the thing',
      column: 'recurring',
      priority: 'high',
      assignee: 'alice',
      metadata: '{"sprint": 5}',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const task = result.data as TaskWithColumn
      expect(task.title).toBe('Build feature')
      expect(task.description).toBe('Do the thing')
      expect(task.priority).toBe('high')
      expect(task.assignee).toBe('alice')
      expect(task.metadata).toBe('{"sprint": 5}')
    }
  })

  test('throws without title', () => {
    expect(() => taskAdd(db, {})).toThrow(KanbanError)
  })
})

describe('taskList', () => {
  test('lists all tasks', () => {
    taskAdd(db, { title: 'A' })
    taskAdd(db, { title: 'B' })
    const result = taskList(db, {})
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data as TaskWithColumn[]).toHaveLength(2)
    }
  })

  test('filters by column', () => {
    taskAdd(db, { title: 'A', column: 'recurring' })
    taskAdd(db, { title: 'B', column: 'done' })
    const result = taskList(db, { column: 'recurring' })
    if (result.ok) {
      expect(result.data as TaskWithColumn[]).toHaveLength(1)
    }
  })
})

describe('taskView', () => {
  test('returns task details', () => {
    const addResult = taskAdd(db, { title: 'View me' })
    if (!addResult.ok) throw new Error('unexpected')
    const task = addResult.data as TaskWithColumn
    const result = taskView(db, { id: task.id })
    expect(result.ok).toBe(true)
  })

  test('throws for missing id', () => {
    expect(() => taskView(db, {})).toThrow(KanbanError)
  })
})

describe('taskUpdate', () => {
  test('updates task fields', () => {
    const addResult = taskAdd(db, { title: 'Original' })
    if (!addResult.ok) throw new Error('unexpected')
    const task = addResult.data as TaskWithColumn
    const result = taskUpdate(db, { id: task.id, title: 'Modified' })
    if (result.ok) {
      expect((result.data as TaskWithColumn).title).toBe('Modified')
    }
  })
})

describe('taskDelete', () => {
  test('deletes task', () => {
    const addResult = taskAdd(db, { title: 'Delete me' })
    if (!addResult.ok) throw new Error('unexpected')
    const task = addResult.data as TaskWithColumn
    const result = taskDelete(db, { id: task.id })
    expect(result.ok).toBe(true)
    expect(() => taskView(db, { id: task.id })).toThrow(KanbanError)
  })
})

describe('taskMove', () => {
  test('moves task to new column', () => {
    const addResult = taskAdd(db, { title: 'Move me', column: 'recurring' })
    if (!addResult.ok) throw new Error('unexpected')
    const task = addResult.data as TaskWithColumn
    const result = taskMove(db, { id: task.id, column: 'in-progress' })
    if (result.ok) {
      expect((result.data as TaskWithColumn).column_name).toBe('in-progress')
    }
  })
})

describe('taskAssign', () => {
  test('assigns task', () => {
    const addResult = taskAdd(db, { title: 'Assign me' })
    if (!addResult.ok) throw new Error('unexpected')
    const task = addResult.data as TaskWithColumn
    const result = taskAssign(db, { id: task.id, assignee: 'bob' })
    if (result.ok) {
      expect((result.data as TaskWithColumn).assignee).toBe('bob')
    }
  })
})

describe('taskPrioritize', () => {
  test('sets priority', () => {
    const addResult = taskAdd(db, { title: 'Prioritize me' })
    if (!addResult.ok) throw new Error('unexpected')
    const task = addResult.data as TaskWithColumn
    const result = taskPrioritize(db, { id: task.id, priority: 'urgent' })
    if (result.ok) {
      expect((result.data as TaskWithColumn).priority).toBe('urgent')
    }
  })
})
