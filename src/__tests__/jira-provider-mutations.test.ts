import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { ErrorCode, KanbanError } from '../errors.ts'
import { JiraClient } from '../providers/jira-client.ts'
import { JiraProvider, type JiraProviderConfig } from '../providers/jira.ts'
import {
  initJiraCacheSchema,
  replaceJiraColumns,
  replaceJiraIssueTypes,
  replaceJiraPriorities,
  saveJiraSyncMeta,
  saveTeamInfo,
  upsertJiraIssues,
  upsertJiraUsers,
} from '../providers/jira-cache.ts'

type FetchInit = RequestInit | undefined
type StubCall = { url: string; method: string; body: string | null }
type StubHandler = (url: string, init?: FetchInit) => Response | Promise<Response>
type StubRoute = { match: (url: string, init?: FetchInit) => boolean; handler: StubHandler }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function emptyResponse(status = 204): Response {
  return new Response(null, { status })
}

function jiraFetchStub(routes: StubRoute[]): {
  fn: typeof fetch
  calls: StubCall[]
} {
  const calls: StubCall[] = []
  const fn = (async (input: string | URL | Request, init?: FetchInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? init.body : null
    calls.push({ url, method, body })
    for (const r of routes) {
      if (r.match(url, init)) return r.handler(url, init)
    }
    return new Response('route not stubbed: ' + method + ' ' + url, {
      status: 500,
    })
  }) as unknown as typeof fetch
  return { fn, calls }
}

const baseConfig: JiraProviderConfig = {
  baseUrl: 'https://example.atlassian.net',
  email: 'user@example.com',
  apiToken: 'token',
  projectKey: 'ENG',
}

interface SeedIssue {
  id: string
  key: string
  summary?: string
  statusId: string
  projectKey?: string
  createdAt?: string
  updatedAt?: string
}

interface SeedOpts {
  priorities?: Array<{ id: string; name: string }>
  users?: Array<{ accountId: string; displayName: string; active?: boolean }>
  issueTypes?: Array<{ id: string; name: string }>
  columns?: Array<{
    id: string
    name: string
    position: number
    statusIds: string[]
    source: 'board' | 'status'
  }>
  issues?: SeedIssue[]
  projectKey?: string
  boardId?: number | null
  team?: { id: string; key: string; name: string }
}

function seedCache(db: Database, opts: SeedOpts): void {
  initJiraCacheSchema(db)
  if (opts.priorities) replaceJiraPriorities(db, opts.priorities)
  if (opts.users) upsertJiraUsers(db, opts.users)
  if (opts.issueTypes) replaceJiraIssueTypes(db, opts.issueTypes)
  if (opts.columns) replaceJiraColumns(db, opts.columns)
  if (opts.issues) {
    upsertJiraIssues(
      db,
      opts.issues.map((iss) => ({
        id: iss.id,
        key: iss.key,
        summary: iss.summary ?? iss.key,
        descriptionText: '',
        statusId: iss.statusId,
        priorityName: 'High',
        issueTypeName: 'Task',
        assigneeAccountId: null,
        assigneeName: '',
        projectKey: iss.projectKey ?? opts.projectKey ?? 'ENG',
        url: null,
        createdAt: iss.createdAt ?? '2026-01-01T00:00:00Z',
        updatedAt: iss.updatedAt ?? '2026-01-02T00:00:00Z',
      })),
    )
  }
  saveJiraSyncMeta(db, {
    projectKey: opts.projectKey ?? 'ENG',
    boardId: opts.boardId ?? null,
    lastSyncAt: new Date().toISOString(),
    lastIssueUpdatedAt: '2026-01-02T00:00:00Z',
  })
  if (opts.team) saveTeamInfo(db, opts.team)
  else saveTeamInfo(db, { id: '10000', key: opts.projectKey ?? 'ENG', name: 'Engineering' })
}

interface SyncRoutesOpts {
  projectKey: string
  columns?: Array<{ name: string; statusIds: string[] }>
  users?: Array<{ accountId: string; displayName: string; active?: boolean }>
  priorities?: Array<{ id: string; name: string }>
  issueTypes?: Array<{ id: string; name: string }>
  issues?: Array<Record<string, unknown>>
  boardId?: number
}

