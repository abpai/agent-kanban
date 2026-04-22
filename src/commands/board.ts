import type { Database } from 'bun:sqlite'
import { initSchema, seedDefaultColumns, isInitialized, resetBoard } from '../db.ts'
import { ErrorCode, KanbanError } from '../errors.ts'
import { success } from '../output.ts'
import type { CliOutput } from '../types.ts'

export function boardInit(db: Database): CliOutput {
  if (isInitialized(db)) {
    throw new KanbanError(ErrorCode.BOARD_ALREADY_INITIALIZED, 'Board is already initialized')
  }
  initSchema(db)
  seedDefaultColumns(db)
  return success({ message: 'Board initialized with default columns.' })
}

export function boardReset(db: Database): CliOutput {
  resetBoard(db)
  return success({ message: 'Board reset. All data cleared and defaults restored.' })
}
