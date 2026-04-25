import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { LinearProvider } from '../providers/linear.ts'
import {
  getCachedTasks,
  initLinearCacheSchema,
  loadSyncMeta,
  replaceStates,
  saveSyncMeta,
  upsertIssues,
} from '../providers/linear-cache.ts'

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

function linearIssue(
  overrides: Partial<{
    id: string
    identifier: string
    title: string
    description: string
    priority: number
    url: string
    createdAt: string
    updatedAt: string
    assignee: { id: string; name?: string | null; displayName?: string | null } | null
    project: { id: string; name: string; url?: string | null; state?: string | null } | null
    state: { id: string; name: string; position: number }
    labels: { nodes: Array<{ id: string; name: string }> }
    comments: {
      nodes: Array<{ id: string }>
      pageInfo?: { hasNextPage: boolean; endCursor: string | null }
    }
  }> = {},
) {
  return {
    id: 'issue-1',
    identifier: 'R2P-1',
    title: 'Linear task',
    description: '',
    priority: 2,
    url: 'https://linear.app/x/issue/R2P-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    assignee: null,
    project: null,
    state: { id: 'state-1', name: 'Todo', position: 0 },
    labels: { nodes: [] },
    comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    ...overrides,
  }
}

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
                  comments: {
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
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

  test('periodic full sync prunes cached issues missing from upstream', async () => {
    replaceStates(db, [{ id: 'state-1', name: 'Todo', position: 0 }])
    upsertIssues(db, [
      {
        id: 'issue-1',
        identifier: 'R2P-1',
        title: 'Keep me',
        stateId: 'state-1',
        stateName: 'Todo',
        statePosition: 0,
        commentCount: 1,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'issue-stale',
        identifier: 'R2P-9',
        title: 'Delete me',
        stateId: 'state-1',
        stateName: 'Todo',
        statePosition: 0,
        commentCount: 3,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ])
    saveSyncMeta(db, {
      team: { id: 'team-1', key: 'R2P', name: 'R2pi' },
      lastSyncAt: '2026-01-01T00:00:00Z',
      lastFullSyncAt: '2026-01-01T00:00:00Z',
      lastIssueUpdatedAt: '2026-01-01T00:00:00Z',
    })

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
                id: 'team-1',
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
        return new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [linearIssue({ comments: { nodes: [{ id: 'c1' }, { id: 'c2' }] } })],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }

      if (body.query.includes('query IssueHistory')) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                history: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }

      return new Response(`Unexpected query: ${body.query}`, { status: 500 })
    }) as unknown as typeof fetch

    const originalDateNow = Date.now
    Date.now = () => Date.parse('2026-01-01T00:06:00Z')

    try {
      const provider = new LinearProvider(db, 'R2P', 'lin_api_test')
      await provider.getBoard()
    } finally {
      Date.now = originalDateNow
    }

    const tasks = getCachedTasks(db)
    expect(tasks.map((task) => task.externalRef)).toEqual(['R2P-1'])
    expect(tasks[0]?.comment_count).toBe(2)
    expect(loadSyncMeta(db).lastFullSyncAt).not.toBeNull()
  })

  test('polling keeps upstream comment counts instead of resetting them to zero', async () => {
    upsertIssues(db, [
      {
        id: 'issue-1',
        identifier: 'R2P-1',
        title: 'Linear task',
        stateId: 'state-1',
        stateName: 'Todo',
        statePosition: 0,
        commentCount: 4,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ])
    saveSyncMeta(db, {
      team: { id: 'team-1', key: 'R2P', name: 'R2pi' },
      lastSyncAt: '2026-01-01T00:00:00Z',
      lastFullSyncAt: '2026-01-01T00:00:00Z',
      lastIssueUpdatedAt: '2026-01-01T00:00:00Z',
    })

    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string
      }

      if (body.query.includes('query TeamSnapshot')) {
        return new Response(
          JSON.stringify({
            data: {
              team: {
                id: 'team-1',
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
        return new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [
                  linearIssue({
                    comments: {
                      nodes: Array.from({ length: 7 }, (_, index) => ({ id: `c${index}` })),
                    },
                  }),
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }

      if (body.query.includes('query IssueHistory')) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                history: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }

      return new Response(`Unexpected query: ${body.query}`, { status: 500 })
    }) as unknown as typeof fetch

    const originalDateNow = Date.now
    Date.now = () => Date.parse('2026-01-01T00:06:00Z')

    try {
      const provider = new LinearProvider(db, 'R2P', 'lin_api_test')
      const task = await provider.getTask('R2P-1')
      expect(task.comment_count).toBe(7)
    } finally {
      Date.now = originalDateNow
    }
  })

  test('recent webhook traffic does not stretch polling beyond the normal interval', async () => {
    let issueQueries = 0

    saveSyncMeta(db, {
      team: { id: 'team-1', key: 'R2P', name: 'R2pi' },
      lastSyncAt: '2026-01-01T00:00:00.000Z',
      lastFullSyncAt: '2026-01-01T00:00:00.000Z',
      lastIssueUpdatedAt: '2026-01-01T00:00:00.000Z',
      lastWebhookAt: '2026-01-01T00:00:30.000Z',
    })

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
                id: 'team-1',
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
        issueQueries += 1
        expect(body.variables.updatedAfter).toBe('2026-01-01T00:00:00.000Z')
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

    const originalDateNow = Date.now
    Date.now = () => Date.parse('2026-01-01T00:00:31.000Z')

    try {
      const provider = new LinearProvider(db, 'R2P', 'lin_api_test')
      await provider.getBoard()
    } finally {
      Date.now = originalDateNow
    }

    expect(issueQueries).toBe(1)
  })
})
