#!/usr/bin/env bun

import { parseArgs } from 'node:util'
import { Database } from 'bun:sqlite'
import { KanbanError, ErrorCode } from './errors'
import { formatOutput, error, success } from './output'
import { getDbPath, initSchema, seedDefaultColumns } from './db'
import { boardInit, boardReset } from './commands/board'
import { columnAdd, columnDelete, columnList, columnRename, columnReorder } from './commands/column'
import { bulkClearDoneCmd, bulkMoveAllCmd } from './commands/bulk'
import { getConfigPath, loadConfig, saveConfig } from './config'
import { parseBoundedInt, parsePositiveInt } from './transport-input'
import type { CliOutput, Priority, ProviderCapabilities } from './types'
import { unsupportedOperation } from './providers/errors'
import { openKanbanRuntime } from './provider-runtime'
import { WEBHOOK_SECRET_ENV, trackerConfigFromEnv, trackerProviderFromEnv } from './tracker-config'
import type { KanbanProvider } from './providers/types'
import { MIN_POLLING_SYNC_INTERVAL_MS } from './sync-config'
import { normalizeCreateTaskInput } from './use-cases'

interface ParsedArgs {
  values: Record<string, unknown>
  positionals: string[]
}

function parseCliArgs(argv: string[]): ParsedArgs {
  try {
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
        label: { type: 'string', multiple: true },
        labels: { type: 'string', multiple: true },
        sort: { type: 'string' },
        title: { type: 'string' },
        position: { type: 'string' },
        color: { type: 'string' },
        project: { type: 'string' },
        role: { type: 'string' },
      },
      strict: true,
      allowPositionals: true,
    })
  } catch (err) {
    throw new KanbanError(
      ErrorCode.INVALID_ARGUMENT,
      err instanceof Error ? err.message : String(err),
    )
  }
}

function requireCapability(
  capabilities: ProviderCapabilities,
  capability: keyof ProviderCapabilities,
  feature: string,
): void {
  if (!capabilities[capability])
    unsupportedOperation(`${feature} is not supported by this provider`)
}

function requireLocalProvider(providerType: string, feature: string): void {
  if (providerType !== 'local') unsupportedOperation(`${feature} is only available in local mode`)
}

