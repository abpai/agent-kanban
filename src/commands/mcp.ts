import { Server } from '@modelcontextprotocol/sdk/server'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js'
import { createTrackerCore, TrackerMcpError } from '../mcp/index.ts'
import type { TrackerMcpPolicy } from '../mcp/index.ts'
import type { KanbanProvider } from '../providers/types.ts'

type LocalScope = Record<string, never>

const allowAllPolicy: TrackerMcpPolicy<LocalScope> = {
  canReadTicket() {},
  canPostComment() {},
  canUpdateComment() {},
  canMoveTicket() {},
}

function toCallToolResult(result: unknown): CallToolResult {
  const text = typeof result === 'string' ? result : JSON.stringify(result ?? null)
  return {
    content: [{ type: 'text', text }],
    structuredContent: { result: result ?? null },
  }
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new TrackerMcpError({
      code: 'validation_failed',
      publicMessage: `Missing required string argument '${key}'`,
    })
  }
  return value
}

export async function startStdioMcpServer(provider: KanbanProvider): Promise<void> {
  const core = createTrackerCore<LocalScope>({ provider, policy: allowAllPolicy })
  const scope: LocalScope = {} as LocalScope

  const server = new Server(
    { name: 'agent-kanban', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'getBoard',
        description: 'Fetch the current board state with all columns and tasks.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      {
        name: 'getTicket',
        description: 'Fetch a single ticket by id.',
        inputSchema: {
          type: 'object',
          properties: { ticketId: { type: 'string' } },
          required: ['ticketId'],
          additionalProperties: false,
        },
      },
      {
        name: 'listComments',
        description: 'List comments on a ticket.',
        inputSchema: {
          type: 'object',
          properties: { ticketId: { type: 'string' } },
          required: ['ticketId'],
          additionalProperties: false,
        },
      },
      {
        name: 'postComment',
        description: 'Add a new comment to a ticket.',
        inputSchema: {
          type: 'object',
          properties: { ticketId: { type: 'string' }, body: { type: 'string' } },
          required: ['ticketId', 'body'],
          additionalProperties: false,
        },
      },
      {
        name: 'updateComment',
        description: 'Update an existing comment on a ticket.',
        inputSchema: {
          type: 'object',
          properties: {
            ticketId: { type: 'string' },
            commentId: { type: 'string' },
            body: { type: 'string' },
          },
          required: ['ticketId', 'commentId', 'body'],
          additionalProperties: false,
        },
      },
      {
        name: 'moveTicket',
        description: 'Move a ticket to another column.',
        inputSchema: {
          type: 'object',
          properties: { ticketId: { type: 'string' }, column: { type: 'string' } },
          required: ['ticketId', 'column'],
          additionalProperties: false,
        },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>
    switch (request.params.name) {
      case 'getBoard':
        return toCallToolResult(await core.handlers.getBoard({ scope }))
      case 'getTicket':
        return toCallToolResult(
          await core.handlers.getTicket({ scope, ticketId: requireString(args, 'ticketId') }),
        )
      case 'listComments':
        return toCallToolResult(
          await core.handlers.listComments({ scope, ticketId: requireString(args, 'ticketId') }),
        )
      case 'postComment':
        return toCallToolResult(
          await core.handlers.postComment({
            scope,
            ticketId: requireString(args, 'ticketId'),
            body: requireString(args, 'body'),
          }),
        )
      case 'updateComment':
        return toCallToolResult(
          await core.handlers.updateComment({
            scope,
            ticketId: requireString(args, 'ticketId'),
            commentId: requireString(args, 'commentId'),
            body: requireString(args, 'body'),
          }),
        )
      case 'moveTicket': {
        await core.handlers.moveTicket({
          scope,
          ticketId: requireString(args, 'ticketId'),
          column: requireString(args, 'column'),
        })
        return toCallToolResult({ ok: true })
      }
      default:
        throw new TrackerMcpError({
          code: 'validation_failed',
          publicMessage: `Unknown tool '${request.params.name}'`,
        })
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)

  const shutdown = async (): Promise<void> => {
    try {
      await server.close()
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