function makeJiraIssueFixture(iss: SeedIssue): Record<string, unknown> {
  return {
    id: iss.id,
    key: iss.key,
    fields: {
      summary: iss.summary ?? iss.key,
      description: null,
      status: { id: iss.statusId, name: 'Status ' + iss.statusId },
      issuetype: { id: '10001', name: 'Task' },
      priority: { id: '2', name: 'High' },
      assignee: null,
      created: iss.createdAt ?? '2026-01-01T00:00:00Z',
      updated: iss.updatedAt ?? '2026-01-02T00:00:00Z',
      project: { id: '10000', key: iss.projectKey ?? 'ENG' },
    },
  }
}

function standardSyncRoutes(opts: SyncRoutesOpts): StubRoute[] {
  const statusCategories = [
    {
      id: 'cat-1',
      name: 'All',
      statuses: (opts.columns ?? []).flatMap((c) =>
        c.statusIds.map((sid) => ({ id: sid, name: c.name })),
      ),
    },
  ]
  const boardCfg = {
    id: opts.boardId ?? 3,
    name: 'Board',
    columnConfig: {
      columns: (opts.columns ?? []).map((c) => ({
        name: c.name,
        statuses: c.statusIds.map((sid) => ({ id: sid })),
      })),
    },
  }
  return [
    {
      match: (u) => u.includes(`/rest/api/3/project/${opts.projectKey}/statuses`),
      handler: () => jsonResponse(statusCategories),
    },
    {
      match: (u) => u.includes(`/rest/api/3/project/${opts.projectKey}`),
      handler: () => jsonResponse({ id: '10000', key: opts.projectKey, name: 'Engineering' }),
    },
    {
      match: (u) => u.includes('/rest/agile/1.0/board/'),
      handler: () => jsonResponse(boardCfg),
    },
    {
      match: (u) => u.includes('/rest/api/3/user/assignable/search'),
      handler: () => jsonResponse(opts.users ?? []),
    },
    {
      match: (u) => u.includes('/rest/api/3/priority'),
      handler: () => jsonResponse(opts.priorities ?? []),
    },
    {
      match: (u) => u.includes('/rest/api/3/issuetype/project'),
      handler: () => jsonResponse(opts.issueTypes ?? []),
    },
    {
      match: (u) => u.includes('/rest/api/3/search/jql'),
      handler: () =>
        jsonResponse({
          startAt: 0,
          maxResults: 100,
          total: (opts.issues ?? []).length,
          issues: opts.issues ?? [],
        }),
    },
  ]
}

function makeProvider(
  db: Database,
  routes: StubRoute[],
  config: JiraProviderConfig = baseConfig,
): { provider: JiraProvider; calls: StubCall[] } {
  const { fn, calls } = jiraFetchStub(routes)
  globalThis.fetch = fn
  const client = new JiraClient({
    baseUrl: config.baseUrl,
    email: config.email,
    apiToken: config.apiToken,
  })
  const provider = new JiraProvider(db, config, client)
  return { provider, calls }
}

let db: Database
let originalFetch: typeof fetch

