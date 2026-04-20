#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import { Database } from 'bun:sqlite'
import { Client } from '@modelcontextprotocol/sdk/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createTrackerCore, createTrackerMcpServer } from '../src/mcp/index.ts'
import { createProvider } from '../src/providers/index.ts'

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

function log(...args: unknown[]): void {
  console.info(...args)
}

if (providerName !== 'jira' && providerName !== 'linear') {
  console.error(usage)
  process.exit(2)
}
if (!ticketId) {
  console.error('missing --ticket <KEY>')
  process.exit(2)
}

process.env['KANBAN_PROVIDER'] = providerName

const db = new Database(':memory:')
db.run('PRAGMA foreign_keys = ON')
const provider = createProvider(db, ':memory:')

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
      log(`  [${tool}] ${durationMs}ms ${result ? JSON.stringify(result) : ''}`)
    },
    onToolError({ tool, durationMs, errorCode, error }) {
      log(`  [${tool}] ${durationMs}ms ERROR ${errorCode}: ${error.publicMessage ?? error.message}`)
    },
  },
})

const tracker = createTrackerMcpServer({
  core,
  auth: async () => ({ actor: 'smoke-live', write: writeEnabled }),
})

const httpServer = Bun.serve({
  port: 0,
  fetch: (req) => tracker.fetch(req),
})
const url = new URL(`http://127.0.0.1:${httpServer.port}/mcp`)
const transport = new StreamableHTTPClientTransport(url)
const client = new Client({ name: 'smoke-live', version: '1.0.0' })
await client.connect(transport)

function unwrap<T>(result: { structuredContent?: unknown }): T {
  return (result.structuredContent as { result: T }).result
}

try {
  log(`\nprovider=${providerName} ticket=${ticketId} write=${writeEnabled}`)

  const tools = await client.listTools()
  log('\ntools:', tools.tools.map((t) => t.name).join(', '))

  log('\n# getTicket')
  const ticket = unwrap<{ id: string; title: string; column_id?: string }>(
    await client.callTool({ name: 'getTicket', arguments: { ticketId } }),
  )
  log(`  title: ${ticket.title}`)
  log(`  id: ${ticket.id}`)

  log('\n# listComments')
  const comments = unwrap<Array<{ id: string; body: string; author?: string | null }>>(
    await client.callTool({ name: 'listComments', arguments: { ticketId } }),
  )
  log(`  ${comments.length} comment(s)`)
  for (const c of comments.slice(-3)) {
    const snippet = c.body.length > 60 ? `${c.body.slice(0, 60)}…` : c.body
    log(`  - ${c.id} by ${c.author ?? '?'}: ${snippet}`)
  }

  log('\n# getBoard (columns only)')
  const board = unwrap<{ columns: Array<{ name: string; tasks: unknown[] }> }>(
    await client.callTool({ name: 'getBoard', arguments: {} }),
  )
  for (const col of board.columns) {
    log(`  ${col.name}: ${col.tasks.length} task(s)`)
  }

  if (writeEnabled) {
    log('\n# postComment (WRITE)')
    const postedBody = `mcp-smoke-live probe ${new Date().toISOString()}`
    const posted = unwrap<{ id: string; body: string }>(
      await client.callTool({
        name: 'postComment',
        arguments: { ticketId, body: postedBody },
      }),
    )
    log(`  posted id=${posted.id}`)

    log('\n# updateComment (WRITE)')
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
    log(`  updated body: ${updated.body}`)
  } else {
    log('\n(skipping write ops; pass --write to exercise postComment/updateComment)')
  }

  if (moveTo) {
    log(`\n# moveTicket → ${moveTo} (WRITE)`)
    await client.callTool({
      name: 'moveTicket',
      arguments: { ticketId, column: moveTo },
    })
  }

  log('\nsmoke-live: ok')
} finally {
  await client.close()
  await tracker.close()
  httpServer.stop(true)
  db.close()
}
