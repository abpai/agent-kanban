#!/usr/bin/env bun

import { parseArgs } from 'node:util'
import type { Database } from 'bun:sqlite'
import { KanbanError, ErrorCode } from './errors.ts'
import { formatOutput, error } from './output.ts'
import { openDb, getDbPath, initSchema, migrateSchema } from './db.ts'
import { boardInit, boardView, boardReset } from './commands/board.ts'
import {
  columnAdd,
  columnList,
  columnRename,
  columnReorder,
  columnDelete,
} from './commands/column.ts'
import {
  taskAdd,
  taskList,
  taskView,
  taskUpdate,
  taskDelete,
  taskMove,
  taskAssign,
  taskPrioritize,
} from './commands/task.ts'
import { bulkMoveAllCmd, bulkClearDoneCmd } from './commands/bulk.ts'
import { loadConfig, saveConfig, getConfigPath } from './config.ts'
import type { CliOutput } from './types.ts'
import { success } from './output.ts'

function run(argv: string[]): { output: CliOutput; exitCode: number } {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      pretty: { type: 'boolean', default: false },
      db: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
      // task/column flags
      d: { type: 'string' },
      c: { type: 'string' },
      p: { type: 'string' },
      a: { type: 'string' },
      m: { type: 'string' },
      l: { type: 'string' },
      sort: { type: 'string' },
      title: { type: 'string' },
      position: { type: 'string' },
      color: { type: 'string' },
      project: { type: 'string' },
      role: { type: 'string' },
    },
    strict: false,
    allowPositionals: true,
  })

  if (values.help) {
    return {
      output: { ok: true, data: { message: HELP_TEXT } },
      exitCode: 0,
    }
  }

  const dbPath = (values.db as string | undefined) ?? getDbPath()
  const db = openDb(dbPath)
  migrateSchema(db)

  try {
    const group = positionals[0]
    const action = positionals[1]

    // Default: board view
    if (!group) {
      initSchema(db)
      return { output: boardView(db), exitCode: 0 }
    }

    const output = routeCommand(db, group, action, positionals, values)
    return { output, exitCode: 0 }
  } finally {
    db.close()
  }
}

function routeCommand(
  db: Database,
  group: string,
  action: string | undefined,
  positionals: string[],
  values: Record<string, unknown>,
): CliOutput {
  switch (group) {
    case 'board':
      return routeBoard(db, action)
    case 'task':
      return routeTask(db, action, positionals, values)
    case 'column':
      return routeColumn(db, action, positionals, values)
    case 'bulk':
      return routeBulk(db, action, positionals)
    case 'config':
      return routeConfig(group, action, positionals, values)
    default:
      throw new KanbanError(ErrorCode.UNKNOWN_COMMAND, `Unknown command group '${group}'`)
  }
}

function routeBoard(db: Database, action: string | undefined): CliOutput {
  switch (action) {
    case 'init':
      return boardInit(db)
    case 'view':
    case undefined:
      if (action === undefined) initSchema(db)
      return boardView(db)
    case 'reset':
      return boardReset(db)
    default:
      throw new KanbanError(ErrorCode.UNKNOWN_COMMAND, `Unknown board command '${action}'`)
  }
}

function routeTask(
  db: Database,
  action: string | undefined,
  positionals: string[],
  values: Record<string, unknown>,
): CliOutput {
  switch (action) {
    case 'add':
      return taskAdd(db, {
        title: positionals[2],
        description: values.d as string | undefined,
        column: values.c as string | undefined,
        priority: values.p as string | undefined,
        assignee: values.a as string | undefined,
        project: values.project as string | undefined,
        metadata: values.m as string | undefined,
      })
    case 'list':
      return taskList(db, {
        column: values.c as string | undefined,
        priority: values.p as string | undefined,
        assignee: values.a as string | undefined,
        project: values.project as string | undefined,
        limit: values.l as string | undefined,
        sort: values.sort as string | undefined,
      })
    case 'view':
      return taskView(db, { id: positionals[2] })
    case 'update':
      return taskUpdate(db, {
        id: positionals[2],
        title: values.title as string | undefined,
        description: values.d as string | undefined,
        priority: values.p as string | undefined,
        assignee: values.a as string | undefined,
        project: values.project as string | undefined,
        metadata: values.m as string | undefined,
      })
    case 'delete':
      return taskDelete(db, { id: positionals[2] })
    case 'move':
      return taskMove(db, { id: positionals[2], column: positionals[3] })
    case 'assign':
      return taskAssign(db, { id: positionals[2], assignee: positionals[3] })
    case 'prioritize':
      return taskPrioritize(db, { id: positionals[2], priority: positionals[3] })
    default:
      throw new KanbanError(ErrorCode.UNKNOWN_COMMAND, `Unknown task command '${action}'`)
  }
}

function routeColumn(
  db: Database,
  action: string | undefined,
  positionals: string[],
  values: Record<string, unknown>,
): CliOutput {
  switch (action) {
    case 'add':
      return columnAdd(db, {
        name: positionals[2],
        position: values.position as string | undefined,
        color: values.color as string | undefined,
      })
    case 'list':
      return columnList(db)
    case 'rename':
      return columnRename(db, { idOrName: positionals[2], newName: positionals[3] })
    case 'reorder':
      return columnReorder(db, { idOrName: positionals[2], position: positionals[3] })
    case 'delete':
      return columnDelete(db, { idOrName: positionals[2] })
    default:
      throw new KanbanError(ErrorCode.UNKNOWN_COMMAND, `Unknown column command '${action}'`)
  }
}

