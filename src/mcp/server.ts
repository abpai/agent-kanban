import { Server } from '@modelcontextprotocol/sdk/server'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import {
  CallToolRequestSchema,
  ErrorCode as JsonRpcErrorCode,
  ListToolsRequestSchema,
  McpError,
  isInitializeRequest,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import type {
  JsonSchemaValidatorResult,
  JsonSchemaType,
} from '@modelcontextprotocol/sdk/validation'
import type { TrackerCore } from './core.ts'
import { TrackerMcpError, toMcpError, toTrackerMcpError, trackerMcpJsonRpcCode } from './errors.ts'
import type { TrackerMcpAuthResolver, TrackerMcpServer, TrackerMcpTool } from './types.ts'

const EMPTY_OBJECT_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as JsonSchemaType

interface RegisteredTrackerTool<TScope> {
  tool: TrackerMcpTool<TScope>
  validateInput(input: unknown): JsonSchemaValidatorResult<unknown>
  validateOutput?(output: unknown): JsonSchemaValidatorResult<unknown>
}

interface SessionEntry<TScope> {
  server: Server
  transport: WebStandardStreamableHTTPServerTransport
  sessionId?: string
  tools: Map<string, RegisteredTrackerTool<TScope>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function ticketIdFromArgs(args: unknown): string | undefined {
  if (!isRecord(args) || typeof args.ticketId !== 'string') return undefined
  return args.ticketId
}

function serializeToolResult(result: unknown): string {
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result ?? null)
  } catch {
    return String(result)
  }
}

function toCallToolResult(result: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: serializeToolResult(result) }],
    structuredContent: { result: result ?? null },
  }
}

function httpJsonRpcError(status: number, code: number, message: string): Response {
  return Response.json(
    {
      jsonrpc: '2.0',
      error: { code, message },
      id: null,
    },
    { status },
  )
}

function ticketIdSchema(extra: Record<string, JsonSchemaType> = {}): JsonSchemaType {
  return {
    type: 'object',
    properties: { ticketId: { type: 'string' }, ...extra },
    required: ['ticketId', ...Object.keys(extra)],
    additionalProperties: false,
  } as JsonSchemaType
}

export function defaultTools<TScope>(core: TrackerCore<TScope>): TrackerMcpTool<TScope>[] {
  return [
    {
      name: 'getTicket',
      description: 'Fetch a ticket by id.',
      inputSchema: ticketIdSchema(),
      handler: ({ scope, args }) =>
        core.handlers.getTicket({ scope, ...(args as { ticketId: string }) }),
    },
    {
      name: 'listComments',
      description: 'List comments for a ticket.',
      inputSchema: ticketIdSchema(),
      handler: ({ scope, args }) =>
        core.handlers.listComments({ scope, ...(args as { ticketId: string }) }),
    },
    {
      name: 'getBoard',
      description: 'Fetch the current board state.',
      inputSchema: EMPTY_OBJECT_SCHEMA,
      handler: ({ scope }) => core.handlers.getBoard({ scope }),
    },
    {
      name: 'postComment',
      description: 'Create a comment on a ticket.',
      inputSchema: ticketIdSchema({ body: { type: 'string' } as JsonSchemaType }),
      handler: ({ scope, args }) =>
        core.handlers.postComment({ scope, ...(args as { ticketId: string; body: string }) }),
    },
    {
      name: 'updateComment',
      description: 'Update an existing ticket comment.',
      inputSchema: ticketIdSchema({
        commentId: { type: 'string' } as JsonSchemaType,
        body: { type: 'string' } as JsonSchemaType,
      }),
      handler: ({ scope, args }) =>
        core.handlers.updateComment({
          scope,
          ...(args as { ticketId: string; commentId: string; body: string }),
        }),
    },
    {
      name: 'moveTicket',
      description: 'Move a ticket to another column.',
      inputSchema: ticketIdSchema({ column: { type: 'string' } as JsonSchemaType }),
      handler: ({ scope, args }) =>
        core.handlers.moveTicket({
          scope,
          ...(args as { ticketId: string; column: string }),
        }),
    },
  ]
}

function registerTools<TScope>(
  tools: TrackerMcpTool<TScope>[],
): Map<string, RegisteredTrackerTool<TScope>> {
  const validatorProvider = new AjvJsonSchemaValidator()
  const registry = new Map<string, RegisteredTrackerTool<TScope>>()

  for (const tool of tools) {
    if (registry.has(tool.name)) {
      throw new Error(`Duplicate tracker MCP tool name '${tool.name}'`)
    }
    registry.set(tool.name, {
      tool,
      validateInput: validatorProvider.getValidator(tool.inputSchema),
      validateOutput: tool.outputSchema
        ? validatorProvider.getValidator(tool.outputSchema)
        : undefined,
    })
  }

  return registry
}

