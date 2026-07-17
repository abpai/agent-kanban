import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { LinearProvider } from '../providers/linear'
import {
  getCachedLinearActivity,
  getCachedTasks,
  initLinearCacheSchema,
  loadSyncMeta,
  replaceStates,
  saveSyncMeta,
  upsertIssues,
} from '../providers/linear-cache'

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
    team: { id: string } | null
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
        return new Response(
          JSON.stringify({
            data: { users: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
      }

      if (body.query.includes('query Projects')) {
        return new Response(
          JSON.stringify({
            data: { projects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
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

    const createIssueInput: { current?: { labelIds?: string[]; teamId?: string } } = {}
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string
        variables: { input?: { labelIds?: string[]; teamId?: string } }
      }

      if (body.query.includes('query IssueLabels')) {
        return new Response(
          JSON.stringify({
            data: {
              issueLabels: {
                nodes: [
                  { id: 'label-smoke', name: 'garage-smoke' },
                  { id: 'label-owner', name: 'garage-owner-local' },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }

      if (body.query.includes('mutation CreateIssue')) {
        createIssueInput.current = body.variables.input
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
                  labels: {
                    nodes: [
                      { id: 'label-smoke', name: 'garage-smoke' },
                      { id: 'label-owner', name: 'garage-owner-local' },
                    ],
                  },
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
    const created = await provider.createTask({
      title: 'Hello',
      labels: ['garage-smoke', 'garage-owner-local'],
    })

    expect(createIssueInput.current?.teamId).toBe('3ca24047-e954-44e8-b266-c7182410befb')
    expect(createIssueInput.current?.labelIds).toEqual(['label-smoke', 'label-owner'])
    expect(created.externalRef).toBe('R2P-1')
    expect(created.labels).toEqual(['garage-smoke', 'garage-owner-local'])
  })

  test('paginates users and projects across multiple pages', async () => {
    let userPages = 0
    let projectPages = 0
    const seenUserAfter: Array<string | null> = []
    const seenProjectAfter: Array<string | null> = []

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
        userPages += 1
        const after = (body.variables.after as string | null) ?? null
        seenUserAfter.push(after)
        const page = after
          ? {
              nodes: [{ id: 'u2', displayName: 'User Two', active: true }],
              hasNextPage: false,
              endCursor: null,
            }
          : {
              nodes: [{ id: 'u1', displayName: 'User One', active: true }],
              hasNextPage: true,
              endCursor: 'cursor-u1',
            }
        return new Response(
          JSON.stringify({
            data: {
              users: {
                nodes: page.nodes,
                pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }

      if (body.query.includes('query Projects')) {
        projectPages += 1
        const after = (body.variables.after as string | null) ?? null
        seenProjectAfter.push(after)
        const page = after
          ? { nodes: [{ id: 'p2', name: 'Project Two' }], hasNextPage: false, endCursor: null }
          : {
              nodes: [{ id: 'p1', name: 'Project One' }],
              hasNextPage: true,
              endCursor: 'cursor-p1',
            }
        return new Response(
          JSON.stringify({
            data: {
              projects: {
                nodes: page.nodes,
                pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }

      if (body.query.includes('query Issues')) {
        return new Response(
          JSON.stringify({
            data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }

      return new Response(`Unexpected query: ${body.query}`, { status: 500 })
    }) as unknown as typeof fetch

    const provider = new LinearProvider(db, 'R2P', 'lin_api_test')
    await provider.getBoard()

    expect(userPages).toBe(2)
    expect(seenUserAfter).toEqual([null, 'cursor-u1'])
    expect(projectPages).toBe(2)
    expect(seenProjectAfter).toEqual([null, 'cursor-p1'])
  })

  test('createTask rejects an unknown assignee instead of silently dropping it', async () => {
    replaceStates(db, [{ id: 'state-1', name: 'Todo', position: 0 }])
    saveSyncMeta(db, {
      team: { id: 'team-1', key: 'R2P', name: 'R2pi' },
      lastSyncAt: new Date().toISOString(),
      lastIssueUpdatedAt: '2026-01-02T00:00:00Z',
    })

    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string }
      // The assignee resolver should throw before any CreateIssue mutation runs.
      return new Response(`Unexpected query: ${body.query}`, { status: 500 })
    }) as unknown as typeof fetch

    const provider = new LinearProvider(db, 'R2P', 'lin_api_test')
    await expect(
      provider.createTask({ title: 'Hello', assignee: 'Ghost User' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UPSTREAM_ERROR' })
  })

  test('updateTask rejects an unknown assignee instead of clearing the field', async () => {
    replaceStates(db, [{ id: 'state-1', name: 'Todo', position: 0 }])
    upsertIssues(db, [
      {
        id: 'issue-1',
        identifier: 'R2P-1',
        title: 'Linear task',
        assigneeId: 'user-1',
        assigneeName: 'Real Person',
        stateId: 'state-1',
        stateName: 'Todo',
        statePosition: 0,
        commentCount: 0,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ])
    saveSyncMeta(db, {
      team: { id: 'team-1', key: 'R2P', name: 'R2pi' },
      lastSyncAt: new Date().toISOString(),
      lastIssueUpdatedAt: '2026-01-02T00:00:00Z',
    })

    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string }
      // The resolver should throw before any UpdateIssue mutation runs.
      return new Response(`Unexpected query: ${body.query}`, { status: 500 })
    }) as unknown as typeof fetch

    const provider = new LinearProvider(db, 'R2P', 'lin_api_test')
    await expect(provider.updateTask('R2P-1', { assignee: 'Ghost User' })).rejects.toMatchObject({
      code: 'PROVIDER_UPSTREAM_ERROR',
    })
  })

  test('updateTask clears the assignee when given an empty string', async () => {
    replaceStates(db, [{ id: 'state-1', name: 'Todo', position: 0 }])
    upsertIssues(db, [
      {
        id: 'issue-1',
        identifier: 'R2P-1',
        title: 'Linear task',
        assigneeId: 'user-1',
        assigneeName: 'Real Person',
        stateId: 'state-1',
        stateName: 'Todo',
        statePosition: 0,
        commentCount: 0,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ])
    saveSyncMeta(db, {
      team: { id: 'team-1', key: 'R2P', name: 'R2pi' },
      lastSyncAt: new Date().toISOString(),
      lastFullSyncAt: new Date().toISOString(),
      lastIssueUpdatedAt: '2026-01-02T00:00:00Z',
    })

    const updateInputs: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string
        variables: { input?: Record<string, unknown> }
      }

      if (body.query.includes('mutation UpdateIssue')) {
        updateInputs.push(body.variables.input ?? {})
        return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
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
        return new Response(
          JSON.stringify({
            data: { users: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
      }
      if (body.query.includes('query Projects')) {
        return new Response(
          JSON.stringify({
            data: { projects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
      }
      if (body.query.includes('query Issues')) {
        return new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [linearIssue()],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (body.query.includes('query IssueById')) {
        return new Response(JSON.stringify({ data: { issue: linearIssue({ assignee: null }) } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (body.query.includes('query IssueHistory')) {
        return new Response(
          JSON.stringify({
            data: {
              issue: { history: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(`Unexpected query: ${body.query}`, { status: 500 })
    }) as unknown as typeof fetch

    const provider = new LinearProvider(db, 'R2P', 'lin_api_test')
    await provider.updateTask('R2P-1', { assignee: '' })

    expect(updateInputs).toHaveLength(1)
    expect(updateInputs[0]).toHaveProperty('assigneeId', null)
  })

  test('updateTask replaces labels exactly when labels is provided', async () => {
    replaceStates(db, [{ id: 'state-1', name: 'Todo', position: 0 }])
    upsertIssues(db, [
      {
        id: 'issue-1',
        identifier: 'R2P-1',
        title: 'Linear task',
        stateId: 'state-1',
        stateName: 'Todo',
        statePosition: 0,
        labels: ['old-label'],
        commentCount: 0,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ])
    saveSyncMeta(db, {
      team: { id: 'team-1', key: 'R2P', name: 'R2pi' },
      lastSyncAt: new Date().toISOString(),
      lastFullSyncAt: new Date().toISOString(),
      lastIssueUpdatedAt: '2026-01-02T00:00:00Z',
    })

    const updateInputs: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string
        variables: { input?: Record<string, unknown> }
      }

      if (body.query.includes('query IssueLabels')) {
        return new Response(
          JSON.stringify({
            data: {
              issueLabels: {
                nodes: [
                  { id: 'label-smoke', name: 'garage-smoke' },
                  { id: 'label-owner', name: 'garage-owner-local' },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (body.query.includes('mutation UpdateIssue')) {
        updateInputs.push(body.variables.input ?? {})
        return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
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
        return new Response(
          JSON.stringify({
            data: { users: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (body.query.includes('query Projects')) {
        return new Response(
          JSON.stringify({
            data: { projects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (body.query.includes('query Issues')) {
        return new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [linearIssue()],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (body.query.includes('query IssueById')) {
        return new Response(
          JSON.stringify({
            data: {
              issue: linearIssue({
                labels: {
                  nodes: [
                    { id: 'label-smoke', name: 'garage-smoke' },
                    { id: 'label-owner', name: 'garage-owner-local' },
                  ],
                },
              }),
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (body.query.includes('query IssueHistory')) {
        return new Response(
          JSON.stringify({
            data: {
              issue: { history: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(`Unexpected query: ${body.query}`, { status: 500 })
    }) as unknown as typeof fetch

    const provider = new LinearProvider(db, 'R2P', 'lin_api_test')
    const updated = await provider.updateTask('R2P-1', {
      labels: ['garage-smoke', 'garage-owner-local'],
    })

    expect(updateInputs).toHaveLength(1)
    expect(updateInputs[0]).toHaveProperty('labelIds', ['label-smoke', 'label-owner'])
    expect(updated.labels).toEqual(['garage-smoke', 'garage-owner-local'])
  })

  test('updateTask clears labels when labels is []', async () => {
    replaceStates(db, [{ id: 'state-1', name: 'Todo', position: 0 }])
    upsertIssues(db, [
      {
        id: 'issue-1',
        identifier: 'R2P-1',
        title: 'Linear task',
        stateId: 'state-1',
        stateName: 'Todo',
        statePosition: 0,
        labels: ['intake-blocked'],
        commentCount: 0,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ])
    saveSyncMeta(db, {
      team: { id: 'team-1', key: 'R2P', name: 'R2pi' },
      lastSyncAt: new Date().toISOString(),
      lastFullSyncAt: new Date().toISOString(),
      lastIssueUpdatedAt: '2026-01-02T00:00:00Z',
    })

    const updateInputs: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string
        variables: { input?: Record<string, unknown> }
      }

      if (body.query.includes('mutation UpdateIssue')) {
        updateInputs.push(body.variables.input ?? {})
        return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
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
        return new Response(
          JSON.stringify({
            data: { users: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (body.query.includes('query Projects')) {
        return new Response(
          JSON.stringify({
            data: { projects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (body.query.includes('query Issues')) {
        return new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [linearIssue()],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (body.query.includes('query IssueById')) {
        return new Response(
          JSON.stringify({
            data: { issue: linearIssue({ labels: { nodes: [] } }) },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (body.query.includes('query IssueHistory')) {
        return new Response(
          JSON.stringify({
            data: {
              issue: { history: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(`Unexpected query: ${body.query}`, { status: 500 })
    }) as unknown as typeof fetch

    const provider = new LinearProvider(db, 'R2P', 'lin_api_test')
    const updated = await provider.updateTask('R2P-1', { labels: [] })

    expect(updateInputs).toHaveLength(1)
    expect(updateInputs[0]).toHaveProperty('labelIds', [])
    expect(updated.labels).toEqual([])
  })

  test('updateTask leaves labels untouched when labels is absent', async () => {
    replaceStates(db, [{ id: 'state-1', name: 'Todo', position: 0 }])
    upsertIssues(db, [
      {
        id: 'issue-1',
        identifier: 'R2P-1',
        title: 'Linear task',
        stateId: 'state-1',
        stateName: 'Todo',
        statePosition: 0,
        labels: ['keep-me'],
        commentCount: 0,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ])
    saveSyncMeta(db, {
      team: { id: 'team-1', key: 'R2P', name: 'R2pi' },
      lastSyncAt: new Date().toISOString(),
      lastFullSyncAt: new Date().toISOString(),
      lastIssueUpdatedAt: '2026-01-02T00:00:00Z',
    })

    const updateInputs: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string
        variables: { input?: Record<string, unknown> }
      }

      if (body.query.includes('mutation UpdateIssue')) {
        updateInputs.push(body.variables.input ?? {})
        return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
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
        return new Response(
          JSON.stringify({
            data: { users: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (body.query.includes('query Projects')) {
        return new Response(
          JSON.stringify({
            data: { projects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (body.query.includes('query Issues')) {
        return new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [linearIssue()],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (body.query.includes('query IssueById')) {
        return new Response(
          JSON.stringify({
            data: {
              issue: linearIssue({
                title: 'Renamed only',
                labels: { nodes: [{ id: 'label-keep', name: 'keep-me' }] },
              }),
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (body.query.includes('query IssueHistory')) {
        return new Response(
          JSON.stringify({
            data: {
              issue: { history: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(`Unexpected query: ${body.query}`, { status: 500 })
    }) as unknown as typeof fetch

    const provider = new LinearProvider(db, 'R2P', 'lin_api_test')
    await provider.updateTask('R2P-1', { title: 'Renamed only' })

    expect(updateInputs).toHaveLength(1)
    expect(Object.hasOwn(updateInputs[0]!, 'labelIds')).toBe(false)
    expect(updateInputs[0]).toHaveProperty('title', 'Renamed only')
  })

  test('advertises labelReplacement capability', async () => {
    replaceStates(db, [{ id: 'state-1', name: 'Todo', position: 0 }])
    saveSyncMeta(db, {
      team: { id: 'team-1', key: 'R2P', name: 'R2pi' },
      lastSyncAt: new Date().toISOString(),
      lastIssueUpdatedAt: '2026-01-02T00:00:00Z',
    })
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string }
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
      if (body.query.includes('query Users') || body.query.includes('query Projects')) {
        return new Response(
          JSON.stringify({
            data: {
              users: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
              projects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (body.query.includes('query Issues')) {
        return new Response(
          JSON.stringify({
            data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(`Unexpected query: ${body.query}`, { status: 500 })
    }) as unknown as typeof fetch

    const provider = new LinearProvider(db, 'R2P', 'lin_api_test')
    const ctx = await provider.getContext()
    expect(ctx.capabilities.labelReplacement).toBe(true)
  })

  test('updateTask drops the cached row when the hydrated issue left the team', async () => {
    replaceStates(db, [{ id: 'state-1', name: 'Todo', position: 0 }])
    upsertIssues(db, [
      {
        id: 'issue-1',
        identifier: 'R2P-1',
        title: 'Linear task',
        stateId: 'state-1',
        stateName: 'Todo',
        statePosition: 0,
        commentCount: 0,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ])
    saveSyncMeta(db, {
      team: { id: 'team-1', key: 'R2P', name: 'R2pi' },
      lastSyncAt: new Date().toISOString(),
      lastFullSyncAt: new Date().toISOString(),
      lastIssueUpdatedAt: '2026-01-02T00:00:00Z',
    })

    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string }
      if (body.query.includes('mutation UpdateIssue')) {
        return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (body.query.includes('query IssueById')) {
        // Upstream reports the issue now belongs to a different team.
        return new Response(
          JSON.stringify({ data: { issue: linearIssue({ team: { id: 'team-2' } }) } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(`Unexpected query: ${body.query}`, { status: 500 })
    }) as unknown as typeof fetch

    const provider = new LinearProvider(db, 'R2P', 'lin_api_test')
    await expect(provider.updateTask('R2P-1', { title: 'Renamed' })).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    })
    expect(getCachedTasks(db)).toHaveLength(0)
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
        return new Response(
          JSON.stringify({
            data: { users: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
      }

      if (body.query.includes('query Projects')) {
        return new Response(
          JSON.stringify({
            data: { projects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
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

  test('history ingest preserves activity from completed batches before a later batch fails', async () => {
    saveSyncMeta(db, {
      team: { id: 'team-1', key: 'R2P', name: 'R2pi' },
      lastSyncAt: '2026-01-01T00:00:00Z',
      lastFullSyncAt: '2026-01-01T00:00:00Z',
      lastIssueUpdatedAt: '2026-01-01T00:00:00Z',
    })
    const issues = Array.from({ length: 6 }, (_, i) =>
      linearIssue({
        id: `issue-${i + 1}`,
        identifier: `R2P-${i + 1}`,
        updatedAt: '2026-01-02T00:00:00Z',
      }),
    )

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
        return new Response(
          JSON.stringify({
            data: { users: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (body.query.includes('query Projects')) {
        return new Response(
          JSON.stringify({
            data: { projects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (body.query.includes('query Issues')) {
        return new Response(
          JSON.stringify({
            data: { issues: { nodes: issues, pageInfo: { hasNextPage: false, endCursor: null } } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (body.query.includes('query IssueHistory')) {
        const issueId = String(body.variables.issueId)
        if (issueId === 'issue-6') {
          return new Response('history failed', { status: 500 })
        }
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                history: {
                  nodes: [
                    {
                      id: `hist-${issueId}`,
                      createdAt: '2026-01-02T00:00:00Z',
                      fromState: { id: 'state-0' },
                      toState: { id: 'state-1' },
                    },
                  ],
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
    Date.now = () => Date.parse('2026-01-01T00:01:00Z')
    try {
      const provider = new LinearProvider(db, 'R2P', 'lin_api_test')
      await provider.getBoard()
    } finally {
      Date.now = originalDateNow
    }

    expect(
      getCachedLinearActivity(db)
        .map((row) => row.issue_id)
        .sort(),
    ).toEqual(['issue-1', 'issue-2', 'issue-3', 'issue-4', 'issue-5'])
  })

  test('counts comments beyond the inline first page instead of capping at the page length', async () => {
    saveSyncMeta(db, {
      team: { id: 'team-1', key: 'R2P', name: 'R2pi' },
      lastSyncAt: '2026-01-01T00:00:00Z',
      lastFullSyncAt: '2026-01-01T00:00:00Z',
      lastIssueUpdatedAt: '2026-01-01T00:00:00Z',
    })

    let commentCountQueries = 0
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
        return new Response(
          JSON.stringify({
            data: { users: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (body.query.includes('query Projects')) {
        return new Response(
          JSON.stringify({
            data: { projects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (body.query.includes('query IssueCommentCount')) {
        commentCountQueries += 1
        // Second comment page: three more comments, no further pages.
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                comments: {
                  nodes: [{ id: 'c3' }, { id: 'c4' }, { id: 'c5' }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (body.query.includes('query Issues')) {
        return new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [
                  linearIssue({
                    comments: {
                      nodes: [{ id: 'c1' }, { id: 'c2' }],
                      pageInfo: { hasNextPage: true, endCursor: 'comment-cursor-1' },
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
              issue: { history: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
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
      expect(task.comment_count).toBe(5)
      expect(commentCountQueries).toBe(1)
    } finally {
      Date.now = originalDateNow
    }
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
        return new Response(
          JSON.stringify({
            data: { users: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
      }

      if (body.query.includes('query Projects')) {
        return new Response(
          JSON.stringify({
            data: { projects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
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
        return new Response(
          JSON.stringify({
            data: { users: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
      }

      if (body.query.includes('query Projects')) {
        return new Response(
          JSON.stringify({
            data: { projects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
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

  test('custom polling sync interval refreshes before the default 30 seconds', async () => {
    let issueQueries = 0

    saveSyncMeta(db, {
      team: { id: 'team-1', key: 'R2P', name: 'R2pi' },
      lastSyncAt: '2026-01-01T00:00:00.000Z',
      lastFullSyncAt: '2026-01-01T00:00:00.000Z',
      lastIssueUpdatedAt: '2026-01-01T00:00:00.000Z',
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
        return new Response(
          JSON.stringify({
            data: { users: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
      }

      if (body.query.includes('query Projects')) {
        return new Response(
          JSON.stringify({
            data: { projects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
      }

      if (body.query.includes('query Issues')) {
        issueQueries += 1
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
    Date.now = () => Date.parse('2026-01-01T00:00:06.000Z')

    try {
      const provider = new LinearProvider(db, 'R2P', 'lin_api_test', 5_000)
      await provider.getBoard()
    } finally {
      Date.now = originalDateNow
    }

    expect(issueQueries).toBe(1)
  })
})
