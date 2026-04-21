import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Client } from '@modelcontextprotocol/sdk/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { addTask, initSchema, seedDefaultColumns } from '../db.ts'
import { createTrackerCore, createTrackerMcpServer, TrackerMcpError } from '../mcp/index.ts'
import { LocalProvider } from '../providers/local.ts'

interface TestScope {
  actor: string
}

let db: Database
let provider: LocalProvider

beforeEach(() => {
  db = new Database(':memory:')
  db.run('PRAGMA foreign_keys = ON')
  initSchema(db)
  seedDefaultColumns(db)
  provider = new LocalProvider(db, ':memory:')
})

afterEach(() => {
  db.close()
})

function initializeBody() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: {
        name: 'agent-kanban-test-client',
        version: '1.0.0',
      },
    },
  }
}

function startTrackerServer(
  policyOverrides: Partial<Parameters<typeof createTrackerCore<TestScope>>[0]['policy']> = {},
) {
  const core = createTrackerCore<TestScope>({
    provider,
    policy: {
      canReadTicket() {},
      canPostComment() {},
      canUpdateComment() {},
      canMoveTicket() {},
      ...policyOverrides,
    },
  })

  const tracker = createTrackerMcpServer({
    core,
    auth: async ({ headers }) => {
      const authHeader = headers.get('authorization')
      if (authHeader !== 'Bearer good-token') {
        throw new TrackerMcpError({
          code: 'auth_failed',
          publicMessage: 'unauthenticated',
        })
      }
      return { actor: 'tester' }
    },
  })

  const httpServer = Bun.serve({
    port: 0,
    fetch(request) {
      return tracker.fetch(request)
    },
  })

  const url = new URL(`http://127.0.0.1:${httpServer.port}/mcp`)

  return {
    core,
    tracker,
    httpServer,
    url,
    async close() {
      await tracker.close()
      httpServer.stop(true)
    },
  }
}

describe('createTrackerMcpServer', () => {
  test('serves tools over Streamable HTTP and round-trips a tool call through auth, policy, and provider', async () => {
    const task = addTask(db, 'MCP task')
    const runtime = startTrackerServer()
    const transport = new StreamableHTTPClientTransport(runtime.url, {
      requestInit: { headers: { Authorization: 'Bearer good-token' } },
    })
    const client = new Client({ name: 'test-client', version: '1.0.0' })

    try {
      await client.connect(transport)
      const tools = await client.listTools()
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        'getTicket',
        'listComments',
        'getBoard',
        'postComment',
        'updateComment',
        'moveTicket',
      ])

      const result = await client.callTool({
        name: 'getTicket',
        arguments: { ticketId: task.id },
      })

      expect(
        (result.structuredContent as { result: { id: string; title: string } }).result,
      ).toEqual(
        expect.objectContaining({
          id: task.id,
          title: 'MCP task',
        }),
      )
    } finally {
      await client.close()
      await runtime.close()
    }
  })

  test('round-trips updateComment end-to-end, handing the existing comment to the policy', async () => {
    const task = addTask(db, 'MCP task')
    const created = await provider.comment(task.id, 'original body')
    const seenExisting: { id?: string; body?: string } = {}
    const runtime = startTrackerServer({
      canUpdateComment(_scope, _ticketId, comment) {
        seenExisting.id = comment.id
        seenExisting.body = comment.body
      },
    })
    const transport = new StreamableHTTPClientTransport(runtime.url, {
      requestInit: { headers: { Authorization: 'Bearer good-token' } },
    })
    const client = new Client({ name: 'test-client', version: '1.0.0' })

    try {
      await client.connect(transport)
      const result = await client.callTool({
        name: 'updateComment',
        arguments: { ticketId: task.id, commentId: created.id, body: 'rewritten' },
      })
      expect((result.structuredContent as { result: { id: string; body: string } }).result).toEqual(
        expect.objectContaining({
          id: created.id,
          body: 'rewritten',
        }),
      )
      expect(seenExisting).toEqual({ id: created.id, body: 'original body' })
    } finally {
      await client.close()
      await runtime.close()
    }
  })

  test('returns HTTP 401 before session creation when auth fails', async () => {
    const runtime = startTrackerServer()

    try {
      const response = await fetch(runtime.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(initializeBody()),
      })
      const body = (await response.json()) as {
        error: { code: number; message: string }
      }

      expect(response.status).toBe(401)
      expect(body.error).toEqual({
        code: -32001,
        message: 'unauthenticated',
      })
    } finally {
      await runtime.close()
    }
  })

  test('surfaces policy denial as a JSON-RPC error during tool calls', async () => {
    const task = addTask(db, 'MCP task')
    const runtime = startTrackerServer({
      canMoveTicket() {
        throw new TrackerMcpError({
          code: 'policy_denied',
          publicMessage: 'forbidden_column',
        })
      },
    })
    const transport = new StreamableHTTPClientTransport(runtime.url, {
      requestInit: { headers: { Authorization: 'Bearer good-token' } },
    })
    const client = new Client({ name: 'test-client', version: '1.0.0' })

    try {
      await client.connect(transport)
      try {
        await client.callTool({
          name: 'moveTicket',
          arguments: { ticketId: task.id, column: 'done' },
        })
        throw new Error('Expected moveTicket to fail')
      } catch (error) {
        const mcpError = error as { code?: number; message?: string }
        expect(mcpError.code).toBe(-32002)
        expect(mcpError.message).toContain('forbidden_column')
      }
    } finally {
      await client.close()
      await runtime.close()
    }
  })

  test('rejects new requests after close()', async () => {
    const runtime = startTrackerServer()

    try {
      await runtime.tracker.selfPing()
      await runtime.tracker.close()

      const response = await fetch(runtime.url, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer good-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(initializeBody()),
      })
      const body = (await response.json()) as {
        error: { code: number; message: string }
      }

      expect(response.status).toBe(503)
      expect(body.error).toEqual({
        code: -32000,
        message: 'Tracker MCP server is closed',
      })
    } finally {
      runtime.httpServer.stop(true)
    }
  })
})
