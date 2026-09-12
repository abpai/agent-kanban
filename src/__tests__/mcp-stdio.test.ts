import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

test.each(['legacy', 'modern'])(
  '%s stdio MCP keeps the CLI database open until the client closes',
  async (era) => {
    const directory = mkdtempSync(join(tmpdir(), 'kanban-mcp-stdio-'))
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(import.meta.dir, '../index.ts'), 'mcp', '--db', join(directory, 'board.db')],
      cwd: directory,
      env: { KANBAN_PROVIDER: 'local', KANBAN_STORAGE: 'sqlite' },
      stderr: 'pipe',
    })
    const client = new Client(
      { name: 'stdio-test', version: '1' },
      era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined,
    )
    const sentMethods: string[] = []
    const send = transport.send.bind(transport)
    transport.send = async (...args) => {
      const [message] = args
      if ('method' in message) sentMethods.push(message.method)
      await send(...args)
    }

    try {
      await client.connect(transport)
      expect(client.getProtocolEra()).toBe(era)
      const tools = await client.listTools()
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        'getBoard',
        'getTicket',
        'listComments',
        'moveTicket',
        'postComment',
        'updateComment',
      ])
      await expect(client.callTool({ name: 'getTicket', arguments: {} })).rejects.toThrow(
        'ticketId',
      )
      const board = await client.callTool({ name: 'getBoard', arguments: {} })
      expect(board).toMatchObject({
        structuredContent: {
          result: {
            columns: expect.arrayContaining([expect.objectContaining({ name: 'backlog' })]),
          },
        },
      })
      expect(sentMethods.includes('initialize')).toBe(era === 'legacy')
      // Modern stdio probes use a disposable sibling, leaving the main CLI process uninitialized.
      expect(sentMethods).not.toContain('server/discover')
    } finally {
      try {
        await client.close()
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  },
)