function isInitializePayload(body: unknown): boolean {
  return Array.isArray(body)
    ? body.some((message) => isInitializeRequest(message))
    : isInitializeRequest(body)
}

function createSessionServer<TScope>(
  core: TrackerCore<TScope>,
  entry: SessionEntry<TScope>,
): Server {
  const server = new Server(
    { name: 'agent-kanban-tracker-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  async function throwReportedToolError(input: {
    scope: TScope | null
    tool: string
    startedAt: number
    args?: unknown
    error: TrackerMcpError
  }): Promise<never> {
    await core.notifyToolError({
      scope: input.scope,
      tool: input.tool,
      ticketId: ticketIdFromArgs(input.args),
      durationMs: Date.now() - input.startedAt,
      error: input.error,
    })
    throw toMcpError(input.error)
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Array.from(entry.tools.values()).map(({ tool }) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const registered = entry.tools.get(request.params.name)
    const rawScope = extra.authInfo?.extra?.['scope']
    const rawRequest = extra.authInfo?.extra?.['request']
    const scope = rawScope as TScope | null
    const originalRequest = rawRequest instanceof Request ? rawRequest : null
    const startedAt = Date.now()

    if (!registered) {
      const error = new TrackerMcpError({
        code: 'validation_failed',
        publicMessage: `Unknown tool '${request.params.name}'`,
      })
      return throwReportedToolError({
        scope,
        tool: request.params.name,
        startedAt,
        args: request.params.arguments,
        error,
      })
    }

    if (!scope || !originalRequest) {
      throw new McpError(JsonRpcErrorCode.InternalError, 'Missing authenticated request context')
    }

    const tool = registered
    const validated = tool.validateInput(request.params.arguments ?? {})
    if (!validated.valid) {
      const error = new TrackerMcpError({
        code: 'validation_failed',
        publicMessage: validated.errorMessage ?? `Invalid arguments for '${tool.tool.name}'`,
      })
      return throwReportedToolError({
        scope,
        tool: tool.tool.name,
        startedAt,
        args: request.params.arguments,
        error,
      })
    }

    let result: unknown
    try {
      result = await tool.tool.handler({
        scope,
        args: validated.data as Record<string, unknown>,
        request: originalRequest,
      })
    } catch (error) {
      throw toMcpError(error)
    }

    if (tool.validateOutput) {
      const validatedOutput = tool.validateOutput(result)
      if (!validatedOutput.valid) {
        const error = new TrackerMcpError({
          code: 'validation_failed',
          publicMessage: validatedOutput.errorMessage ?? `Invalid output for '${tool.tool.name}'`,
        })
        return throwReportedToolError({
          scope,
          tool: tool.tool.name,
          startedAt,
          args: request.params.arguments,
          error,
        })
      }
    }

    return toCallToolResult(result)
  })

  return server
}

