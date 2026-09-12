import {
  createMcpHandler,
  isSpecType,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type AuthInfo,
  type CallToolRequest,
  type CallToolResult,
  type JsonSchemaType,
  type JsonSchemaValidator,
  type ListToolsResult,
  type Tool,
} from '@modelcontextprotocol/server'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv'
import type { TrackerCore } from './core'
import { TrackerMcpError, toMcpError, toTrackerMcpError, trackerMcpJsonRpcCode } from './errors'
import type { TrackerMcpAuthResolver, TrackerMcpServer, TrackerMcpTool } from './types'
import { VERSION } from '../version'

const EMPTY_OBJECT_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} satisfies JsonSchemaType

interface RegisteredTrackerTool<TScope> {
  tool: TrackerMcpTool<TScope>
  definition: Tool
  validateInput: JsonSchemaValidator<Parameters<TrackerMcpTool<TScope>['handler']>[0]['args']>
  validateOutput?: JsonSchemaValidator<unknown>
}

interface TrackerRequestContext<TScope> {
  scope: TScope
  request?: Request
}

async function trackInflight<T>(promise: Promise<T>, inflight: Set<Promise<unknown>>): Promise<T> {
  inflight.add(promise)
  try {
    return await promise
  } finally {
    inflight.delete(promise)
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Error hooks inspect request arguments before the tool schema can validate them.
function ticketIdFromArgs(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null || !('ticketId' in args)) return undefined
  return typeof args.ticketId === 'string' ? args.ticketId : undefined
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Custom tools deliberately return arbitrary values; this is their MCP serialization boundary.
function serializeToolResult(result: unknown): string {
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result ?? null)
  } catch {
    return String(result)
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Serializes the public custom-tool result contract into the SDK envelope.
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
  } satisfies JsonSchemaType
}

export function defaultTools<TScope>(core: TrackerCore<TScope>): TrackerMcpTool<TScope>[] {
  return [
    {
      name: 'getTicket',
      description: 'Fetch a ticket by id.',
      inputSchema: ticketIdSchema(),
      handler: ({ scope, args }) =>
        core.handlers.getTicket({
          scope,
          ticketId: requiredStringArgument(args.ticketId, 'ticketId'),
        }),
    },
    {
      name: 'listComments',
      description: 'List comments for a ticket.',
      inputSchema: ticketIdSchema(),
      handler: ({ scope, args }) =>
        core.handlers.listComments({
          scope,
          ticketId: requiredStringArgument(args.ticketId, 'ticketId'),
        }),
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
      inputSchema: ticketIdSchema({ body: { type: 'string' } satisfies JsonSchemaType }),
      handler: ({ scope, args }) =>
        core.handlers.postComment({
          scope,
          ticketId: requiredStringArgument(args.ticketId, 'ticketId'),
          body: requiredStringArgument(args.body, 'body'),
        }),
    },
    {
      name: 'updateComment',
      description: 'Update an existing ticket comment.',
      inputSchema: ticketIdSchema({
        commentId: { type: 'string' } satisfies JsonSchemaType,
        body: { type: 'string' } satisfies JsonSchemaType,
      }),
      handler: ({ scope, args }) =>
        core.handlers.updateComment({
          scope,
          ticketId: requiredStringArgument(args.ticketId, 'ticketId'),
          commentId: requiredStringArgument(args.commentId, 'commentId'),
          body: requiredStringArgument(args.body, 'body'),
        }),
    },
    {
      name: 'moveTicket',
      description: 'Move a ticket to another column.',
      inputSchema: ticketIdSchema({ column: { type: 'string' } satisfies JsonSchemaType }),
      handler: ({ scope, args }) =>
        core.handlers.moveTicket({
          scope,
          ticketId: requiredStringArgument(args.ticketId, 'ticketId'),
          column: requiredStringArgument(args.column, 'column'),
        }),
    },
  ]
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Decodes one required string from a schema-defined MCP argument object.
function requiredStringArgument(value: unknown, field: string): string {
  if (typeof value === 'string') return value
  throw new TrackerMcpError({
    code: 'validation_failed',
    publicMessage: `${field} must be a string`,
  })
}

function resultEnvelopeSchema(schema: JsonSchemaType): JsonSchemaType {
  const { $ref, ...resultSchema } = schema
  // Preserve the raw schema's local-reference root inside the result envelope.
  resultSchema.$id ??= `urn:uuid:${crypto.randomUUID()}`
  // Ajv recurses indefinitely for a nested resource with a root $ref. An allOf
  // reference keeps the same validation while leaving the resource addressable.
  if ($ref !== undefined) resultSchema.allOf = [{ $ref }, ...(resultSchema.allOf ?? [])]
  return {
    $schema: schema.$schema,
    type: 'object',
    properties: { result: resultSchema },
    required: ['result'],
    additionalProperties: false,
  }
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
    const definition = {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema ? resultEnvelopeSchema(tool.outputSchema) : undefined,
      annotations: tool.annotations,
    }
    if (!isSpecType.Tool(definition)) {
      throw new Error(`Invalid tracker MCP tool definition '${tool.name}'`)
    }
    registry.set(tool.name, {
      tool,
      definition,
      validateInput: validatorProvider.getValidator(tool.inputSchema),
      validateOutput: tool.outputSchema
        ? validatorProvider.getValidator(tool.outputSchema)
        : undefined,
    })
  }

  return registry
}

