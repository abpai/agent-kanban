import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { ErrorCode, KanbanError } from '../errors.ts'
import { JiraClient } from '../providers/jira-client.ts'
import { JiraProvider, type JiraProviderConfig } from '../providers/jira.ts'
import {
  getCachedColumns,
  getCachedTasks,
  decodeColumnStatusIds,
  loadTeamInfo,
  saveTeamInfo,
  initJiraCacheSchema,
} from '../providers/jira-cache.ts'

type FetchInit = RequestInit | undefined
type StubCall = { url: string; init?: FetchInit }
type StubHandler = (url: string, init?: FetchInit) => Response | Promise<Response>
type StubRoute = { match: (url: string) => boolean; handler: StubHandler }

function jiraFetchStub(routes: StubRoute[]): {
  fn: typeof fetch
  calls: StubCall[]
} {
  const calls: StubCall[] = []
  const fn = (async (input: string | URL | Request, init?: FetchInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url, init })
    for (const r of routes) {
      if (r.match(url)) return r.handler(url, init)
    }
    return new Response('route not stubbed: ' + url, { status: 500 })
  }) as unknown as typeof fetch
  return { fn, calls }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const baseConfig: JiraProviderConfig = {
  baseUrl: 'https://example.atlassian.net',
  email: 'user@example.com',
  apiToken: 'token',
  projectKey: 'ENG',
}

const projectFixture = { id: '10000', key: 'ENG', name: 'Engineering' }
const usersFixture = [
  { accountId: 'a1', displayName: 'Alice', active: true },
  { accountId: 'a2', displayName: 'Bob', active: true },
]
const prioritiesFixture = [
  { id: '1', name: 'Highest' },
  { id: '2', name: 'High' },
]
const issueTypesFixture = [{ id: '10000', name: 'Bug' }]

function makeIssue(opts: {
  id: string
  key: string
  statusId: string
  updated?: string
  summary?: string
  assignee?: { accountId: string; displayName: string } | null
}): Record<string, unknown> {
  return {
    id: opts.id,
    key: opts.key,
    fields: {
      summary: opts.summary ?? opts.key,
      description: null,
      status: { id: opts.statusId, name: 'Status ' + opts.statusId },
      issuetype: { id: '10000', name: 'Bug' },
      priority: { id: '2', name: 'High' },
      assignee: opts.assignee ?? null,
      created: '2026-01-01T00:00:00Z',
      updated: opts.updated ?? '2026-01-02T00:00:00Z',
      project: { id: '10000', key: 'ENG' },
    },
  }
}

const boardConfigFixture = {
  id: 3,
  name: 'ENG Board',
  columnConfig: {
    columns: [{ name: 'Done', statuses: [{ id: '10001' }, { id: '10002' }] }],
  },
}

const statusCategoriesFixture = [
  {
    id: 'cat-1',
    name: 'To Do',
    statuses: [
      { id: '10001', name: 'To Do' },
      { id: '10002', name: 'In Progress' },
      { id: '10003', name: 'Done' },
    ],
  },
]

function standardRoutes(opts: {
  boardCfg?: unknown
  statuses?: unknown
  users?: unknown
  priorities?: unknown
  issueTypes?: unknown
  searchHandler?: StubHandler
}): StubRoute[] {
  return [
    {
      match: (u) => u.includes('/rest/api/3/project/ENG/statuses'),
      handler: () => jsonResponse(opts.statuses ?? statusCategoriesFixture),
    },
    {
      match: (u) => u.includes('/rest/api/3/project/ENG'),
      handler: () => jsonResponse(projectFixture),
    },
    {
      match: (u) => u.includes('/rest/agile/1.0/board/'),
      handler: () => jsonResponse(opts.boardCfg ?? boardConfigFixture),
    },
    {
      match: (u) => u.includes('/rest/api/3/user/assignable/search'),
      handler: () => jsonResponse(opts.users ?? usersFixture),
    },
    {
      match: (u) => u.includes('/rest/api/3/priority'),
      handler: () => jsonResponse(opts.priorities ?? prioritiesFixture),
    },
    {
      match: (u) => u.includes('/rest/api/3/issuetype/project'),
      handler: () => jsonResponse(opts.issueTypes ?? issueTypesFixture),
    },
    {
      match: (u) => u.includes('/rest/api/3/search'),
      handler:
        opts.searchHandler ??
        (() =>
          jsonResponse({
            startAt: 0,
            maxResults: 100,
            total: 0,
            issues: [],
          })),
    },
  ]
}

