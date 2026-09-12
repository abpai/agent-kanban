import { describe, expect, test, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initSchema, seedDefaultColumns, addTask, listTasks } from '../../db'
import { bulkMoveAllCmd, bulkClearDoneCmd } from '../../commands/bulk'
import { KanbanError } from '../../errors'

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
    expect(result).toMatchObject({ ok: true, data: { moved: 2 } })
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
    expect(result).toMatchObject({ ok: true, data: { deleted: 1 } })
    expect(listTasks(db)).toHaveLength(1)
  })

  test('returns 0 when done column is empty', () => {
    const result = bulkClearDoneCmd(db)
    expect(result).toMatchObject({ ok: true, data: { deleted: 0 } })
  })
})
