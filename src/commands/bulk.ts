import type { Database } from 'bun:sqlite'
import { bulkMoveAll, bulkClearDone } from '../db.ts'
import { ErrorCode, KanbanError } from '../errors.ts'
import { success } from '../output.ts'
import type { CliOutput } from '../types.ts'

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
