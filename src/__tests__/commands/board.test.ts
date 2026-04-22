import { describe, expect, test, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { getBoardView, initSchema, seedDefaultColumns } from '../../db.ts'
import { boardInit, boardReset } from '../../commands/board.ts'
import { KanbanError } from '../../errors.ts'

let db: Database

beforeEach(() => {
  db = new Database(':memory:')
  db.run('PRAGMA foreign_keys = ON')
})

describe('boardInit', () => {
  test('initializes a fresh database', () => {
    const result = boardInit(db)
    expect(result.ok).toBe(true)
  })

  test('throws if already initialized', () => {
    initSchema(db)
    seedDefaultColumns(db)
    expect(() => boardInit(db)).toThrow(KanbanError)
  })
})

describe('getBoardView', () => {
  test('returns board view after init', () => {
    initSchema(db)
    seedDefaultColumns(db)
    const data = getBoardView(db)
    expect(data.columns).toHaveLength(5)
  })
})

describe('boardReset', () => {
  test('resets board to defaults', () => {
    initSchema(db)
    seedDefaultColumns(db)
    const result = boardReset(db)
    expect(result.ok).toBe(true)
    expect(getBoardView(db).columns).toHaveLength(5)
  })
})