beforeEach(() => {
  db = new Database(':memory:')
  originalFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

// Standard full-cache seed values reused across happy-path tests.
const seedPriorities = [
  { id: '1', name: 'Highest' },
  { id: '2', name: 'High' },
  { id: '3', name: 'Medium' },
  { id: '4', name: 'Low' },
]
const seedUsers = [
  { accountId: 'a-1', displayName: 'Alice', active: true },
  { accountId: 'a-2', displayName: 'Bob', active: true },
]
const seedIssueTypes = [
  { id: '10001', name: 'Task' },
  { id: '10002', name: 'Bug' },
]
const seedColumns: SeedOpts['columns'] = [
  {
    id: 'board:3:To Do',
    name: 'To Do',
    position: 0,
    statusIds: ['20000'],
    source: 'board',
  },
  {
    id: 'board:3:Done',
    name: 'Done',
    position: 1,
    statusIds: ['10001'],
    source: 'board',
  },
]
const seedIssues: SeedIssue[] = [
  { id: '501', key: 'ENG-1', statusId: '20000', summary: 'Existing' },
]

function fullSeed(db: Database): void {
  seedCache(db, {
    priorities: seedPriorities,
    users: seedUsers,
    issueTypes: seedIssueTypes,
    columns: seedColumns,
    issues: seedIssues,
    projectKey: 'ENG',
  })
}

function fullSyncRoutes(extraIssues: Record<string, unknown>[] = []): StubRoute[] {
  return standardSyncRoutes({
    projectKey: 'ENG',
    columns: [
      { name: 'To Do', statusIds: ['20000'] },
      { name: 'Done', statusIds: ['10001'] },
    ],
    users: seedUsers,
    priorities: seedPriorities,
    issueTypes: seedIssueTypes,
    issues: [makeJiraIssueFixture(seedIssues[0]!), ...extraIssues],
  })
}

describe('JiraProvider mutations', () => {
  test('createTask happy path: plainTextToAdf invoked, priority mapped, assignee and issueType resolved', async () => {
    fullSeed(db)
    // Shared state so the POST /issue handler appends the created issue, which
    // the subsequent sync(true)'s /search handler then returns so getCachedTask
    // finds it after the post-mutation sync.
    const createdIssues: Record<string, unknown>[] = []
    const createdIssue = makeJiraIssueFixture({
      id: '600',
      key: 'ENG-10',
      statusId: '20000',
      summary: 'Fix',
    })
    const syncRoutes: StubRoute[] = standardSyncRoutes({
      projectKey: 'ENG',
      columns: [
        { name: 'To Do', statusIds: ['20000'] },
        { name: 'Done', statusIds: ['10001'] },
      ],
      users: seedUsers,
      priorities: seedPriorities,
      issueTypes: seedIssueTypes,
      issues: [makeJiraIssueFixture(seedIssues[0]!)],
    })
    // Replace the /search route to include createdIssues dynamically.
    const searchRouteIndex = syncRoutes.findIndex((r) =>
      r.match('https://example.atlassian.net/rest/api/3/search/jql'),
    )
    syncRoutes[searchRouteIndex] = {
      match: (u) => u.includes('/rest/api/3/search/jql'),
      handler: () => {
        const all = [makeJiraIssueFixture(seedIssues[0]!), ...createdIssues]
        return jsonResponse({
          startAt: 0,
          maxResults: 100,
          total: all.length,
          issues: all,
        })
      },
    }
    const mutationRoute: StubRoute = {
      match: (u, init) => u.endsWith('/rest/api/3/issue') && (init?.method ?? 'GET') === 'POST',
      handler: () => {
        createdIssues.push(createdIssue)
        return jsonResponse({
          id: '600',
          key: 'ENG-10',
          self: 'https://example.atlassian.net/rest/api/3/issue/600',
        })
      },
    }
    const { provider, calls } = makeProvider(db, [mutationRoute, ...syncRoutes])
    const task = await provider.createTask({
      title: 'Fix',
      description: 'hello\n- item',
      priority: 'high',
      assignee: 'Alice',
    })

    expect(task.externalRef).toBe('ENG-10')
    const postCall = calls.find((c) => c.method === 'POST' && c.url.endsWith('/rest/api/3/issue'))
    expect(postCall).toBeDefined()
    const body = JSON.parse(postCall!.body ?? '{}') as {
      fields: Record<string, unknown>
    }
    expect(body.fields.summary).toBe('Fix')
    expect((body.fields.issuetype as { id: string }).id).toBe('10001')
    expect((body.fields.priority as { name: string }).name).toBe('High')
    expect((body.fields.assignee as { accountId: string }).accountId).toBe('a-1')
    expect((body.fields.project as { key: string }).key).toBe('ENG')
    const desc = body.fields.description as {
      version: number
      type: string
      content: Array<{ type: string; content?: unknown[] }>
    }
    expect(desc.version).toBe(1)
    expect(desc.type).toBe('doc')
    expect(desc.content.length).toBeGreaterThan(0)
    expect(desc.content[0]!.type).toBe('paragraph')
    expect(desc.content[1]!.type).toBe('bulletList')
  })

  test('updateTask happy path: summary + description + priority rewritten', async () => {
    fullSeed(db)
    const syncRoutes = fullSyncRoutes()
    const mutationRoute: StubRoute = {
      match: (u, init) =>
        u.endsWith('/rest/api/3/issue/ENG-1') && (init?.method ?? 'GET') === 'PUT',
      handler: () => emptyResponse(204),
    }
    const { provider, calls } = makeProvider(db, [mutationRoute, ...syncRoutes])
    await provider.updateTask('ENG-1', {
      title: 'New',
      description: 'new body',
      priority: 'urgent',
    })
    const putCall = calls.find(
      (c) => c.method === 'PUT' && c.url.endsWith('/rest/api/3/issue/ENG-1'),
    )
    expect(putCall).toBeDefined()
    const body = JSON.parse(putCall!.body ?? '{}') as {
      fields: Record<string, unknown>
    }
    expect(Object.keys(body.fields).sort()).toEqual(['description', 'priority', 'summary'].sort())
    expect(body.fields.summary).toBe('New')
    expect((body.fields.priority as { name: string }).name).toBe('Highest')
    const desc = body.fields.description as {
      version: number
      type: string
      content: unknown[]
    }
    expect(desc.version).toBe(1)
    expect(desc.type).toBe('doc')
    expect(desc.content.length).toBeGreaterThan(0)
  })

  test('updateTask clearing assignee with empty string sets fields.assignee to null', async () => {
    fullSeed(db)
    const syncRoutes = fullSyncRoutes()
    const mutationRoute: StubRoute = {
      match: (u, init) =>
        u.endsWith('/rest/api/3/issue/ENG-1') && (init?.method ?? 'GET') === 'PUT',
      handler: () => emptyResponse(204),
    }
    const { provider, calls } = makeProvider(db, [mutationRoute, ...syncRoutes])
    await provider.updateTask('ENG-1', { assignee: '' })
    const putCall = calls.find(
      (c) => c.method === 'PUT' && c.url.endsWith('/rest/api/3/issue/ENG-1'),
    )
    expect(putCall).toBeDefined()
    const body = JSON.parse(putCall!.body ?? '{}') as {
      fields: Record<string, unknown>
    }
    expect('assignee' in body.fields).toBe(true)
    expect(body.fields.assignee).toBeNull()
  })

  test('moveTask happy path: matching transition is used with GET before POST', async () => {
    seedCache(db, {
      priorities: seedPriorities,
      users: seedUsers,
      issueTypes: seedIssueTypes,
      columns: seedColumns,
      issues: [{ id: '501', key: 'ENG-1', statusId: '20000' }],
      projectKey: 'ENG',
    })
    const syncRoutes = fullSyncRoutes()
    const transitionsRoute: StubRoute = {
      match: (u, init) =>
        u.endsWith('/rest/api/3/issue/ENG-1/transitions') && (init?.method ?? 'GET') === 'GET',
      handler: () =>
        jsonResponse({
          transitions: [
            { id: '21', name: 'Done', to: { id: '10001', name: 'Done' } },
            { id: '22', name: 'Reject', to: { id: '30000', name: 'Rejected' } },
          ],
        }),
    }
    const postTransitionRoute: StubRoute = {
      match: (u, init) =>
        u.endsWith('/rest/api/3/issue/ENG-1/transitions') && (init?.method ?? 'GET') === 'POST',
      handler: () => emptyResponse(204),
    }
    const { provider, calls } = makeProvider(db, [
      transitionsRoute,
      postTransitionRoute,
      ...syncRoutes,
    ])
    await provider.moveTask('ENG-1', 'Done')

    const getIdx = calls.findIndex(
      (c) => c.method === 'GET' && c.url.endsWith('/rest/api/3/issue/ENG-1/transitions'),
    )
    const postIdx = calls.findIndex(
      (c) => c.method === 'POST' && c.url.endsWith('/rest/api/3/issue/ENG-1/transitions'),
    )
    expect(getIdx).toBeGreaterThanOrEqual(0)
    expect(postIdx).toBeGreaterThanOrEqual(0)
    expect(getIdx).toBeLessThan(postIdx)
    const postCall = calls[postIdx]!
    const body = JSON.parse(postCall.body ?? '{}') as {
      transition: { id: string }
    }
    expect(body.transition.id).toBe('21')
  })

  test('moveTask no-match failure: error message names target and lists available transitions', async () => {
    seedCache(db, {
      priorities: seedPriorities,
      users: seedUsers,
      issueTypes: seedIssueTypes,
      columns: seedColumns,
      issues: [{ id: '501', key: 'ENG-1', statusId: '20000' }],
      projectKey: 'ENG',
    })
    // No standard sync routes — the mutation throws before sync(true).
    const transitionsRoute: StubRoute = {
      match: (u, init) =>
        u.endsWith('/rest/api/3/issue/ENG-1/transitions') && (init?.method ?? 'GET') === 'GET',
      handler: () =>
        jsonResponse({
          transitions: [{ id: '22', name: 'Reject', to: { id: '30000', name: 'Rejected' } }],
        }),
    }
    const { provider } = makeProvider(db, [transitionsRoute])
    try {
      await provider.moveTask('ENG-1', 'Done')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(KanbanError)
      const e = err as KanbanError
      expect(e.code).toBe(ErrorCode.PROVIDER_UPSTREAM_ERROR)
      expect(e.message).toContain('ENG-1')
      expect(e.message).toContain('Done')
      expect(e.message).toContain('10001')
      expect(e.message).toContain('Reject')
    }
  })

  test('moveTask required-field failure: error surfaces Jira errors keys', async () => {
    seedCache(db, {
      priorities: seedPriorities,
      users: seedUsers,
      issueTypes: seedIssueTypes,
      columns: seedColumns,
      issues: [{ id: '501', key: 'ENG-1', statusId: '20000' }],
      projectKey: 'ENG',
    })
    const transitionsRoute: StubRoute = {
      match: (u, init) =>
        u.endsWith('/rest/api/3/issue/ENG-1/transitions') && (init?.method ?? 'GET') === 'GET',
      handler: () =>
        jsonResponse({
          transitions: [{ id: '21', name: 'Done', to: { id: '10001', name: 'Done' } }],
        }),
    }
    const postTransitionRoute: StubRoute = {
      match: (u, init) =>
        u.endsWith('/rest/api/3/issue/ENG-1/transitions') && (init?.method ?? 'GET') === 'POST',
      handler: () =>
        jsonResponse(
          {
            errorMessages: ['Required field missing'],
            errors: { resolution: 'is required' },
          },
          400,
        ),
    }
    const { provider } = makeProvider(db, [transitionsRoute, postTransitionRoute])
    try {
      await provider.moveTask('ENG-1', 'Done')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(KanbanError)
      const e = err as KanbanError
      expect(e.code).toBe(ErrorCode.PROVIDER_UPSTREAM_ERROR)
      expect(e.message).toContain('resolution')
      expect(e.message).toContain('is required')
    }
  })

  test('createTask failure: unknown assignee name', async () => {
    seedCache(db, {
      priorities: seedPriorities,
      users: seedUsers,
      issueTypes: seedIssueTypes,
      columns: seedColumns,
      issues: [],
      projectKey: 'ENG',
    })
    // Strict stub: reject any unexpected call.
    const { provider, calls } = makeProvider(db, [])
    try {
      await provider.createTask({ title: 'x', assignee: 'Bob2' })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(KanbanError)
      const e = err as KanbanError
      expect(e.code).toBe(ErrorCode.PROVIDER_UPSTREAM_ERROR)
      expect(e.message).toContain('Bob2')
    }
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/rest/api/3/issue'))).toBe(
      false,
    )
  })

  test('createTask failure: canonical priority maps to Jira name missing from cache', async () => {
    seedCache(db, {
      priorities: [
        { id: '1', name: 'Highest' },
        { id: '3', name: 'Medium' },
        { id: '4', name: 'Low' },
      ],
      users: seedUsers,
      issueTypes: seedIssueTypes,
      columns: seedColumns,
      issues: [],
      projectKey: 'ENG',
    })
    const { provider } = makeProvider(db, [])
    try {
      await provider.createTask({ title: 'x', priority: 'high' })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(KanbanError)
      const e = err as KanbanError
      expect(e.code).toBe(ErrorCode.PROVIDER_UPSTREAM_ERROR)
      expect(e.message).toContain('high')
      expect(e.message).toContain('High')
      expect(e.message).toContain('Highest')
      expect(e.message).toContain('Medium')
      expect(e.message).toContain('Low')
    }
  })

  test('createTask failure: default issue type missing from cache', async () => {
    seedCache(db, {
      priorities: seedPriorities,
      users: seedUsers,
      issueTypes: [
        { id: '1', name: 'Bug' },
        { id: '2', name: 'Story' },
      ],
      columns: seedColumns,
      issues: [],
      projectKey: 'ENG',
    })
    const { provider } = makeProvider(db, [])
    try {
      await provider.createTask({ title: 'x' })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(KanbanError)
      const e = err as KanbanError
      expect(e.code).toBe(ErrorCode.PROVIDER_UPSTREAM_ERROR)
      expect(e.message).toContain('Task')
      expect(e.message).toContain('Bug')
      expect(e.message).toContain('Story')
    }
  })

  test('createTask project field mismatch rejected as UNSUPPORTED_OPERATION', async () => {
    fullSeed(db)
    const { provider } = makeProvider(db, [])
    try {
      await provider.createTask({ title: 'x', project: 'OTHER' })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(KanbanError)
      expect((err as KanbanError).code).toBe(ErrorCode.UNSUPPORTED_OPERATION)
    }
  })

  test('createTask project field omitted is accepted', async () => {
    fullSeed(db)
    const createdIssues: Record<string, unknown>[] = []
    const createdIssue = makeJiraIssueFixture({
      id: '600',
      key: 'ENG-10',
      statusId: '20000',
      summary: 'x',
    })
    const syncRoutes = standardSyncRoutes({
      projectKey: 'ENG',
      columns: [
        { name: 'To Do', statusIds: ['20000'] },
        { name: 'Done', statusIds: ['10001'] },
      ],
      users: seedUsers,
      priorities: seedPriorities,
      issueTypes: seedIssueTypes,
      issues: [makeJiraIssueFixture(seedIssues[0]!)],
    })
    const searchIdx = syncRoutes.findIndex((r) =>
      r.match('https://example.atlassian.net/rest/api/3/search/jql'),
    )
    syncRoutes[searchIdx] = {
      match: (u) => u.includes('/rest/api/3/search/jql'),
      handler: () => {
        const all = [makeJiraIssueFixture(seedIssues[0]!), ...createdIssues]
        return jsonResponse({
          startAt: 0,
          maxResults: 100,
          total: all.length,
          issues: all,
        })
      },
    }
    const mutationRoute: StubRoute = {
      match: (u, init) => u.endsWith('/rest/api/3/issue') && (init?.method ?? 'GET') === 'POST',
      handler: () => {
        createdIssues.push(createdIssue)
        return jsonResponse({ id: '600', key: 'ENG-10', self: 'x' })
      },
    }
    const { provider, calls } = makeProvider(db, [mutationRoute, ...syncRoutes])
    await provider.createTask({ title: 'x' })
    const postCalls = calls.filter(
      (c) => c.method === 'POST' && c.url.endsWith('/rest/api/3/issue'),
    )
    expect(postCalls).toHaveLength(1)
    const body = JSON.parse(postCalls[0]!.body ?? '{}') as {
      fields: { project: { key: string } }
    }
    expect(body.fields.project.key).toBe('ENG')
  })

  test('createTask project field matching configured projectKey is accepted', async () => {
    fullSeed(db)
    const createdIssues: Record<string, unknown>[] = []
    const createdIssue = makeJiraIssueFixture({
      id: '601',
      key: 'ENG-11',
      statusId: '20000',
      summary: 'x',
    })
    const syncRoutes = standardSyncRoutes({
      projectKey: 'ENG',
      columns: [
        { name: 'To Do', statusIds: ['20000'] },
        { name: 'Done', statusIds: ['10001'] },
      ],
      users: seedUsers,
      priorities: seedPriorities,
      issueTypes: seedIssueTypes,
      issues: [makeJiraIssueFixture(seedIssues[0]!)],
    })
    const searchIdx = syncRoutes.findIndex((r) =>
      r.match('https://example.atlassian.net/rest/api/3/search/jql'),
    )
    syncRoutes[searchIdx] = {
      match: (u) => u.includes('/rest/api/3/search/jql'),
      handler: () => {
        const all = [makeJiraIssueFixture(seedIssues[0]!), ...createdIssues]
        return jsonResponse({
          startAt: 0,
          maxResults: 100,
          total: all.length,
          issues: all,
        })
      },
    }
    const mutationRoute: StubRoute = {
      match: (u, init) => u.endsWith('/rest/api/3/issue') && (init?.method ?? 'GET') === 'POST',
      handler: () => {
        createdIssues.push(createdIssue)
        return jsonResponse({ id: '601', key: 'ENG-11', self: 'x' })
      },
    }
    const { provider, calls } = makeProvider(db, [mutationRoute, ...syncRoutes])
    await provider.createTask({ title: 'x', project: 'ENG' })
    const postCalls = calls.filter(
      (c) => c.method === 'POST' && c.url.endsWith('/rest/api/3/issue'),
    )
    expect(postCalls).toHaveLength(1)
    const body = JSON.parse(postCalls[0]!.body ?? '{}') as {
      fields: { project: { key: string } }
    }
    expect(body.fields.project.key).toBe('ENG')
  })

  test('updateTask metadata field rejected as UNSUPPORTED_OPERATION', async () => {
    fullSeed(db)
    const { provider, calls } = makeProvider(db, [])
    try {
      await provider.updateTask('ENG-1', { metadata: '{}' })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(KanbanError)
      expect((err as KanbanError).code).toBe(ErrorCode.UNSUPPORTED_OPERATION)
    }
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })
})
