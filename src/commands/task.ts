import type { Database } from 'bun:sqlite'
import { addTask, getTask, listTasks, updateTask, deleteTask, moveTask } from '../db.ts'
import { ErrorCode, KanbanError } from '../errors.ts'
import { success } from '../output.ts'
import type { CliOutput, Priority } from '../types.ts'

export function taskAdd(
  db: Database,
  args: {
    title?: string
    description?: string
    column?: string
    priority?: string
    assignee?: string
    project?: string
    metadata?: string
  },
): CliOutput {
  if (!args.title) {
    throw new KanbanError(ErrorCode.MISSING_ARGUMENT, 'Task title is required')
  }
  return success(
    addTask(db, args.title, {
      description: args.description,
      column: args.column,
      priority: args.priority as Priority | undefined,
      assignee: args.assignee,
      project: args.project,
      metadata: args.metadata,
    }),
  )
}

export function taskList(
  db: Database,
  opts: {
    column?: string
    priority?: string
    assignee?: string
    project?: string
    limit?: string
    sort?: string
  },
): CliOutput {
  return success(
    listTasks(db, {
      column: opts.column,
      priority: opts.priority,
      assignee: opts.assignee,
      project: opts.project,
      limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
      sort: opts.sort,
    }),
  )
}

export function taskView(db: Database, args: { id?: string }): CliOutput {
  if (!args.id) {
    throw new KanbanError(ErrorCode.MISSING_ARGUMENT, 'Task ID is required')
  }
  return success(getTask(db, args.id))
}

export function taskUpdate(
  db: Database,
  args: {
    id?: string
    title?: string
    description?: string
    priority?: string
    assignee?: string
    project?: string
    metadata?: string
  },
): CliOutput {
  if (!args.id) {
    throw new KanbanError(ErrorCode.MISSING_ARGUMENT, 'Task ID is required')
  }
  return success(
    updateTask(db, args.id, {
      title: args.title,
      description: args.description,
      priority: args.priority as Priority | undefined,
      assignee: args.assignee,
      project: args.project,
      metadata: args.metadata,
    }),
  )
}

export function taskDelete(db: Database, args: { id?: string }): CliOutput {
  if (!args.id) {
    throw new KanbanError(ErrorCode.MISSING_ARGUMENT, 'Task ID is required')
  }
  return success(deleteTask(db, args.id))
}

export function taskMove(db: Database, args: { id?: string; column?: string }): CliOutput {
  if (!args.id || !args.column) {
    throw new KanbanError(ErrorCode.MISSING_ARGUMENT, 'Usage: kanban task move <id> <column>')
  }
  return success(moveTask(db, args.id, args.column))
}

export function taskAssign(db: Database, args: { id?: string; assignee?: string }): CliOutput {
  if (!args.id || !args.assignee) {
    throw new KanbanError(ErrorCode.MISSING_ARGUMENT, 'Usage: kanban task assign <id> <assignee>')
  }
  return success(updateTask(db, args.id, { assignee: args.assignee }))
}

export function taskPrioritize(db: Database, args: { id?: string; priority?: string }): CliOutput {
  if (!args.id || !args.priority) {
    throw new KanbanError(ErrorCode.MISSING_ARGUMENT, 'Usage: kanban task prioritize <id> <level>')
  }
  return success(updateTask(db, args.id, { priority: args.priority as Priority }))
}
