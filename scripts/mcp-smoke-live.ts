#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import { Database } from 'bun:sqlite'
import { Client } from '@modelcontextprotocol/sdk/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createTrackerCore, createTrackerMcpServer } from '../src/mcp/index'
import { createProvider } from '../src/providers/index'
import { trackerConfigFromEnv } from '../src/tracker-config'

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    provider: { type: 'string' },
    ticket: { type: 'string' },
    write: { type: 'boolean', default: false },
    'move-to': { type: 'string' },
  },
  strict: true,
})

const providerName = values.provider
const ticketId = values.ticket
const writeEnabled = values.write
const moveTo = values['move-to']
const usage =
  'usage: bun --env-file=.env.local scripts/mcp-smoke-live.ts --provider <jira|linear> --ticket <KEY> [--write] [--move-to <column>]'

if (providerName !== 'jira' && providerName !== 'linear') {
  console.error(usage)
  process.exit(2)
}
if (!ticketId) {
  console.error('missing --ticket <KEY>')
  process.exit(2)
}

process.env['KANBAN_PROVIDER'] = providerName

// Honor KANBAN_DB_PATH so repeat runs reuse a warm provider cache; a fresh
// :memory: DB forces a full cold sync (~30s on a large Jira project) on the
// first tool call.
const dbPath = process.env['KANBAN_DB_PATH'] ?? ':memory:'
const db = new Database(dbPath)
db.run('PRAGMA foreign_keys = ON')
const provider = createProvider(db, trackerConfigFromEnv(process.env), dbPath)

type Scope = { actor: string; write: boolean }

const core = createTrackerCore<Scope>({
  provider,
  policy: {
    canReadTicket() {},
    canPostComment(scope) {
      if (!scope.write) throw new Error('writes disabled (pass --write to enable)')
    },
    canUpdateComment(scope) {
      if (!scope.write) throw new Error('writes disabled (pass --write to enable)')
    },
    canMoveTicket(scope) {
      if (!scope.write) throw new Error('writes disabled (pass --write to enable)')
    },
  },
  hooks: {
    onToolResult({ tool, durationMs, result }) {
      console.info(`  [${tool}] ${durationMs}ms ${result ? JSON.stringify(result) : ''}`)
    },
    onToolError({ tool, durationMs, errorCode, error }) {
      console.info(
        `  [${tool}] ${durationMs}ms ERROR ${errorCode}: ${error.publicMessage ?? error.message}`,
      )
    },
  },
})

const tracker = createTrackerMcpServer({
  core,
  auth: async () => ({ actor: 'smoke-live', write: writeEnabled }),
})

const httpServer = Bun.serve({
  port: 0,
  // The first tool call on a cold cache runs a full provider sync, which can
  // exceed Bun's default 10s idle timeout and surface as ECONNRESET.
  idleTimeout: 120,
  fetch: (req) => tracker.fetch(req),
})
const url = new URL(`http://127.0.0.1:${httpServer.port}/mcp`)
const transport = new StreamableHTTPClientTransport(url)
const client = new Client({ name: 'smoke-live', version: '1.0.0' })
await client.connect(transport)

function unwrap<T>(result: Awaited<ReturnType<Client['callTool']>>): T {
  return (result.structuredContent as { result: T }).result
}

try {
  console.info(`\nprovider=${providerName} ticket=${ticketId} write=${writeEnabled}`)

  const tools = await client.listTools()
  console.info('\ntools:', tools.tools.map((t) => t.name).join(', '))

  console.info('\n# getTicket')
  const ticket = unwrap<{ id: string; title: string; column_id?: string }>(
    await client.callTool({ name: 'getTicket', arguments: { ticketId } }),
  )
  console.info(`  title: ${ticket.title}`)
  console.info(`  id: ${ticket.id}`)

  console.info('\n# listComments')
  const comments = unwrap<Array<{ id: string; body: string; author?: string | null }>>(
    await client.callTool({ name: 'listComments', arguments: { ticketId } }),
  )
  console.info(`  ${comments.length} comment(s)`)
  for (const c of comments.slice(-3)) {
    const snippet = c.body.length > 60 ? `${c.body.slice(0, 60)}…` : c.body
    console.info(`  - ${c.id} by ${c.author ?? '?'}: ${snippet}`)
  }

  console.info('\n# getBoard (columns only)')
  const board = unwrap<{ columns: Array<{ name: string; tasks: unknown[] }> }>(
    await client.callTool({ name: 'getBoard', arguments: {} }),
  )
  for (const col of board.columns) {
    console.info(`  ${col.name}: ${col.tasks.length} task(s)`)
  }

  if (writeEnabled) {
    console.info('\n# postComment (WRITE)')
    const postedBody = `mcp-smoke-live probe ${new Date().toISOString()}`
    const posted = unwrap<{ id: string; body: string }>(
      await client.callTool({
        name: 'postComment',
        arguments: { ticketId, body: postedBody },
      }),
    )
    console.info(`  posted id=${posted.id}`)

    console.info('\n# updateComment (WRITE)')
    const updated = unwrap<{ id: string; body: string }>(
      await client.callTool({
        name: 'updateComment',
        arguments: {
          ticketId,
          commentId: posted.id,
          body: `${postedBody} (edited)`,
        },
      }),
    )
    console.info(`  updated body: ${updated.body}`)
  } else {
    console.info('\n(skipping write ops; pass --write to exercise postComment/updateComment)')
  }

  if (moveTo) {
    console.info(`\n# moveTicket → ${moveTo} (WRITE)`)
    await client.callTool({
      name: 'moveTicket',
      arguments: { ticketId, column: moveTo },
    })
  }

  console.info('\nsmoke-live: ok')
} finally {
  await client.close()
  await tracker.close()
  // Stop the HTTP server (closing active connections) before closing the DB so
  // an in-flight tool handler can't hit a closed database.
  await httpServer.stop(true)
  db.close()
}
