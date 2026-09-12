import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  Client,
  StreamableHTTPClientTransport,
  isJSONRPCRequest,
  parseJSONRPCMessage,
  PROTOCOL_VERSION_META_KEY,
  CLIENT_INFO_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
  SERVER_INFO_META_KEY,
  type ClientOptions,
} from '@modelcontextprotocol/client'
import { addTask, initSchema, seedDefaultColumns } from '../db'
import { createTrackerCore, createTrackerMcpServer, TrackerMcpError } from '../mcp/index'
import type { TrackerMcpHooks, TrackerMcpTool } from '../mcp/types'
import { LocalProvider } from '../providers/local'
import { VERSION } from '../version'
import type { TaskComment } from '../types'

interface TestScope {
  actor: string
}

interface RecordedExchange {
  request: ReturnType<Request['clone']>
  responseHeaders: Headers
}

interface TestServerOptions {
  tools?: TrackerMcpTool<TestScope>[]
  hooks?: TrackerMcpHooks<TestScope>
}

interface OutputSchemaCase {
  name: string
  schema: NonNullable<TrackerMcpTool<TestScope>['outputSchema']>
  result: string | { value: string }
}

const outputSchemaCases = [
  {
    name: 'object',
    schema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
    result: { value: 'validated object' },
  },
  { name: 'string', schema: { type: 'string' }, result: 'validated string' },
  {
    name: 'object with local $defs reference',
    schema: {
      $defs: { value: { type: 'string' } },
      type: 'object',
      properties: { value: { $ref: '#/$defs/value' } },
      required: ['value'],
      additionalProperties: false,
    },
    result: { value: 'local definition' },
  },
  {
    name: 'root $ref',
    schema: { $defs: { value: { type: 'string' } }, $ref: '#/$defs/value' },
    result: 'root reference',
  },
  {
    name: 'declared draft-07 with local definitions',
    schema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      definitions: { value: { type: 'string' } },
      type: 'object',
      properties: { value: { $ref: '#/definitions/value' } },
      required: ['value'],
      additionalProperties: false,
    },
    result: { value: 'draft-07 definition' },
  },
] satisfies OutputSchemaCase[]

const MODERN_PROTOCOL_VERSION = '2026-07-28'

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

function discoverBody() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'server/discover',
    params: {
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
        [CLIENT_INFO_META_KEY]: { name: 'agent-kanban-test-client', version: '1.0.0' },
        [CLIENT_CAPABILITIES_META_KEY]: {},
      },
    },
  }
}

function openingBody(protocolVersion: string) {
  if (protocolVersion === MODERN_PROTOCOL_VERSION) return discoverBody()
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion,
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
  options: TestServerOptions = {},
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
    hooks: options.hooks,
  })

  const tracker = createTrackerMcpServer({
    core,
    tools: options.tools,
    auth: async ({ headers }) => {
      const authHeader = headers.get('authorization')
      if (authHeader === 'Bearer good-token') return { actor: 'tester' }
      if (authHeader === 'Bearer other-token') return { actor: 'other' }
      throw new TrackerMcpError({
        code: 'auth_failed',
        publicMessage: 'unauthenticated',
      })
    },
  })

  const exchanges: RecordedExchange[] = []
  const httpServer = Bun.serve({
    port: 0,
    async fetch(request) {
      const recordedRequest = request.clone()
      const response = await tracker.fetch(request)
      exchanges.push({ request: recordedRequest, responseHeaders: response.headers })
      return response
    },
  })

  const url = new URL(`http://127.0.0.1:${httpServer.port}/mcp`)

  return {
    core,
    tracker,
    httpServer,
    url,
    exchanges,
    async close() {
      await tracker.close()
      void httpServer.stop(true)
    },
  }
}

