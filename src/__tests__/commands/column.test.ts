import { describe, expect, test, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initSchema, seedDefaultColumns, addTask } from '../../db.ts'
import {
  columnAdd,
  columnList,
  columnRename,
  columnReorder,
  columnDelete,
} from '../../commands/column.ts'
import { KanbanError } from '../../errors.ts'
import type { Column } from '../../types.ts'

let db: Database

beforeEach(() => {
  db = new Database(':memory:')
  db.run('PRAGMA foreign_keys = ON')
  initSchema(db)
  seedDefaultColumns(db)
})

describe('columnAdd', () => {
  test('adds a column', () => {
    const result = columnAdd(db, { name: 'testing' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect((result.data as Column).name).toBe('testing')
    }
  })

  test('throws without name', () => {
    expect(() => columnAdd(db, {})).toThrow(KanbanError)
  })
})

describe('columnList', () => {
  test('returns all columns', () => {
    const result = columnList(db)
    if (result.ok) {
      expect(result.data as Column[]).toHaveLength(5)
    }
  })
})

describe('columnRename', () => {
  test('renames column', () => {
    const result = columnRename(db, { idOrName: 'recurring', newName: 'weekly' })
    if (result.ok) {
      expect((result.data as Column).name).toBe('weekly')
    }
  })

  test('throws without args', () => {
    expect(() => columnRename(db, {})).toThrow(KanbanError)
  })
})

describe('columnReorder', () => {
  test('reorders column', () => {
    const result = columnReorder(db, { idOrName: 'done', position: '0' })
    if (result.ok) {
      expect((result.data as Column).position).toBe(0)
    }
  })
})

describe('columnDelete', () => {
  test('deletes empty column', () => {
    const result = columnDelete(db, { idOrName: 'review' })
    expect(result.ok).toBe(true)
  })

  test('fails if column has tasks', () => {
    addTask(db, 'Blocker', { column: 'review' })
    expect(() => columnDelete(db, { idOrName: 'review' })).toThrow(KanbanError)
  })
})
