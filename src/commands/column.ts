import type { Database } from 'bun:sqlite'
import { addColumn, listColumns, renameColumn, reorderColumn, deleteColumn } from '../db'
import { ErrorCode, KanbanError } from '../errors'
import { success } from '../output'
import type { CliOutput } from '../types'

export function columnAdd(
  db: Database,
  args: { name?: string; position?: string; color?: string },
): CliOutput {
  if (!args.name) {
    throw new KanbanError(ErrorCode.MISSING_ARGUMENT, 'Column name is required')
  }
  const pos = args.position !== undefined ? parseInt(args.position, 10) : undefined
  if (pos !== undefined && isNaN(pos)) {
    throw new KanbanError(ErrorCode.INVALID_POSITION, 'Position must be a number')
  }
  return success(addColumn(db, args.name, { position: pos, color: args.color }))
}

export function columnList(db: Database): CliOutput {
  return success(listColumns(db))
}

export function columnRename(
  db: Database,
  args: { idOrName?: string; newName?: string },
): CliOutput {
  if (!args.idOrName || !args.newName) {
    throw new KanbanError(
      ErrorCode.MISSING_ARGUMENT,
      'Usage: kanban column rename <id|name> <new-name>',
    )
  }
  return success(renameColumn(db, args.idOrName, args.newName))
}

export function columnReorder(
  db: Database,
  args: { idOrName?: string; position?: string },
): CliOutput {
  if (!args.idOrName || args.position === undefined) {
    throw new KanbanError(
      ErrorCode.MISSING_ARGUMENT,
      'Usage: kanban column reorder <id|name> <position>',
    )
  }
  const pos = parseInt(args.position, 10)
  if (isNaN(pos)) {
    throw new KanbanError(ErrorCode.INVALID_POSITION, 'Position must be a number')
  }
  return success(reorderColumn(db, args.idOrName, pos))
}

export function columnDelete(db: Database, args: { idOrName?: string }): CliOutput {
  if (!args.idOrName) {
    throw new KanbanError(ErrorCode.MISSING_ARGUMENT, 'Usage: kanban column delete <id|name>')
  }
  return success(deleteColumn(db, args.idOrName))
}
