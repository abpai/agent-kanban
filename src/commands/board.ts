import type { Database } from 'bun:sqlite'
import { initSchema, seedDefaultColumns, isInitialized, resetBoard } from '../db'
import { ErrorCode, KanbanError } from '../errors'
import { success } from '../output'
import type { CliOutput } from '../types'

export function boardInit(db: Database, columnNames?: string[]): CliOutput {
  if (isInitialized(db)) {
    throw new KanbanError(ErrorCode.BOARD_ALREADY_INITIALIZED, 'Board is already initialized')
  }
  initSchema(db)
  seedDefaultColumns(db, columnNames)
  return success({ message: 'Board initialized with default columns.' })
}

export function boardReset(db: Database, columnNames?: string[]): CliOutput {
  resetBoard(db, columnNames)
  return success({ message: 'Board reset. All data cleared and defaults restored.' })
}