function routeBulk(db: Database, action: string | undefined, positionals: string[]): CliOutput {
  switch (action) {
    case 'move-all':
      return bulkMoveAllCmd(db, { from: positionals[2], to: positionals[3] })
    case 'clear-done':
      return bulkClearDoneCmd(db)
    default:
      throw new KanbanError(ErrorCode.UNKNOWN_COMMAND, `Unknown bulk command '${action}'`)
  }
}

function routeConfig(
  _group: string,
  action: string | undefined,
  positionals: string[],
  values: Record<string, unknown>,
): CliOutput {
  const dbPath = (values.db as string | undefined) ?? getDbPath()
  const configPath = getConfigPath(dbPath)
  const config = loadConfig(dbPath)

  switch (action) {
    case 'show':
    case undefined:
      return success(config)
    case 'set-member': {
      const name = positionals[2]
      if (!name) throw new KanbanError(ErrorCode.MISSING_ARGUMENT, 'Member name is required')
      const role =
        (values.role as string | undefined) === 'agent' ? ('agent' as const) : ('human' as const)
      const existing = config.members.findIndex((m) => m.name === name)
      if (existing >= 0) {
        config.members[existing] = { name, role }
      } else {
        config.members.push({ name, role })
      }
      saveConfig(configPath, config)
      return success({ message: `Member '${name}' set as ${role}` })
    }
    case 'remove-member': {
      const name = positionals[2]
      if (!name) throw new KanbanError(ErrorCode.MISSING_ARGUMENT, 'Member name is required')
      config.members = config.members.filter((m) => m.name !== name)
      saveConfig(configPath, config)
      return success({ message: `Member '${name}' removed` })
    }
    case 'add-project': {
      const name = positionals[2]
      if (!name) throw new KanbanError(ErrorCode.MISSING_ARGUMENT, 'Project name is required')
      if (!config.projects.includes(name)) {
        config.projects.push(name)
        saveConfig(configPath, config)
      }
      return success({ message: `Project '${name}' added` })
    }
    case 'remove-project': {
      const name = positionals[2]
      if (!name) throw new KanbanError(ErrorCode.MISSING_ARGUMENT, 'Project name is required')
      config.projects = config.projects.filter((p) => p !== name)
      saveConfig(configPath, config)
      return success({ message: `Project '${name}' removed` })
    }
    default:
      throw new KanbanError(ErrorCode.UNKNOWN_COMMAND, `Unknown config command '${action}'`)
  }
}

const HELP_TEXT = `kanban - Agent-friendly kanban board CLI

Usage: kanban [command] [options]

Commands:
  board init                  Initialize a new board
  board view                  View full board (default)
  board reset                 Reset board to defaults

  task add <title>            Add a task [-d desc] [-c column] [-p priority] [-a assignee] [--project name] [-m json]
  task list                   List tasks [-c column] [-p priority] [-a assignee] [--project name] [-l limit] [--sort field]
  task view <id>              View task details
  task update <id>            Update task [--title] [-d] [-p] [-a] [--project name] [-m]
  task delete <id>            Delete a task
  task move <id> <column>     Move task to column
  task assign <id> <user>     Assign task
  task prioritize <id> <lvl>  Set priority

  column add <name>           Add column [--position n] [--color hex]
  column list                 List columns
  column rename <id> <name>   Rename column
  column reorder <id> <pos>   Reorder column
  column delete <id>          Delete empty column

  bulk move-all <from> <to>   Move all tasks between columns
  bulk clear-done             Delete all tasks in 'done'

  config show                 Show board config
  config set-member <name>    Add/update member [--role human|agent]
  config remove-member <name> Remove member
  config add-project <name>   Add project
  config remove-project <name> Remove project

  serve                       Start web dashboard [--port 3000]

Options:
  --pretty      Human-readable output (default: JSON)
  --db <path>   Database path (default: .kanban/board.db)
  --project <n> Filter/set project
  -h, --help    Show this help`

if (import.meta.main) {
  const argv = process.argv.slice(2)

  // Intercept 'serve' command before run() — server needs DB to stay open
  if (argv[0] === 'serve') {
    const portIdx = argv.indexOf('--port')
    const port = portIdx !== -1 ? parseInt(argv[portIdx + 1]!, 10) : 3000

    const { parseArgs: parseServeArgs } = await import('node:util')
    const { values: serveValues } = parseServeArgs({
      args: argv,
      options: { db: { type: 'string' }, port: { type: 'string' } },
      strict: false,
      allowPositionals: true,
    })

    const dbPath = (serveValues.db as string | undefined) ?? getDbPath()
    const db = openDb(dbPath)
    migrateSchema(db)
    initSchema(db)

    const { seedDefaultColumns } = await import('./db.ts')
    seedDefaultColumns(db)

    const { startServer } = await import('./server.ts')
    startServer(db, port)
  } else {
    let exitCode = 0
    let pretty = argv.includes('--pretty')

    try {
      const result = run(argv)
      exitCode = result.exitCode
      pretty = argv.includes('--pretty')
      const output = formatOutput(result.output, pretty)
      console.info(output)
    } catch (err) {
      if (err instanceof KanbanError) {
        exitCode = 1
        const output = formatOutput(error(err.code, err.message), pretty)
        console.error(output)
      } else {
        exitCode = 2
        const msg = err instanceof Error ? err.message : String(err)
        const output = formatOutput(error(ErrorCode.INTERNAL_ERROR, msg), pretty)
        console.error(output)
      }
    }

    process.exit(exitCode)
  }
}

export { run }