let db: Database
let originalFetch: typeof fetch
let originalDateNow: () => number

beforeEach(() => {
  db = new Database(':memory:')
  originalFetch = globalThis.fetch
  originalDateNow = Date.now
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Date.now = originalDateNow
})

function makeProvider(routes: StubRoute[]): {
  provider: JiraProvider
  calls: StubCall[]
  config: JiraProviderConfig
} {
  const { fn, calls } = jiraFetchStub(routes)
  globalThis.fetch = fn
  const client = new JiraClient({
    baseUrl: baseConfig.baseUrl,
    email: baseConfig.email,
    apiToken: baseConfig.apiToken,
  })
  const provider = new JiraProvider(db, baseConfig, client)
  return { provider, calls, config: baseConfig }
}

function makeProviderWithBoard(
  routes: StubRoute[],
  boardId: number,
): {
  provider: JiraProvider
  calls: StubCall[]
} {
  const { fn, calls } = jiraFetchStub(routes)
  globalThis.fetch = fn
  const cfg = { ...baseConfig, boardId }
  const client = new JiraClient({
    baseUrl: cfg.baseUrl,
    email: cfg.email,
    apiToken: cfg.apiToken,
  })
  const provider = new JiraProvider(db, cfg, client)
  return { provider, calls }
}

