import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { createTrackerCore } from '../mcp/index'
import { createTrackerMcpFactory } from '../mcp/server'
import type { TrackerMcpPolicy } from '../mcp/index'
import type { KanbanProvider } from '../providers/types'

type LocalScope = Record<string, never>

const allowAllPolicy: TrackerMcpPolicy<LocalScope> = {
  canReadTicket() {},
  canPostComment() {},
  canUpdateComment() {},
  canMoveTicket() {},
}

export async function startStdioMcpServer(provider: KanbanProvider): Promise<void> {
  const core = createTrackerCore<LocalScope>({ provider, policy: allowAllPolicy })
  const scope: LocalScope = {}
  const inflight = new Set<Promise<unknown>>()
  const buildServer = createTrackerMcpFactory({ core, name: 'agent-kanban', inflight })
  const transport = new StdioServerTransport()
  const handle = serveStdio(() => buildServer({ scope }), { transport })
  const lifetime = Promise.withResolvers<void>()
  const onclose = transport.onclose
  transport.onclose = () => {
    onclose?.()
    lifetime.resolve()
  }
  const shutdown = (): void => {
    void handle.close().then(lifetime.resolve, lifetime.reject)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.stdin.on('end', shutdown)
  try {
    await lifetime.promise
  } finally {
    process.off('SIGINT', shutdown)
    process.off('SIGTERM', shutdown)
    process.stdin.off('end', shutdown)
    await handle.close()
    await Promise.allSettled(inflight)
  }
}