function createToolServer<TScope>(
  core: TrackerCore<TScope>,
  tools: Map<string, RegisteredTrackerTool<TScope>>,
  context: TrackerRequestContext<TScope>,
  name: string,
  inflight: Set<Promise<unknown>>,
): Server {
  const server = new Server({ name, version: VERSION }, { capabilities: { tools: {} } })

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

  server.setRequestHandler(
    'tools/list',
    async (): Promise<ListToolsResult> => ({
      tools: Array.from(tools.values()).map(({ definition }) => definition),
    }),
  )

  async function callTool(request: CallToolRequest): Promise<CallToolResult> {
    const registered = tools.get(request.params.name)
    const { scope } = context
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
        args: validated.data,
        request: context.request,
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
  }

  server.setRequestHandler('tools/call', (request) => trackInflight(callTool(request), inflight))

  return server
}

export function createTrackerMcpFactory<TScope>(input: {
  core: TrackerCore<TScope>
  tools?: 'default' | TrackerMcpTool<TScope>[]
  name?: string
  inflight: Set<Promise<unknown>>
}) {
  const tools =
    input.tools === 'default' || input.tools === undefined ? defaultTools(input.core) : input.tools
  const toolRegistry = registerTools(tools)
  return (context: TrackerRequestContext<TScope>): Server =>
    createToolServer(
      input.core,
      toolRegistry,
      context,
      input.name ?? 'agent-kanban-tracker-mcp',
      input.inflight,
    )
}

export function createTrackerMcpServer<TScope>(input: {
  core: TrackerCore<TScope>
  auth: TrackerMcpAuthResolver<TScope>
  tools?: 'default' | TrackerMcpTool<TScope>[]
}): TrackerMcpServer {
  const inflight = new Set<Promise<unknown>>()
  const buildServer = createTrackerMcpFactory({ ...input, inflight })
  const authenticated = new WeakMap<AuthInfo, TrackerRequestContext<TScope>>()
  let closed = false
  const handler = createMcpHandler(({ authInfo }) => {
    if (closed) throw new ProtocolError(-32000, 'Tracker MCP server is closed')
    const context = authInfo && authenticated.get(authInfo)
    if (!context) {
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        'Missing authenticated request context',
      )
    }
    return buildServer(context)
  })
  async function authenticate(request: Request): Promise<TScope> {
    try {
      return await input.auth({
        request,
        url: new URL(request.url),
        headers: request.headers,
      })
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

  async function handleAuthenticatedRequest(request: Request): Promise<Response> {
    const scope = await authenticate(request)
    if (closed) return httpJsonRpcError(503, -32000, 'Tracker MCP server is closed')
    const authInfo: AuthInfo = { token: 'tracker-mcp', clientId: 'tracker-mcp', scopes: [] }
    authenticated.set(authInfo, { scope, request })
    try {
      return await handler.fetch(request, { authInfo })
    } finally {
      authenticated.delete(authInfo)
    }
  }

  return {
    async fetch(request: Request): Promise<Response> {
      if (closed) {
        return httpJsonRpcError(503, -32000, 'Tracker MCP server is closed')
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

      return trackInflight(responsePromise, inflight)
    },

    async selfPing(): Promise<void> {
      if (closed) {
        throw new Error('Tracker MCP server is closed')
      }
    },

    async close(signal?: globalThis.AbortSignal): Promise<void> {
      closed = true

      const closeAll = (async () => {
        await handler.close()
        while (inflight.size > 0) await Promise.allSettled(Array.from(inflight))
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
