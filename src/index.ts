#!/usr/bin/env bun

import { parseArgs } from 'node:util'
import { Database } from 'bun:sqlite'
import { KanbanError, ErrorCode } from './errors'
import { formatOutput, error, success } from './output'
import { openDb, getDbPath, initSchema, migrateSchema, seedDefaultColumns } from './db'
import { boardInit, boardReset } from './commands/board'
import { columnAdd, columnDelete, columnList, columnRename, columnReorder } from './commands/column'
import { bulkClearDoneCmd, bulkMoveAllCmd } from './commands/bulk'
import { getConfigPath, loadConfig, saveConfig } from './config'
import type { CliOutput, Priority } from './types'
import { createProvider } from './providers/index'
import { unsupportedOperation } from './providers/errors'

interface ParsedArgs {
  values: Record<string, unknown>
  positionals: string[]
}

function parseCliArgs(argv: string[]): ParsedArgs {
  return parseArgs({
    args: argv,
    options: {
      pretty: { type: 'boolean', default: false },
      db: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
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
}

function requireLocalProvider(providerType: string, feature: string): void {
  if (providerType !== 'local') unsupportedOperation(`${feature} is only available in local mode`)
}

async function routeTask(
  provider: ReturnType<typeof createProvider>,
  action: string | undefined,
  positionals: string[],
  values: Record<string, unknown>,
): Promise<CliOutput> {
  switch (action) {
    case 'add': {
      const title = positionals[2]
      if (!title) throw new KanbanError(ErrorCode.MISSING_ARGUMENT, 'Task title is required')
      return success(
        await provider.createTask({
          title,
          description: values.d as string | undefined,
          column: values.c as string | undefined,
          priority: values.p as Priority | undefined,
          assignee: values.a as string | undefined,
          project: values.project as string | undefined,
          metadata: values.m as string | undefined,
        }),
      )
    }
    case 'list':
      return success(
        await provider.listTasks({
          column: values.c as string | undefined,
          priority: values.p as string | undefined,
          assignee: values.a as string | undefined,
          project: values.project as string | undefined,
          limit: values.l ? parseInt(values.l as string, 10) : undefined,
          sort: values.sort as string | undefined,
        }),
      )
    case 'view': {
      const id = positionals[2]
      if (!id) throw new KanbanError(ErrorCode.MISSING_ARGUMENT, 'Task ID is required')
      return success(await provider.getTask(id))
    }
    case 'update': {
      const id = positionals[2]
      if (!id) throw new KanbanError(ErrorCode.MISSING_ARGUMENT, 'Task ID is required')
      return success(
        await provider.updateTask(id, {
          title: values.title as string | undefined,
          description: values.d as string | undefined,
          priority: values.p as Priority | undefined,
          assignee: values.a as string | undefined,
          project: values.project as string | undefined,
          metadata: values.m as string | undefined,
        }),
      )
    }
    case 'delete': {
      const id = positionals[2]
      if (!id) throw new KanbanError(ErrorCode.MISSING_ARGUMENT, 'Task ID is required')
      return success(await provider.deleteTask(id))
    }
    case 'move': {
      const id = positionals[2]
      const column = positionals[3]
      if (!id || !column) {
        throw new KanbanError(ErrorCode.MISSING_ARGUMENT, 'Usage: kanban task move <id> <column>')
      }
      return success(await provider.moveTask(id, column))
    }
    case 'assign': {
      const id = positionals[2]
      const assignee = positionals[3]
      if (!id || assignee === undefined) {
        throw new KanbanError(
          ErrorCode.MISSING_ARGUMENT,
          'Usage: kanban task assign <id> <assignee>',
        )
      }
      return success(await provider.updateTask(id, { assignee }))
    }
    case 'prioritize': {
      const id = positionals[2]
      const priority = positionals[3]
      if (!id || !priority) {
        throw new KanbanError(
          ErrorCode.MISSING_ARGUMENT,
          'Usage: kanban task prioritize <id> <level>',
        )
      }
      return success(await provider.updateTask(id, { priority: priority as Priority }))
    }
    default:
      throw new KanbanError(ErrorCode.UNKNOWN_COMMAND, `Unknown task command '${action}'`)
  }
}

function routeColumn(
  db: Database,
  providerType: string,
  action: string | undefined,
  positionals: string[],
  values: Record<string, unknown>,
): CliOutput {
  requireLocalProvider(providerType, 'Column commands')
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

function routeBulk(
  db: Database,
  providerType: string,
  action: string | undefined,
  positionals: string[],
): CliOutput {
  requireLocalProvider(providerType, 'Bulk commands')
  switch (action) {
    case 'move-all':
      return bulkMoveAllCmd(db, { from: positionals[2], to: positionals[3] })
    case 'clear-done':
      return bulkClearDoneCmd(db)
    default:
      throw new KanbanError(ErrorCode.UNKNOWN_COMMAND, `Unknown bulk command '${action}'`)
  }
}

async function routeConfig(
  provider: ReturnType<typeof createProvider>,
  dbPath: string,
  action: string | undefined,
  positionals: string[],
  values: Record<string, unknown>,
): Promise<CliOutput> {
  if (provider.type !== 'local') {
    if (action === 'show' || action === undefined) {
      return success(await provider.getConfig())
    }
    unsupportedOperation('Config mutation is only available in local mode')
  }

  const configPath = getConfigPath(dbPath)
  const config = loadConfig(dbPath)

  switch (action) {
    case 'show':
    case undefined:
      return success(await provider.getConfig())
    case 'set-member': {
      const name = positionals[2]
      if (!name) throw new KanbanError(ErrorCode.MISSING_ARGUMENT, 'Member name is required')
      const role =
        (values.role as string | undefined) === 'agent' ? ('agent' as const) : ('human' as const)
      const existing = config.members.findIndex((member) => member.name === name)
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
      config.members = config.members.filter((member) => member.name !== name)
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
      config.projects = config.projects.filter((project) => project !== name)
      saveConfig(configPath, config)
      return success({ message: `Project '${name}' removed` })
    }
    default:
      throw new KanbanError(ErrorCode.UNKNOWN_COMMAND, `Unknown config command '${action}'`)
  }
}

async function routeBoard(
  db: Database,
  provider: ReturnType<typeof createProvider>,
  action: string | undefined,
): Promise<CliOutput> {
  switch (action) {
    case 'init':
      requireLocalProvider(provider.type, 'Board initialization')
      return boardInit(db)
    case 'view':
    case undefined:
      if (provider.type === 'local') {
        initSchema(db)
        seedDefaultColumns(db)
      }
      return success(await provider.getBoard())
    case 'reset':
      requireLocalProvider(provider.type, 'Board reset')
      return boardReset(db)
    default:
      throw new KanbanError(ErrorCode.UNKNOWN_COMMAND, `Unknown board command '${action}'`)
  }
}

async function run(argv: string[]): Promise<{ output: CliOutput; exitCode: number }> {
  const { values, positionals } = parseCliArgs(argv)
  if (values.help) {
    return { output: { ok: true, data: { message: HELP_TEXT } }, exitCode: 0 }
  }

  const dbPath = (values.db as string | undefined) ?? getDbPath()
  const db = openDb(dbPath)
  migrateSchema(db)

  try {
    const provider = createProvider(db, dbPath)
    const group = positionals[0]
    const action = positionals[1]

    if (!group) {
      return { output: await routeBoard(db, provider, undefined), exitCode: 0 }
    }

    let output: CliOutput
    switch (group) {
      case 'board':
        output = await routeBoard(db, provider, action)
        break
      case 'task':
        output = await routeTask(provider, action, positionals, values)
        break
      case 'column':
        output = routeColumn(db, provider.type, action, positionals, values)
        break
      case 'bulk':
        output = routeBulk(db, provider.type, action, positionals)
        break
      case 'config':
        output = await routeConfig(provider, dbPath, action, positionals, values)
        break
      default:
        throw new KanbanError(ErrorCode.UNKNOWN_COMMAND, `Unknown command group '${group}'`)
    }

    return { output, exitCode: 0 }
  } finally {
    db.close()
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
  mcp                         Run as an MCP server over stdio (for Claude Desktop, etc.)

Options:
  --pretty      Human-readable output (default: JSON)
  --db <path>   Database path (default: local ./.kanban if present, else ~/.kanban if present, else create ./.kanban)
  --project <n> Filter/set project
  -h, --help    Show this help`

export interface ServeOptions {
  db?: string
  port: number
  tunnel: boolean
}

export function parseServeArgs(argv: string[]): ServeOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: 'string' },
      port: { type: 'string' },
      tunnel: { type: 'boolean', default: false },
    },
    strict: false,
    allowPositionals: true,
  })
  const port = values.port
    ? parseInt(values.port as string, 10)
    : parseInt(process.env['PORT'] || '3000', 10)
  return {
    db: values.db as string | undefined,
    port,
    tunnel: Boolean(values.tunnel),
  }
}

export interface McpOptions {
  db?: string
}

export function parseMcpArgs(argv: string[]): McpOptions {
  const { values } = parseArgs({
    args: argv,
    options: { db: { type: 'string' } },
    strict: false,
    allowPositionals: true,
  })
  return { db: values.db as string | undefined }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)

  if (argv[0] === 'mcp') {
    const opts = parseMcpArgs(argv)
    const dbPath = opts.db ?? getDbPath()
    const db = openDb(dbPath)
    migrateSchema(db)
    const provider = createProvider(db, dbPath)
    const { startStdioMcpServer } = await import('./commands/mcp')
    await startStdioMcpServer(provider)
  } else if (argv[0] === 'serve') {
    const opts = parseServeArgs(argv)

    const dbPath = opts.db ?? getDbPath()
    const db = openDb(dbPath)
    migrateSchema(db)
    const provider = createProvider(db, dbPath)
    const { startServer } = await import('./server')
    startServer(provider, opts.port)

    if (opts.tunnel) {
      const { startCloudflareTunnel } = await import('./tunnel')
      try {
        const handle = startCloudflareTunnel(opts.port)
        const shutdown = (): void => {
          handle.stop()
          process.exit(0)
        }
        process.on('SIGINT', shutdown)
        process.on('SIGTERM', shutdown)
      } catch {
        // startCloudflareTunnel already logged a friendly message
      }
    }
  } else {
    let exitCode = 0
    const pretty = argv.includes('--pretty')

    try {
      const result = await run(argv)
      exitCode = result.exitCode
      console.info(formatOutput(result.output, pretty))
    } catch (err) {
      if (err instanceof KanbanError) {
        exitCode = 1
        console.error(formatOutput(error(err.code, err.message), pretty))
      } else {
        exitCode = 2
        const msg = err instanceof Error ? err.message : String(err)
        console.error(formatOutput(error(ErrorCode.INTERNAL_ERROR, msg), pretty))
      }
    }

    process.exit(exitCode)
  }
}

export { run }
