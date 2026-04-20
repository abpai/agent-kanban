import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { LinearProvider } from '../providers/linear.ts'
import { initLinearCacheSchema, replaceStates, saveSyncMeta } from '../providers/linear-cache.ts'

let db: Database
let originalFetch: typeof fetch

beforeEach(() => {
  db = new Database(':memory:')
  initLinearCacheSchema(db)
  originalFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('LinearProvider sync', () => {
  test('resolves a configured team key before querying issues', async () => {
    const seenIssueTeamIds: string[] = []

    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string
        variables: Record<string, unknown>
      }

      if (body.query.includes('query TeamSnapshot')) {
        return new Response(
          JSON.stringify({
            data: {
              team: {
                id: '3ca24047-e954-44e8-b266-c7182410befb',
                key: 'R2P',
                name: 'R2pi',
                states: { nodes: [{ id: 'state-1', name: 'Todo', position: 0 }] },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }

      if (body.query.includes('query Users')) {
        return new Response(JSON.stringify({ data: { users: { nodes: [] } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (body.query.includes('query Projects')) {
        return new Response(JSON.stringify({ data: { projects: { nodes: [] } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (body.query.includes('query Issues')) {
        seenIssueTeamIds.push(String(body.variables.teamId))
        return new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }

      return new Response(`Unexpected query: ${body.query}`, { status: 500 })
    }) as unknown as typeof fetch

    const provider = new LinearProvider(db, 'R2P', 'lin_api_test')
    await provider.getBoard()

    expect(seenIssueTeamIds).toEqual(['3ca24047-e954-44e8-b266-c7182410befb'])
  })

  test('createTask uses the resolved team UUID from cached sync meta', async () => {
    replaceStates(db, [{ id: 'state-1', name: 'Todo', position: 0 }])
    saveSyncMeta(db, {
      team: { id: '3ca24047-e954-44e8-b266-c7182410befb', key: 'R2P', name: 'R2pi' },
      lastSyncAt: new Date().toISOString(),
      lastIssueUpdatedAt: '2026-01-02T00:00:00Z',
    })

    let createIssueTeamId: string | null = null
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string
        variables: { input?: { teamId?: string } }
      }

      if (body.query.includes('mutation CreateIssue')) {
        createIssueTeamId = body.variables.input?.teamId ?? null
        return new Response(
          JSON.stringify({
            data: {
              issueCreate: {
                success: true,
                issue: {
                  id: 'issue-1',
                  identifier: 'R2P-1',
                  title: 'Hello',
                  description: '',
                  priority: 3,
                  url: 'https://linear.app/x/issue/R2P-1',
                  createdAt: '2026-01-01T00:00:00Z',
                  updatedAt: '2026-01-01T00:00:00Z',
                  assignee: null,
                  project: null,
                  state: { id: 'state-1', name: 'Todo', position: 0 },
                  labels: { nodes: [] },
                  comments: { totalCount: 0 },
                },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }

      return new Response(`Unexpected query: ${body.query}`, { status: 500 })
    }) as unknown as typeof fetch

    const provider = new LinearProvider(db, 'R2P', 'lin_api_test')
    const created = await provider.createTask({ title: 'Hello' })

    expect(String(createIssueTeamId)).toBe('3ca24047-e954-44e8-b266-c7182410befb')
    expect(created.externalRef).toBe('R2P-1')
  })
})
