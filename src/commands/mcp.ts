import { Server } from '@modelcontextprotocol/sdk/server'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import { createTrackerCore, defaultTools, TrackerMcpError } from '../mcp/index.ts'
import type { TrackerMcpPolicy, TrackerMcpTool } from '../mcp/index.ts'
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

export async function startStdioMcpServer(provider: KanbanProvider): Promise<void> {
  const core = createTrackerCore<LocalScope>({ provider, policy: allowAllPolicy })
  const scope: LocalScope = {} as LocalScope
  const tools = defaultTools(core)
  const byName = new Map<string, TrackerMcpTool<LocalScope>>(tools.map((tool) => [tool.name, tool]))
  const validators = new AjvJsonSchemaValidator()
  const validateByName = new Map(
    tools.map((tool) => [tool.name, validators.getValidator(tool.inputSchema)]),
  )

  const server = new Server(
    { name: 'agent-kanban', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name)
    if (!tool) {
      throw new TrackerMcpError({
        code: 'validation_failed',
        publicMessage: `Unknown tool '${request.params.name}'`,
      })
    }
    const validated = validateByName.get(tool.name)!(request.params.arguments ?? {})
    if (!validated.valid) {
      throw new TrackerMcpError({
        code: 'validation_failed',
        publicMessage: validated.errorMessage ?? `Invalid arguments for '${tool.name}'`,
      })
    }
    const result = await tool.handler({
      scope,
      args: validated.data as Record<string, unknown>,
    })
    return toCallToolResult(result)
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