describe.each(['2025-03-26', MODERN_PROTOCOL_VERSION])(
  'createTrackerMcpServer (%s)',
  (protocolVersion) => {
    const modern = protocolVersion === MODERN_PROTOCOL_VERSION
    const clientOptions: ClientOptions = modern
      ? { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } }
      : { supportedProtocolVersions: [protocolVersion] }

    for (const fixture of outputSchemaCases) {
      test(`round-trips custom ${fixture.name} output through SDK schema validation`, async () => {
        const runtime = startTrackerServer(
          {},
          {
            tools: [
              {
                name: 'customOutput',
                description: 'Return a schema-validated custom result.',
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                outputSchema: fixture.schema,
                handler: async () => fixture.result,
              },
            ],
          },
        )
        const client = new Client({ name: 'output-schema-test', version: '1.0.0' }, clientOptions)
        const transport = new StreamableHTTPClientTransport(runtime.url, {
          requestInit: { headers: { Authorization: 'Bearer good-token' } },
        })

        try {
          await client.connect(transport)
          const tools = await client.listTools()
          expect(tools.tools[0]?.outputSchema).toBeDefined()
          // listTools installs the advertised schema in the real SDK client validator.
          const result = await client.callTool({ name: 'customOutput', arguments: {} })
          expect(result.structuredContent).toEqual({ result: fixture.result })
        } finally {
          await client.close()
          await runtime.close()
        }
      })
    }

    test('rejects invalid raw custom output and reports its error hook', async () => {
      const reported: Parameters<NonNullable<TrackerMcpHooks<TestScope>['onToolError']>>[0][] = []
      const runtime = startTrackerServer(
        {},
        {
          tools: [
            {
              name: 'invalidOutput',
              description: 'Return an invalid result to exercise output validation.',
              inputSchema: { type: 'object', properties: {}, additionalProperties: false },
              outputSchema: { type: 'string' },
              handler: async () => 42,
            },
          ],
          hooks: {
            onToolError(event) {
              reported.push(event)
            },
          },
        },
      )
      const client = new Client({ name: 'invalid-output-test', version: '1.0.0' }, clientOptions)
      const transport = new StreamableHTTPClientTransport(runtime.url, {
        requestInit: { headers: { Authorization: 'Bearer good-token' } },
      })

      try {
        await client.connect(transport)
        await client.listTools()
        await expect(
          client.callTool({ name: 'invalidOutput', arguments: {} }),
        ).rejects.toMatchObject({
          code: -32602,
          data: { trackerMcpCode: 'validation_failed' },
        })
        expect(reported).toMatchObject([
          {
            tool: 'invalidOutput',
            errorCode: 'validation_failed',
            scope: { actor: 'tester' },
          },
        ])
        expect(reported).toHaveLength(1)
      } finally {
        await client.close()
        await runtime.close()
      }
    })

    test('serves tools over Streamable HTTP and round-trips a tool call through auth, policy, and provider', async () => {
      const task = addTask(db, 'MCP task')
      const runtime = startTrackerServer()
      const transport = new StreamableHTTPClientTransport(runtime.url, {
        requestInit: { headers: { Authorization: 'Bearer good-token' } },
      })
      const client = new Client({ name: 'test-client', version: '1.0.0' }, clientOptions)

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

        expect(result.structuredContent).toMatchObject({
          result: { id: task.id, title: 'MCP task' },
        })
        expect(client.getProtocolEra()).toBe(modern ? 'modern' : 'legacy')

        const exchanges = runtime.exchanges.filter(({ request }) => request.method === 'POST')
        const messages = await Promise.all(
          exchanges.map(async ({ request }) => parseJSONRPCMessage(await request.json())),
        )
        const requests = messages.filter(isJSONRPCRequest)
        const methods = requests.map((message) => message.method)
        if (modern) {
          expect(methods).toContain('server/discover')
          expect(methods).not.toContain('initialize')
          for (const message of requests) {
            expect(message.params).toHaveProperty(
              ['_meta', PROTOCOL_VERSION_META_KEY],
              protocolVersion,
            )
          }
          for (const exchange of exchanges) {
            expect(exchange.request.headers.get('mcp-session-id')).toBeNull()
            expect(exchange.responseHeaders.get('mcp-session-id')).toBeNull()
            expect(exchange.request.headers.get('mcp-protocol-version')).toBe(protocolVersion)
          }
        } else {
          expect(methods).toContain('initialize')
          expect(methods).not.toContain('server/discover')
          expect(requests.find((message) => message.method === 'initialize')).toHaveProperty(
            'params.protocolVersion',
            protocolVersion,
          )
        }
      } finally {
        await client.close()
        await runtime.close()
      }
    })

    test('advertises the package version rather than a hard-coded one', async () => {
      const runtime = startTrackerServer()
      const transport = new StreamableHTTPClientTransport(runtime.url, {
        requestInit: { headers: { Authorization: 'Bearer good-token' } },
      })
      const client = new Client({ name: 'test-client', version: '1.0.0' }, clientOptions)

      try {
        await client.connect(transport)
        expect(client.getServerVersion()?.version).toBe(VERSION)
      } finally {
        await client.close()
        await runtime.close()
      }
    })

    test('round-trips updateComment end-to-end, handing the existing comment to the policy', async () => {
      const task = addTask(db, 'MCP task')
      const created = await provider.comment(task.id, 'original body')
      const seenExisting: Partial<Pick<TaskComment, 'id' | 'body'>> = {}
      const runtime = startTrackerServer({
        canUpdateComment(_scope, _ticketId, comment) {
          seenExisting.id = comment.id
          seenExisting.body = comment.body
        },
      })
      const transport = new StreamableHTTPClientTransport(runtime.url, {
        requestInit: { headers: { Authorization: 'Bearer good-token' } },
      })
      const client = new Client({ name: 'test-client', version: '1.0.0' }, clientOptions)

      try {
        await client.connect(transport)
        const result = await client.callTool({
          name: 'updateComment',
          arguments: { ticketId: task.id, commentId: created.id, body: 'rewritten' },
        })
        expect(result.structuredContent).toMatchObject({
          result: { id: created.id, body: 'rewritten' },
        })
        expect(seenExisting).toEqual({ id: created.id, body: 'original body' })
      } finally {
        await client.close()
        await runtime.close()
      }
    })

    test('returns HTTP 401 before protocol dispatch when auth fails', async () => {
      const runtime = startTrackerServer()

      try {
        const response = await fetch(runtime.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(openingBody(protocolVersion)),
        })
        const body = await response.json()

        expect(response.status).toBe(401)
        expect(body).toHaveProperty('error', {
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
      const client = new Client({ name: 'test-client', version: '1.0.0' }, clientOptions)

      try {
        await client.connect(transport)
        try {
          await client.callTool({
            name: 'moveTicket',
            arguments: { ticketId: task.id, column: 'done' },
          })
          throw new Error('Expected moveTicket to fail')
        } catch (error) {
          expect(error).toHaveProperty('code', -32012)
          expect(error).toHaveProperty('message', expect.stringContaining('forbidden_column'))
          expect(error).toHaveProperty('data.trackerMcpCode', 'policy_denied')
        }
      } finally {
        await client.close()
        await runtime.close()
      }
    })

    test('rejects invalid tool arguments before policy and keeps serving valid calls', async () => {
      const task = addTask(db, 'Validated task')
      let policyCalls = 0
      const runtime = startTrackerServer({
        canReadTicket() {
          policyCalls++
        },
      })
      const client = new Client({ name: 'schema-test', version: '1.0.0' }, clientOptions)
      const transport = new StreamableHTTPClientTransport(runtime.url, {
        requestInit: { headers: { Authorization: 'Bearer good-token' } },
      })

      try {
        await client.connect(transport)
        await expect(
          client.callTool({ name: 'getTicket', arguments: { ticketId: 42 } }),
        ).rejects.toMatchObject({ code: -32602, data: { trackerMcpCode: 'validation_failed' } })
        await expect(
          client.callTool({ name: 'getTicket', arguments: { ticketId: task.id, extra: true } }),
        ).rejects.toMatchObject({ code: -32602, data: { trackerMcpCode: 'validation_failed' } })
        expect(policyCalls).toBe(0)

        const result = await client.callTool({
          name: 'getTicket',
          arguments: { ticketId: task.id },
        })
        expect(result.structuredContent).toMatchObject({ result: { id: task.id } })
        expect(policyCalls).toBe(1)
      } finally {
        await client.close()
        await runtime.close()
      }
    })

    test('isolates concurrent authenticated scopes and ignores client-reported identity', async () => {
      const testerTask = addTask(db, 'Tester task')
      const otherTask = addTask(db, 'Other task')
      const owners = new Map([
        [testerTask.id, 'tester'],
        [otherTask.id, 'other'],
      ])
      const runtime = startTrackerServer({
        canReadTicket(scope, ticketId) {
          if (owners.get(ticketId) !== scope.actor) {
            throw new TrackerMcpError({ code: 'policy_denied', publicMessage: 'wrong_owner' })
          }
        },
      })
      // Client names intentionally claim the other actor; authorization comes from each token.
      const testerClient = new Client({ name: 'other', version: '1.0.0' }, clientOptions)
      const otherClient = new Client({ name: 'tester', version: '1.0.0' }, clientOptions)

      try {
        await Promise.all([
          testerClient.connect(
            new StreamableHTTPClientTransport(runtime.url, {
              requestInit: { headers: { Authorization: 'Bearer good-token' } },
            }),
          ),
          otherClient.connect(
            new StreamableHTTPClientTransport(runtime.url, {
              requestInit: { headers: { Authorization: 'Bearer other-token' } },
            }),
          ),
        ])
        const [testerResult, otherResult] = await Promise.all([
          testerClient.callTool({ name: 'getTicket', arguments: { ticketId: testerTask.id } }),
          otherClient.callTool({ name: 'getTicket', arguments: { ticketId: otherTask.id } }),
        ])
        expect(testerResult.structuredContent).toMatchObject({ result: { id: testerTask.id } })
        expect(otherResult.structuredContent).toMatchObject({ result: { id: otherTask.id } })
        await expect(
          otherClient.callTool({ name: 'getTicket', arguments: { ticketId: testerTask.id } }),
        ).rejects.toMatchObject({ code: -32012, data: { trackerMcpCode: 'policy_denied' } })
        await expect(
          testerClient.callTool({ name: 'getTicket', arguments: { ticketId: otherTask.id } }),
        ).rejects.toMatchObject({ code: -32012, data: { trackerMcpCode: 'policy_denied' } })
      } finally {
        await Promise.all([testerClient.close(), otherClient.close()])
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
          body: JSON.stringify(openingBody(protocolVersion)),
        })
        const body = await response.json()

        expect(response.status).toBe(503)
        expect(body).toHaveProperty('error', {
          code: -32000,
          message: 'Tracker MCP server is closed',
        })
      } finally {
        void runtime.httpServer.stop(true)
      }
    })
  },
)

