import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  type CallToolRequest,
} from '@modelcontextprotocol/server'
import { initSchema, seedDefaultColumns } from '../db'
import { createTrackerCore, createTrackerMcpServer } from '../mcp/index'
import { LocalProvider } from '../providers/local'

type Scope = Record<string, never>

function boardRequest(era: string): Request {
  const params: CallToolRequest['params'] = { name: 'getBoard', arguments: {} }
  if (era === 'modern') {
    params._meta = {
      [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
      [CLIENT_INFO_META_KEY]: { name: 'shutdown-test', version: '1' },
      [CLIENT_CAPABILITIES_META_KEY]: {},
    }
  }
  return new Request('http://tracker.test/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'getBoard',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }),
  })
}

function lifecycleServer(input: {
  auth?: () => Promise<Scope>
  canReadBoard?: () => Promise<void> | void
  onToolResult?: () => void
}) {
  const db = new Database(':memory:')
  initSchema(db)
  seedDefaultColumns(db)
  const provider = new LocalProvider(db, ':memory:')
  const core = createTrackerCore<Scope>({
    provider,
    policy: {
      canReadTicket() {},
      canPostComment() {},
      canUpdateComment() {},
      canMoveTicket() {},
      canReadBoard: input.canReadBoard,
    },
    hooks: { onToolResult: input.onToolResult },
  })
  return {
    db,
    tracker: createTrackerMcpServer({ core, auth: input.auth ?? (async () => ({})) }),
  }
}

test.each(['legacy', 'modern'])(
  '%s MCP does not dispatch an authenticated request after shutdown starts',
  async (era) => {
    const authStarted = Promise.withResolvers<void>()
    const releaseAuth = Promise.withResolvers<void>()
    let policyCalls = 0
    const { db, tracker } = lifecycleServer({
      async auth() {
        authStarted.resolve()
        await releaseAuth.promise
        return {}
      },
      canReadBoard() {
        policyCalls += 1
      },
    })

    try {
      const responsePromise = tracker.fetch(boardRequest(era))
      await authStarted.promise
      let closed = false
      const closing = tracker.close().then(() => {
        closed = true
      })
      await Bun.sleep(0)
      expect(closed).toBe(false)

      releaseAuth.resolve()
      const response = await responsePromise
      await closing
      expect(response.status).toBe(503)
      expect(await response.json()).toHaveProperty('error.message', 'Tracker MCP server is closed')
      expect(policyCalls).toBe(0)
    } finally {
      releaseAuth.resolve()
      await tracker.close()
      db.close()
    }
  },
)

test.each(['legacy', 'modern'])(
  '%s MCP drains accepted tool work before the host can close its database',
  async (era) => {
    const toolStarted = Promise.withResolvers<void>()
    const releaseTool = Promise.withResolvers<void>()
    const events: string[] = []
    const { db, tracker } = lifecycleServer({
      async canReadBoard() {
        events.push('started')
        toolStarted.resolve()
        await releaseTool.promise
        events.push('policy released')
      },
      onToolResult() {
        events.push('result')
      },
    })

    try {
      // Shutdown can cancel the modern response; consuming either outcome
      // still leaves the accepted provider work tracked until it finishes.
      const responseBody = tracker
        .fetch(boardRequest(era))
        .then((response) => response.text())
        .catch(() => undefined)
      await toolStarted.promise
      const closing = tracker.close().then(() => {
        events.push('closed')
      })
      await Bun.sleep(0)
      expect(events).toEqual(['started'])

      releaseTool.resolve()
      await closing
      expect(events).toEqual(['started', 'policy released', 'result', 'closed'])
      const body = await responseBody
      if (era === 'legacy') expect(body).toContain('"columns"')
    } finally {
      releaseTool.resolve()
      await tracker.close()
      db.close()
    }
  },
)
