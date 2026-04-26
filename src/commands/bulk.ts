import type { Database } from 'bun:sqlite'
import { bulkMoveAll, bulkClearDone } from '../db'
import { ErrorCode, KanbanError } from '../errors'
import { success } from '../output'
import type { CliOutput } from '../types'

export function bulkMoveAllCmd(db: Database, args: { from?: string; to?: string }): CliOutput {
  if (!args.from || !args.to) {
    throw new KanbanError(
      ErrorCode.MISSING_ARGUMENT,
      'Usage: kanban bulk move-all <from-col> <to-col>',
    )
  }
  return success(bulkMoveAll(db, args.from, args.to))
}

export function bulkClearDoneCmd(db: Database): CliOutput {
  return success(bulkClearDone(db))
}
