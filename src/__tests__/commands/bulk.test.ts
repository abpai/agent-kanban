import { describe, expect, test, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initSchema, seedDefaultColumns, addTask, listTasks } from '../../db.ts'
import { bulkMoveAllCmd, bulkClearDoneCmd } from '../../commands/bulk.ts'
import { KanbanError } from '../../errors.ts'

let db: Database

beforeEach(() => {
  db = new Database(':memory:')
  db.run('PRAGMA foreign_keys = ON')
  initSchema(db)
  seedDefaultColumns(db)
})

describe('bulkMoveAllCmd', () => {
  test('moves all tasks between columns', () => {
    addTask(db, 'A', { column: 'recurring' })
    addTask(db, 'B', { column: 'recurring' })
    const result = bulkMoveAllCmd(db, { from: 'recurring', to: 'in-progress' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect((result.data as { moved: number }).moved).toBe(2)
    }
    expect(listTasks(db, { column: 'recurring' })).toHaveLength(0)
    expect(listTasks(db, { column: 'in-progress' })).toHaveLength(2)
  })

  test('throws without args', () => {
    expect(() => bulkMoveAllCmd(db, {})).toThrow(KanbanError)
  })
})

describe('bulkClearDoneCmd', () => {
  test('clears done tasks', () => {
    addTask(db, 'Done!', { column: 'done' })
    addTask(db, 'Still working', { column: 'recurring' })
    const result = bulkClearDoneCmd(db)
    if (result.ok) {
      expect((result.data as { deleted: number }).deleted).toBe(1)
    }
    expect(listTasks(db)).toHaveLength(1)
  })

  test('returns 0 when done column is empty', () => {
    const result = bulkClearDoneCmd(db)
    if (result.ok) {
      expect((result.data as { deleted: number }).deleted).toBe(0)
    }
  })
})