describe('JiraProvider read path', () => {
  test('sync populates columns from board with multi-status mapping', async () => {
    const { provider } = makeProviderWithBoard(standardRoutes({}), 3)
    await provider.getBoard()
    const cols = getCachedColumns(db)
    expect(cols).toHaveLength(1)
    expect(cols[0]!.source).toBe('board')
    expect(cols[0]!.position).toBe(0)
    expect(decodeColumnStatusIds(cols[0]!)).toEqual(['10001', '10002'])
  })

  test('sync populates columns from statuses when boardId is absent', async () => {
    const { provider } = makeProvider(standardRoutes({}))
    await provider.getBoard()
    const cols = getCachedColumns(db)
    expect(cols).toHaveLength(3)
    for (const c of cols) {
      expect(c.source).toBe('status')
      expect(decodeColumnStatusIds(c)).toHaveLength(1)
    }
  })

  test('sync delta JQL is exactly project = KEY AND updated >= "<ts>" ORDER BY updated ASC', async () => {
    const capturedJql: string[] = []
    // First sync: one issue returned so lastIssueUpdatedAt is set.
    const searchHandler: StubHandler = (url) => {
      const parsed = new URL(url)
      const jql = parsed.searchParams.get('jql') ?? ''
      capturedJql.push(jql)
      const startAt = Number(parsed.searchParams.get('startAt') ?? '0')
      if (startAt === 0 && capturedJql.length === 1) {
        return jsonResponse({
          startAt: 0,
          maxResults: 100,
          total: 1,
          issues: [
            makeIssue({
              id: '99',
              key: 'ENG-99',
              statusId: '10001',
              updated: '2026-01-05T00:00:00Z',
            }),
          ],
        })
      }
      return jsonResponse({ startAt: 0, maxResults: 100, total: 0, issues: [] })
    }
    const { provider } = makeProviderWithBoard(standardRoutes({ searchHandler }), 3)
    await provider.getBoard()
    expect(capturedJql[0]).toBe(
      'project = ENG AND updated >= "1970-01-01 00:00" ORDER BY updated ASC',
    )

    // Advance clock past throttle so second sync runs.
    const origNow = originalDateNow
    Date.now = () => origNow() + 31_000
    await provider.getBoard()
    expect(capturedJql[1]).toBe(
      'project = ENG AND updated >= "2026-01-05T00:00:00Z" ORDER BY updated ASC',
    )
  })

  test('listTasks filters by columnId with many-to-one mapping', async () => {
    const { provider } = makeProvider(standardRoutes({}))
    // Sync first (populates statuses-based columns)
    await provider.getBoard()
    // Overwrite with the test-scenario columns + issues directly.
    const { replaceJiraColumns, upsertJiraIssues } = await import('../providers/jira-cache.ts')
    replaceJiraColumns(db, [
      {
        id: 'board:3:Done',
        name: 'Done',
        position: 0,
        statusIds: ['10001', '10002'],
        source: 'board',
      },
      {
        id: 'status:99999',
        name: 'Other',
        position: 1,
        statusIds: ['99999'],
        source: 'status',
      },
    ])
    upsertJiraIssues(db, [
      {
        id: '1',
        key: 'ENG-1',
        summary: 'a',
        descriptionText: '',
        statusId: '10001',
        projectKey: 'ENG',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      {
        id: '2',
        key: 'ENG-2',
        summary: 'b',
        descriptionText: '',
        statusId: '10002',
        projectKey: 'ENG',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      },
      {
        id: '3',
        key: 'ENG-3',
        summary: 'c',
        descriptionText: '',
        statusId: '99999',
        projectKey: 'ENG',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-03T00:00:00Z',
      },
    ])
    // Throttle is set; listTasks will not re-fetch.
    const byName = await provider.listTasks({ column: 'Done' })
    expect(byName).toHaveLength(2)
    const byId = await provider.listTasks({ column: 'status:99999' })
    expect(byId).toHaveLength(1)
    const all = await provider.listTasks({})
    expect(all).toHaveLength(3)
  })

  test('getTask accepts both id and key', async () => {
    const searchHandler: StubHandler = () =>
      jsonResponse({
        startAt: 0,
        maxResults: 100,
        total: 1,
        issues: [makeIssue({ id: '10001', key: 'ENG-1', statusId: '10001' })],
      })
    const { provider } = makeProvider(standardRoutes({ searchHandler }))
    await provider.getBoard()
    const byId = await provider.getTask('10001')
    expect(byId.externalRef).toBe('ENG-1')
    const byKey = await provider.getTask('ENG-1')
    expect(byKey.externalRef).toBe('ENG-1')
    const byPrefixed = await provider.getTask('jira:10001')
    expect(byPrefixed.externalRef).toBe('ENG-1')
  })

  test('getBootstrap returns provider=jira and the adapted BoardConfig', async () => {
    const { provider } = makeProvider(standardRoutes({}))
    const result = await provider.getBootstrap()
    expect(result.provider).toBe('jira')
    expect(result.capabilities.taskMove).toBe(true)
    expect(result.capabilities.taskDelete).toBe(false)
    expect(result.config.provider).toBe('jira')
    expect(Array.isArray(result.config.members)).toBe(true)
    expect(result.config.members.length).toBeGreaterThan(0)
    expect(result.config.projects).toEqual(['ENG'])
    expect('priorities' in result.config).toBe(false)
  })

  test('getContext returns capabilities.taskMove=true and capabilities.taskDelete=false', async () => {
    const { provider } = makeProvider(standardRoutes({}))
    const ctx = await provider.getContext()
    expect(ctx.capabilities.taskMove).toBe(true)
    expect(ctx.capabilities.taskCreate).toBe(true)
    expect(ctx.capabilities.taskUpdate).toBe(true)
    expect(ctx.capabilities.taskDelete).toBe(false)
    expect(ctx.capabilities.activity).toBe(false)
    expect(ctx.capabilities.metrics).toBe(false)
    expect(ctx.capabilities.columnCrud).toBe(false)
    expect(ctx.capabilities.bulk).toBe(false)
    expect(ctx.capabilities.configEdit).toBe(false)
    expect(ctx.team).not.toBeNull()
    expect(ctx.team?.name).toBe('Engineering')
  })

  test('getConfig adapter: members/projects present, priorities/issueTypes absent at BoardConfig level', async () => {
    const { provider } = makeProvider(standardRoutes({}))
    const config = await provider.getConfig()
    expect(config.projects[0]).toBe('ENG')
    expect(config.members.length).toBeGreaterThan(0)
    const keys = Object.keys(config)
    expect(keys).not.toContain('priorities')
    expect(keys).not.toContain('issueTypes')
    expect(keys).not.toContain('users')
  })

  test('sync throttle: two consecutive sync calls within 30s produce zero remote fetches on the second', async () => {
    const { provider, calls } = makeProvider(standardRoutes({}))
    await provider.getBoard()
    const first = calls.length
    expect(first).toBeGreaterThan(0)
    await provider.getBoard()
    expect(calls.length).toBe(first)
    // Advance Date.now past the throttle window.
    const origNow = originalDateNow
    Date.now = () => origNow() + 31_000
    await provider.getBoard()
    expect(calls.length).toBeGreaterThanOrEqual(first + 2)
  })

  test('listColumns returns Column[] shape, not JiraColumnRow[]', async () => {
    const { provider } = makeProvider(standardRoutes({}))
    const cols = await provider.listColumns()
    expect(cols.length).toBeGreaterThanOrEqual(1)
    for (const col of cols) {
      expect('id' in col).toBe(true)
      expect('name' in col).toBe(true)
      expect('position' in col).toBe(true)
      expect('color' in col).toBe(true)
      expect('created_at' in col).toBe(true)
      expect('updated_at' in col).toBe(true)
      expect('status_ids' in col).toBe(false)
      expect('source' in col).toBe(false)
    }
  })

  test('listTasks with non-existent column name throws COLUMN_NOT_FOUND', async () => {
    // Board mode so only 'board:3:Done' column exists.
    const { provider } = makeProviderWithBoard(standardRoutes({}), 3)
    await provider.getBoard()
    try {
      await provider.listTasks({ column: 'Bogus' })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(KanbanError)
      expect((err as KanbanError).code).toBe(ErrorCode.COLUMN_NOT_FOUND)
    }
  })

  test('sync paginates listIssues across multiple pages', async () => {
    const searchCalls: Array<{ startAt: number }> = []
    const page1Issues = Array.from({ length: 100 }, (_, i) =>
      makeIssue({
        id: String(i + 1),
        key: `ENG-${i + 1}`,
        statusId: '10001',
        updated: '2026-01-02T00:00:00Z',
      }),
    )
    const page2Issues = Array.from({ length: 50 }, (_, i) =>
      makeIssue({
        id: String(i + 101),
        key: `ENG-${i + 101}`,
        statusId: '10001',
        updated: '2026-01-02T00:00:00Z',
      }),
    )
    const searchHandler: StubHandler = (url) => {
      const parsed = new URL(url)
      const startAt = Number(parsed.searchParams.get('startAt') ?? '0')
      searchCalls.push({ startAt })
      if (startAt === 0) {
        return jsonResponse({
          startAt: 0,
          maxResults: 100,
          total: 150,
          issues: page1Issues,
        })
      }
      if (startAt === 100) {
        return jsonResponse({
          startAt: 100,
          maxResults: 100,
          total: 150,
          issues: page2Issues,
        })
      }
      return jsonResponse({
        startAt,
        maxResults: 100,
        total: 150,
        issues: [],
      })
    }
    const { provider } = makeProviderWithBoard(standardRoutes({ searchHandler }), 3)
    await provider.getBoard()
    expect(searchCalls).toHaveLength(2)
    expect(searchCalls[0]!.startAt).toBe(0)
    expect(searchCalls[1]!.startAt).toBe(100)
    expect(getCachedTasks(db)).toHaveLength(150)
  })

  test('saveTeamInfo / loadTeamInfo roundtrip', () => {
    initJiraCacheSchema(db)
    saveTeamInfo(db, { id: '10000', key: 'ENG', name: 'Engineering' })
    const loaded = loadTeamInfo(db)
    expect(loaded).toEqual({ id: '10000', key: 'ENG', name: 'Engineering' })
    saveTeamInfo(db, null)
    expect(loadTeamInfo(db)).toBeNull()
  })
})