test('raw modern discovery and tool calls require neither initialize nor a session', async () => {
  const task = addTask(db, 'Raw modern task')
  const runtime = startTrackerServer()
  const discovery = discoverBody()
  const headers = {
    Authorization: 'Bearer good-token',
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': MODERN_PROTOCOL_VERSION,
    'Mcp-Method': 'server/discover',
  }

  try {
    const discoveryResponse = await fetch(runtime.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(discovery),
    })
    expect(discoveryResponse.status).toBe(200)
    expect(discoveryResponse.headers.get('mcp-session-id')).toBeNull()
    const discovered = await discoveryResponse.json()
    expect(discovered).toHaveProperty(
      'result.supportedVersions',
      expect.arrayContaining([MODERN_PROTOCOL_VERSION]),
    )
    expect(discovered).toHaveProperty('result.capabilities.tools', {})
    expect(discovered).toHaveProperty(['result', '_meta', SERVER_INFO_META_KEY], {
      name: 'agent-kanban-tracker-mcp',
      version: VERSION,
    })

    const called = await fetch(runtime.url, {
      method: 'POST',
      headers: { ...headers, 'Mcp-Method': 'tools/call', 'Mcp-Name': 'getTicket' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { ...discovery.params, name: 'getTicket', arguments: { ticketId: task.id } },
      }),
    })
    expect(called.status).toBe(200)
    expect(called.headers.get('mcp-session-id')).toBeNull()
    expect(await called.json()).toMatchObject({
      id: 2,
      result: { resultType: 'complete', structuredContent: { result: { id: task.id } } },
    })
  } finally {
    await runtime.close()
  }
})
