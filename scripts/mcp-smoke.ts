#!/usr/bin/env bun
import { Database } from 'bun:sqlite'
import { Client } from '@modelcontextprotocol/sdk/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { addTask, initSchema, seedDefaultColumns } from '../src/db'
import { createTrackerCore, createTrackerMcpServer } from '../src/mcp/index'
import { LocalProvider } from '../src/providers/local'

const db = new Database(':memory:')
db.run('PRAGMA foreign_keys = ON')
initSchema(db)
seedDefaultColumns(db)
const provider = new LocalProvider(db, ':memory:')

const seed = addTask(db, 'Smoke ticket')

const core = createTrackerCore<{ actor: string }>({
  provider,
  policy: {
    canReadTicket() {},
    canPostComment() {},
    canUpdateComment() {},
    canMoveTicket() {},
  },
})

const tracker = createTrackerMcpServer({
  core,
  auth: async () => ({ actor: 'smoke' }),
})

const httpServer = Bun.serve({
  port: 0,
  fetch: (req) => tracker.fetch(req),
})
const url = new URL(`http://127.0.0.1:${httpServer.port}/mcp`)

const transport = new StreamableHTTPClientTransport(url)
const client = new Client({ name: 'smoke', version: '1.0.0' })

function unwrap<T>(result: { structuredContent?: unknown }): T {
  return (result.structuredContent as { result: T }).result
}

function log(label: string, value: string): void {
  console.info(label, value)
}

await client.connect(transport)

try {
  const tools = await client.listTools()
  log('tools:', tools.tools.map((t) => t.name).join(', '))

  const getTicket = unwrap<{ id: string; title: string }>(
    await client.callTool({ name: 'getTicket', arguments: { ticketId: seed.id } }),
  )
  log('getTicket:', getTicket.title)

  const board = unwrap<{ columns: Array<{ name: string }> }>(
    await client.callTool({ name: 'getBoard', arguments: {} }),
  )
  log('getBoard columns:', board.columns.map((column) => column.name).join(', '))

  const posted = unwrap<{ id: string }>(
    await client.callTool({
      name: 'postComment',
      arguments: { ticketId: seed.id, body: 'hello from smoke' },
    }),
  )
  log('postComment id:', posted.id)

  const list = unwrap<Array<{ body: string }>>(
    await client.callTool({ name: 'listComments', arguments: { ticketId: seed.id } }),
  )
  log('listComments bodies:', list.map((comment) => comment.body).join(' | '))

  const updated = unwrap<{ body: string }>(
    await client.callTool({
      name: 'updateComment',
      arguments: { ticketId: seed.id, commentId: posted.id, body: 'rewritten by smoke' },
    }),
  )
  log('updateComment body:', updated.body)

  const moved = unwrap<unknown>(
    await client.callTool({
      name: 'moveTicket',
      arguments: { ticketId: seed.id, column: 'in-progress' },
    }),
  )
  log('moveTicket result:', JSON.stringify(moved))
  log('smoke:', 'ok')
} finally {
  await client.close()
  await tracker.close()
  httpServer.stop(true)
  db.close()
}