export function createTrackerMcpServer<TScope>(input: {
  core: TrackerCore<TScope>
  auth: TrackerMcpAuthResolver<TScope>
  tools?: 'default' | TrackerMcpTool<TScope>[]
}): TrackerMcpServer {
  const tools =
    input.tools === 'default' || input.tools === undefined ? defaultTools(input.core) : input.tools

  const toolRegistry = registerTools(tools)
  const sessions = new Map<string, SessionEntry<TScope>>()
  const inflight = new Set<Promise<unknown>>()
  let closed = false

  async function trackInflight<T>(promise: Promise<T>): Promise<T> {
    inflight.add(promise)
    try {
      return await promise
    } finally {
      inflight.delete(promise)
    }
  }

  async function parsePostBody(request: Request): Promise<unknown> {
    try {
      return await request.json()
    } catch (error) {
      throw new TrackerMcpError({
        code: 'validation_failed',
        publicMessage: 'Invalid JSON request body',
        cause: error,
      })
    }
  }

  async function authenticate(request: Request): Promise<{
    scope: TScope
    authInfo: {
      token: string
      clientId: string
      scopes: string[]
      extra: Record<string, unknown>
    }
  }> {
    try {
      const scope = await input.auth({
        request,
        url: new URL(request.url),
        headers: request.headers,
      })
      return {
        scope,
        authInfo: {
          token: 'tracker-mcp',
          clientId: 'tracker-mcp',
          scopes: [],
          extra: {
            scope,
            request,
          },
        },
      }
    } catch (error) {
      if (error instanceof TrackerMcpError && error.code === 'auth_failed') throw error
      throw new TrackerMcpError({
        code: 'auth_failed',
        publicMessage:
          error instanceof TrackerMcpError
            ? (error.publicMessage ?? error.message)
            : 'Authentication failed',
        cause: error,
      })
    }
  }

  async function createSession(): Promise<SessionEntry<TScope>> {
    const entry = {} as SessionEntry<TScope>
    entry.tools = toolRegistry
    entry.transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sessionId) => {
        entry.sessionId = sessionId
        sessions.set(sessionId, entry)
      },
    })
    entry.server = createSessionServer(input.core, entry)
    entry.transport.onclose = () => {
      if (entry.sessionId) sessions.delete(entry.sessionId)
    }
    await entry.server.connect(entry.transport)
    return entry
  }

  async function handleAuthenticatedRequest(request: Request): Promise<Response> {
    const method = request.method.toUpperCase()
    const { authInfo } = await authenticate(request)
    const sessionId = request.headers.get('mcp-session-id')

    if (method === 'POST') {
      const parsedBody = await parsePostBody(request)

      if (sessionId) {
        const existing = sessions.get(sessionId)
        if (!existing) {
          return httpJsonRpcError(
            404,
            trackerMcpJsonRpcCode('validation_failed'),
            'Session not found',
          )
        }
        return existing.transport.handleRequest(request, { parsedBody, authInfo })
      }

      if (!isInitializePayload(parsedBody)) {
        return httpJsonRpcError(
          400,
          trackerMcpJsonRpcCode('validation_failed'),
          'Initialization required before calling tools',
        )
      }

      const entry = await createSession()
      return entry.transport.handleRequest(request, { parsedBody, authInfo })
    }

    if (method === 'GET' || method === 'DELETE') {
      if (!sessionId) {
        return httpJsonRpcError(
          400,
          trackerMcpJsonRpcCode('validation_failed'),
          'Session ID header is required',
        )
      }
      const existing = sessions.get(sessionId)
      if (!existing) {
        return httpJsonRpcError(
          404,
          trackerMcpJsonRpcCode('validation_failed'),
          'Session not found',
        )
      }
      return existing.transport.handleRequest(request, { authInfo })
    }

    return httpJsonRpcError(
      405,
      JsonRpcErrorCode.InvalidRequest,
      `Unsupported MCP HTTP method '${request.method}'`,
    )
  }

  return {
    async fetch(request: Request): Promise<Response> {
      if (closed) {
        return httpJsonRpcError(
          503,
          JsonRpcErrorCode.ConnectionClosed,
          'Tracker MCP server is closed',
        )
      }

      const responsePromise = (async () => {
        const authStartedAt = Date.now()
        try {
          return await handleAuthenticatedRequest(request)
        } catch (error) {
          const trackerError = toTrackerMcpError(error)
          if (trackerError.code === 'auth_failed') {
            await input.core.notifyAuthFailure({
              request,
              durationMs: Date.now() - authStartedAt,
              error: trackerError,
            })
            return httpJsonRpcError(
              401,
              trackerMcpJsonRpcCode('auth_failed'),
              trackerError.publicMessage ?? 'Unauthenticated',
            )
          }

          if (trackerError.code === 'validation_failed') {
            return httpJsonRpcError(
              400,
              trackerMcpJsonRpcCode('validation_failed'),
              trackerError.publicMessage ?? trackerError.message,
            )
          }

          return httpJsonRpcError(
            500,
            trackerMcpJsonRpcCode(trackerError.code),
            trackerError.publicMessage ?? trackerError.message,
          )
        }
      })()

      return trackInflight(responsePromise)
    },

    async selfPing(): Promise<void> {
      if (closed) {
        throw new Error('Tracker MCP server is closed')
      }
    },

    async close(signal?: globalThis.AbortSignal): Promise<void> {
      closed = true

      const closeAll = (async () => {
        const entries = Array.from(sessions.values())
        await Promise.allSettled(entries.map((entry) => entry.server.close()))
        await Promise.allSettled(Array.from(inflight))
      })()

      if (!signal) {
        await closeAll
        return
      }

      const abortPromise = new Promise<never>((_, reject) => {
        if (signal.aborted) {
          reject(signal.reason ?? new Error('Tracker MCP close aborted'))
          return
        }
        signal.addEventListener(
          'abort',
          () => reject(signal.reason ?? new Error('Tracker MCP close aborted')),
          { once: true },
        )
      })

      await Promise.race([closeAll, abortPromise])
    },
  }
}