async function routeTask(
  provider: KanbanProvider,
  action: string | undefined,
  positionals: string[],
  values: Record<string, unknown>,
): Promise<CliOutput> {
  switch (action) {
    case 'add': {
      const title = positionals[2]
      if (!title) throw new KanbanError(ErrorCode.MISSING_ARGUMENT, 'Task title is required')
      return success(
        await provider.createTask(
          normalizeCreateTaskInput({
            title,
            description: values.d as string | undefined,
            column: values.c as string | undefined,
            priority: values.p as Priority | undefined,
            assignee: values.a as string | undefined,
            project: values.project as string | undefined,
            labels: [values.label, values.labels],
            metadata: values.m as string | undefined,
          }),
        ),
      )
    }
    case 'list':
      return success(
        await provider.listTasks({
          column: values.c as string | undefined,
          priority: values.p as string | undefined,
          assignee: values.a as string | undefined,
          project: values.project as string | undefined,
          limit: parsePositiveInt(values.l as string | undefined),
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

async function routeComment(
  provider: KanbanProvider,
  action: string | undefined,
  positionals: string[],
): Promise<CliOutput> {
  switch (action) {
    case 'list': {
      const id = positionals[2]
      if (!id) throw new KanbanError(ErrorCode.MISSING_ARGUMENT, 'Task ID is required')
      return success(await provider.listComments(id))
    }
    case 'add': {
      const id = positionals[2]
      const body = positionals.slice(3).join(' ')
      if (!id || !body) {
        throw new KanbanError(
          ErrorCode.MISSING_ARGUMENT,
          'Usage: kanban comment add <task-id> <body>',
        )
      }
      return success(await provider.comment(id, body))
    }
    case 'update': {
      const id = positionals[2]
      const commentId = positionals[3]
      const body = positionals.slice(4).join(' ')
      if (!id || !commentId || !body) {
        throw new KanbanError(
          ErrorCode.MISSING_ARGUMENT,
          'Usage: kanban comment update <task-id> <comment-id> <body>',
        )
      }
      return success(await provider.updateComment(id, commentId, body))
    }
    default:
      throw new KanbanError(ErrorCode.UNKNOWN_COMMAND, `Unknown comment command '${action}'`)
  }
}

function routeColumn(
  db: Database,
  capabilities: ProviderCapabilities,
  action: string | undefined,
  positionals: string[],
  values: Record<string, unknown>,
): CliOutput {
  requireCapability(capabilities, 'columnCrud', 'Column commands')
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
  capabilities: ProviderCapabilities,
  action: string | undefined,
  positionals: string[],
): CliOutput {
  requireCapability(capabilities, 'bulk', 'Bulk commands')
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
  provider: KanbanProvider,
  capabilities: ProviderCapabilities,
  dbPath: string,
  action: string | undefined,
  positionals: string[],
  values: Record<string, unknown>,
): Promise<CliOutput> {
  if (action === 'show' || action === undefined) {
    return success(await provider.getConfig())
  }
  requireCapability(capabilities, 'configEdit', 'Config mutation')

  const configPath = getConfigPath(dbPath)
  const config = loadConfig(dbPath)

  switch (action) {
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

async function routeLocalBoard(
  db: Database,
  provider: KanbanProvider,
  action: string | undefined,
  columnNames?: string[],
): Promise<CliOutput> {
  switch (action) {
    case 'init':
      requireLocalProvider(provider.type, 'Board initialization')
      return boardInit(db, columnNames)
    case 'view':
    case undefined:
      if (provider.type === 'local') {
        initSchema(db)
        seedDefaultColumns(db, columnNames)
      }
      return success(await provider.getBoard())
    case 'reset':
      requireLocalProvider(provider.type, 'Board reset')
      return boardReset(db, columnNames)
    default:
      throw new KanbanError(ErrorCode.UNKNOWN_COMMAND, `Unknown board command '${action}'`)
  }
}

async function run(argv: string[]): Promise<{ output: CliOutput; exitCode: number }> {
  const { values, positionals } = parseCliArgs(argv)
  if (values.help) {
    return { output: { ok: true, data: { message: HELP_TEXT } }, exitCode: 0 }
  }

  const actionRequiresExplicitInit = positionals[0] === 'board' && positionals[1] === 'init'
  const runtime = await openKanbanRuntime({
    dbPath: (values.db as string | undefined) ?? getDbPath(),
    seedLocalColumns: actionRequiresExplicitInit ? false : undefined,
  })

  try {
    const { provider, sqliteDb, dbPath, trackerConfig, capabilities } = runtime
    const group = positionals[0]
    const action = positionals[1]
    const defaultColumns =
      trackerConfig.provider === 'local' ? trackerConfig.defaultColumns : undefined

    if (!group) {
      if (sqliteDb && provider.type === 'local')
        return {
          output: await routeLocalBoard(sqliteDb, provider, undefined, defaultColumns),
          exitCode: 0,
        }
      return { output: success(await provider.getBoard()), exitCode: 0 }
    }

    let output: CliOutput
    switch (group) {
      case 'board':
        if (sqliteDb) {
          output = await routeLocalBoard(sqliteDb, provider, action, defaultColumns)
        } else {
          if (action === 'view' || action === undefined) output = success(await provider.getBoard())
          else unsupportedOperation(`board ${action} is not available with KANBAN_STORAGE=postgres`)
        }
        break
      case 'task':
        output = await routeTask(provider, action, positionals, values)
        break
      case 'comment':
        output = await routeComment(provider, action, positionals)
        break
      case 'column':
        if (!sqliteDb)
          unsupportedOperation('Column commands are not available with KANBAN_STORAGE=postgres')
        output = routeColumn(sqliteDb, capabilities, action, positionals, values)
        break
      case 'bulk':
        if (!sqliteDb)
          unsupportedOperation('Bulk commands are not available with KANBAN_STORAGE=postgres')
        output = routeBulk(sqliteDb, capabilities, action, positionals)
        break
      case 'config':
        // routeConfig persists to the SQLite-side config file, so it only runs
        // when a SQLite database is present. Postgres-local has no config
        // repository (configEdit:false), so edits are refused here — matching the
        // HTTP API, which fails through the provider's patchConfig.
        if (sqliteDb) {
          output = await routeConfig(provider, capabilities, dbPath, action, positionals, values)
        } else {
          if (action === 'show' || action === undefined)
            output = success(await provider.getConfig())
          else
            unsupportedOperation(`config ${action} is not available with KANBAN_STORAGE=postgres`)
        }
        break
      default:
        throw new KanbanError(ErrorCode.UNKNOWN_COMMAND, `Unknown command group '${group}'`)
    }

    return { output, exitCode: 0 }
  } finally {
    await runtime.close()
  }
}

const HELP_TEXT = `kanban - Agent-friendly kanban board CLI

Usage: kanban [command] [options]

Commands:
  board init                  Initialize a new board
  board view                  View full board (default)
  board reset                 Reset board to defaults

  task add <title>            Add a task [-d desc] [-c column] [-p priority] [-a assignee] [--project name] [--label name] [--labels names] [-m json]
  task list                   List tasks [-c column] [-p priority] [-a assignee] [--project name] [-l limit] [--sort field]
  task view <id>              View task details
  task update <id>            Update task [--title] [-d] [-p] [-a] [--project name] [-m]
  task delete <id>            Delete a task
  task move <id> <column>     Move task to column
  task assign <id> <user>     Assign task
  task prioritize <id> <lvl>  Set priority

  comment list <task-id>      List comments on a task
  comment add <task-id> <body> Create a comment
  comment update <task-id> <comment-id> <body>
                              Update a comment

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

  serve                       Start web dashboard [--port 3000] [--sync-interval-ms ms]
  mcp                         Run as an MCP server over stdio (for Claude Desktop, etc.)

Options:
  --pretty      Human-readable output (default: JSON)
  --db <path>   SQLite database path (default: local ./.kanban if present, else ~/.kanban if present, else create ./.kanban)
  --project <n> Filter/set project
  -h, --help    Show this help`

export interface ServeOptions {
  db?: string
  port: number
  syncIntervalMs?: number
  tunnel: boolean
  authToken?: string
  allowedOrigin?: string
}

export function parseServeArgs(argv: string[]): ServeOptions {
  let values: Record<string, unknown>
  try {
    values = parseArgs({
      args: argv,
      options: {
        db: { type: 'string' },
        port: { type: 'string' },
        'sync-interval-ms': { type: 'string' },
        tunnel: { type: 'boolean', default: false },
        token: { type: 'string' },
        'allowed-origin': { type: 'string' },
      },
      strict: true,
      allowPositionals: true,
    }).values
  } catch (err) {
    throw new KanbanError(
      ErrorCode.INVALID_ARGUMENT,
      err instanceof Error ? err.message : String(err),
    )
  }
  // Use `!== undefined` (not truthiness) so an explicit empty `--port=` is
  // validated and rejected rather than silently falling back to the default.
  const port =
    values.port !== undefined
      ? parsePort(values.port as string, '--port')
      : parsePort(process.env['PORT'] || '3000', 'PORT')
  // Flags win over env so a one-off `--token` can override the ambient config.
  const authToken = (values.token as string | undefined) || process.env['KANBAN_API_TOKEN']
  const allowedOrigin =
    (values['allowed-origin'] as string | undefined) || process.env['KANBAN_ALLOWED_ORIGIN']
  return {
    db: values.db as string | undefined,
    port,
    ...(values['sync-interval-ms'] !== undefined
      ? { syncIntervalMs: parseSyncIntervalMs(values['sync-interval-ms'] as string) }
      : {}),
    tunnel: Boolean(values.tunnel),
    ...(authToken ? { authToken } : {}),
    ...(allowedOrigin ? { allowedOrigin } : {}),
  }
}

// Strict digits-only CLI contract via the shared parseBoundedInt (rejects
// hex/scientific, the Number() overflow/precision-loss of an over-long digit
// string, and values below the minimum — all as INVALID_ARGUMENT). The shared
// resolvePollingSyncIntervalMs (sync-config.ts) is the env-path parser; this
// flag is validated strictly here.
function parseSyncIntervalMs(raw: string): number {
  return parseBoundedInt(raw, { min: MIN_POLLING_SYNC_INTERVAL_MS, field: '--sync-interval-ms' })
}

// `parseInt` silently accepts `123abc` (→123) and `-1`, and yields NaN for
// non-numeric input, so validate the port explicitly via parseBoundedInt: digits
// only, 0–65535 (0 lets the OS pick an ephemeral port). Throws so a bad value
// surfaces as the structured INVALID_ARGUMENT envelope rather than booting on a
// garbage port.
function parsePort(raw: string, label: string): number {
  return parseBoundedInt(raw, { min: 0, max: 65535, field: label })
}

/**
 * Guards public-tunnel startup. A `--tunnel` exposes the server to the internet,
 * so it must require both:
 *   1. an API token (KANBAN_API_TOKEN / --token) for the `/api/*` + `/ws` surface, and
 *   2. a provider webhook signing secret, because `/api/webhooks/*` is exempt from
 *      the API token and falls back to "open dev mode" (accept unsigned payloads)
 *      when the secret is unset — which over a public tunnel means unauthenticated
 *      writes to the cache.
 * Throws KanbanError on violation; the caller prints the message and exits non-zero.
 */
export function assertTunnelSecurity(
  opts: { tunnel: boolean; authToken?: string },
  env: Record<string, string | undefined>,
): void {
  if (!opts.tunnel) return
  if (!opts.authToken) {
    throw new KanbanError(
      ErrorCode.INVALID_ARGUMENT,
      'Refusing to start a public tunnel without an API token. ' +
        'Set KANBAN_API_TOKEN or pass --token <token>.',
    )
  }
  const providerType = trackerProviderFromEnv(env)
  // Single source of truth (WEBHOOK_SECRET_ENV is Record<TrackerProvider,…>), so
  // a new webhook-capable provider can't be added without declaring its secret
  // here — closing the fail-open hole where an unmapped provider would start a
  // public tunnel with no signature secret enforced.
  const webhookSecretEnv = WEBHOOK_SECRET_ENV[providerType]
  if (webhookSecretEnv && !env[webhookSecretEnv]) {
    throw new KanbanError(
      ErrorCode.INVALID_ARGUMENT,
      `Refusing to start a public tunnel: ${providerType} webhooks accept unsigned payloads ` +
        `(open dev mode) without ${webhookSecretEnv}, which would expose unauthenticated writes ` +
        `over the public URL. Set ${webhookSecretEnv}.`,
    )
  }
}

export interface McpOptions {
  db?: string
}

export function parseMcpArgs(argv: string[]): McpOptions {
  let values: Record<string, unknown>
  try {
    values = parseArgs({
      args: argv,
      options: { db: { type: 'string' } },
      strict: true,
      allowPositionals: true,
    }).values
  } catch (err) {
    throw new KanbanError(
      ErrorCode.INVALID_ARGUMENT,
      err instanceof Error ? err.message : String(err),
    )
  }
  return { db: values.db as string | undefined }
}

// Bad serve/mcp flags should print the same structured error envelope as the
// plain CLI branch, not an uncaught stack trace.
function parseEntryArgs<T>(parse: () => T): T {
  try {
    return parse()
  } catch (err) {
    if (err instanceof KanbanError) {
      console.error(formatOutput(error(err.code, err.message), false))
      process.exit(1)
    }
    throw err
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)

  if (argv[0] === 'mcp') {
    const opts = parseEntryArgs(() => parseMcpArgs(argv))
    const runtime = await openKanbanRuntime({ dbPath: opts.db ?? getDbPath() })
    const { startStdioMcpServer } = await import('./commands/mcp')
    try {
      await startStdioMcpServer(runtime.provider)
    } finally {
      await runtime.close()
    }
  } else if (argv[0] === 'serve') {
    const opts = parseEntryArgs(() => parseServeArgs(argv))

    // A tunnel exposes the dashboard publicly, so refuse to start one unless it is
    // safe: an API token for /api + /ws, and a provider webhook secret so the
    // auth-exempt /api/webhooks/* surface can't accept unsigned writes. Plain
    // localhost serve stays open for backward compatibility.
    try {
      assertTunnelSecurity(opts, process.env)
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }

    const runtime = await openKanbanRuntime({
      dbPath: opts.db ?? getDbPath(),
      ...(opts.syncIntervalMs !== undefined
        ? {
            tracker: {
              ...trackerConfigFromEnv(process.env),
              syncIntervalMs: opts.syncIntervalMs,
            },
          }
        : {}),
    })
    const { startServer } = await import('./server')
    const server = startServer(runtime.provider, opts.port, {
      syncIntervalMs: runtime.syncIntervalMs,
      ...(opts.authToken ? { authToken: opts.authToken } : {}),
      ...(opts.allowedOrigin ? { allowedOrigin: opts.allowedOrigin } : {}),
    })

    let tunnelHandle: { stop: () => void } | null = null
    if (opts.tunnel) {
      const { startCloudflareTunnel } = await import('./tunnel')
      try {
        // Use the resolved bound port, not opts.port: with `--port=0` the OS
        // picks an ephemeral port, so opts.port (0) would point cloudflared at
        // localhost:0 and never reach the server.
        tunnelHandle = startCloudflareTunnel(server.port)
      } catch {
        // startCloudflareTunnel already logged a friendly message
      }
    }

    // Shut down gracefully on signals regardless of tunnel mode: stop the tunnel
    // and server (which clears the background-sync timer), then close the runtime
    // so the Postgres pool / SQLite handle is released.
    let shuttingDown = false
    const shutdown = async (): Promise<void> => {
      if (shuttingDown) return
      shuttingDown = true
      // try/finally so a cleanup failure (e.g. runtime.close() rejecting) still
      // exits the process instead of leaving an unhandled rejection and a hang.
      try {
        tunnelHandle?.stop()
        server.stop()
        await runtime.close()
      } catch (err) {
        console.error('Error during shutdown:', err instanceof Error ? err.message : err)
      } finally {
        process.exit(0)
      }
    }
    process.on('SIGINT', () => void shutdown())
    process.on('SIGTERM', () => void shutdown())
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
