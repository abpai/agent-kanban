import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import postgres from 'postgres'

import { run } from '../index'
import type { Task } from '../types'

const databaseUrl = process.env['KANBAN_PG_TEST_URL'] ?? process.env['DATABASE_URL']
const pgTest = databaseUrl ? test : test.skip

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
    for (const route of routes) {
      if (route.match(url)) return route.handler(url, init)
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

const projectFixture = { id: '10000', key: 'ENG', name: 'Engineering' }

function makeIssue(
  overrides: Partial<{
    id: string
    key: string
    summary: string
    updated: string
  }> = {},
): Record<string, unknown> {
  return {
    id: overrides.id ?? '10001',
    key: overrides.key ?? 'ENG-1',
    fields: {
      summary: overrides.summary ?? 'Postgres cached Jira issue',
      description: null,
      status: { id: '10', name: 'To Do' },
      issuetype: { id: '10000', name: 'Task' },
      priority: { id: '2', name: 'High' },
      assignee: { accountId: 'a1', displayName: 'Alice' },
      labels: ['garage'],
      comment: { total: 0 },
      created: '2026-01-01T00:00:00Z',
      updated: overrides.updated ?? '2026-01-02T00:00:00Z',
      project: { id: '10000', key: 'ENG' },
    },
  }
}

function standardRoutes(): StubRoute[] {
  const issues = [makeIssue()]
  const comments: Record<
    string,
    Array<{ id: string; body: unknown; created: string; updated: string }>
  > = {}
  const setIssueStatus = (issueKey: string, statusId: string, name: string): void => {
    const issue = issues.find((candidate) => String(candidate.key) === issueKey) as
      | { fields?: { status?: { id: string; name: string }; updated?: string } }
      | undefined
    if (!issue?.fields?.status) return
    issue.fields.status = { id: statusId, name }
    issue.fields.updated = '2026-01-06T00:00:00Z'
  }
  return [
    {
      match: (url) => url.includes('/rest/api/3/project/ENG/statuses'),
      handler: () =>
        jsonResponse([
          {
            id: 'cat-1',
            name: 'To Do',
            statuses: [
              { id: '10', name: 'To Do' },
              { id: '20', name: 'Done' },
            ],
          },
        ]),
    },
    {
      match: (url) => url.includes('/rest/api/3/project/ENG'),
      handler: () => jsonResponse(projectFixture),
    },
    {
      match: (url) => url.includes('/rest/api/3/user/assignable/search'),
      handler: () => jsonResponse([{ accountId: 'a1', displayName: 'Alice', active: true }]),
    },
    {
      match: (url) => url.includes('/rest/api/3/priority'),
      handler: () => jsonResponse([{ id: '2', name: 'High' }]),
    },
    {
      match: (url) => url.includes('/rest/api/3/issuetype/project'),
      handler: () => jsonResponse([{ id: '10000', name: 'Task' }]),
    },
    {
      match: (url) => url.endsWith('/rest/api/3/issue'),
      handler: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          fields?: { summary?: string }
        }
        const issue = makeIssue({
          id: '10002',
          key: 'ENG-2',
          summary: body.fields?.summary ?? 'Created issue',
          updated: '2026-01-03T00:00:00Z',
        })
        issues.push(issue)
        return jsonResponse(
          { id: '10002', key: 'ENG-2', self: 'https://example/rest/api/3/issue/10002' },
          201,
        )
      },
    },
    {
      match: (url) => /\/rest\/api\/3\/issue\/ENG-\d+\/comment$/.test(new URL(url).pathname),
      handler: async (url, init) => {
        const issueKey = new URL(url).pathname.match(/\/issue\/(ENG-\d+)\/comment/)![1]!
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body ?? '{}')) as { body?: unknown }
          const row = {
            id: `comment-${(comments[issueKey]?.length ?? 0) + 1}`,
            body: body.body,
            created: '2026-01-04T00:00:00Z',
            updated: '2026-01-04T00:00:00Z',
          }
          comments[issueKey] = [...(comments[issueKey] ?? []), row]
          return jsonResponse(row, 201)
        }
        return jsonResponse({
          startAt: 0,
          maxResults: 100,
          total: comments[issueKey]?.length ?? 0,
          comments: comments[issueKey] ?? [],
        })
      },
    },
    {
      match: (url) =>
        /\/rest\/api\/3\/issue\/ENG-\d+\/comment\/comment-\d+$/.test(new URL(url).pathname),
      handler: async (url, init) => {
        const [, issueKey, commentId] = new URL(url).pathname.match(
          /\/issue\/(ENG-\d+)\/comment\/(comment-\d+)$/,
        )!
        const rows = comments[issueKey!] ?? []
        const existing = rows.find((row) => row.id === commentId)
        if (!existing) return jsonResponse({ errorMessages: ['missing'] }, 404)
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body ?? '{}')) as { body?: unknown }
          existing.body = body.body
          existing.updated = '2026-01-05T00:00:00Z'
        }
        return jsonResponse(existing)
      },
    },
    {
      match: (url) => /\/rest\/api\/3\/issue\/ENG-\d+\/transitions$/.test(new URL(url).pathname),
      handler: async (url, init) => {
        const issueKey = new URL(url).pathname.match(/\/issue\/(ENG-\d+)\/transitions$/)![1]!
        if (init?.method === 'POST') {
          setIssueStatus(issueKey, '20', 'Done')
          return new Response(null, { status: 204 })
        }
        return jsonResponse({
          transitions: [{ id: 'move-done', name: 'Done', to: { id: '20', name: 'Done' } }],
        })
      },
    },
    {
      match: (url) => /\/rest\/api\/3\/issue\/[^/]+\/changelog/.test(url),
      handler: () =>
        jsonResponse({
          startAt: 0,
          maxResults: 100,
          total: 0,
          isLast: true,
          values: [],
        }),
    },
    {
      match: (url) => url.includes('/rest/api/3/search/jql'),
      handler: () =>
        jsonResponse({
          startAt: 0,
          maxResults: 100,
          total: issues.length,
          issues,
        }),
    },
  ]
}

function expectOk<T>(result: Awaited<ReturnType<typeof run>>): T {
  expect(result.exitCode).toBe(0)
  expect(result.output.ok).toBe(true)
  if (!result.output.ok) throw new Error('expected successful CLI output')
  return result.output.data as T
}

describe('postgres jira provider', () => {
  let previousEnv: Record<string, string | undefined>
  let previousFetch: typeof fetch
  let sql: postgres.Sql | null = null

  beforeEach(async () => {
    previousFetch = globalThis.fetch
    previousEnv = {
      KANBAN_STORAGE: process.env['KANBAN_STORAGE'],
      KANBAN_DATABASE_URL: process.env['KANBAN_DATABASE_URL'],
      KANBAN_PROVIDER: process.env['KANBAN_PROVIDER'],
      JIRA_BASE_URL: process.env['JIRA_BASE_URL'],
      JIRA_EMAIL: process.env['JIRA_EMAIL'],
      JIRA_API_TOKEN: process.env['JIRA_API_TOKEN'],
      JIRA_PROJECT_KEY: process.env['JIRA_PROJECT_KEY'],
      KANBAN_SYNC_INTERVAL_MS: process.env['KANBAN_SYNC_INTERVAL_MS'],
    }

    process.env['KANBAN_STORAGE'] = 'postgres'
    process.env['KANBAN_DATABASE_URL'] = databaseUrl
    process.env['KANBAN_PROVIDER'] = 'jira'
    process.env['JIRA_BASE_URL'] = 'https://example.atlassian.net'
    process.env['JIRA_EMAIL'] = 'user@example.com'
    process.env['JIRA_API_TOKEN'] = 'token'
    process.env['JIRA_PROJECT_KEY'] = 'ENG'
    process.env['KANBAN_SYNC_INTERVAL_MS'] = '1000'

    if (databaseUrl) {
      sql = postgres(databaseUrl, { max: 1, onnotice: () => {} })
      await sql`DROP TABLE IF EXISTS jira_activity`
      await sql`DROP TABLE IF EXISTS jira_issues`
      await sql`DROP TABLE IF EXISTS jira_issue_types`
      await sql`DROP TABLE IF EXISTS jira_priorities`
      await sql`DROP TABLE IF EXISTS jira_users`
      await sql`DROP TABLE IF EXISTS jira_columns`
      await sql`DROP TABLE IF EXISTS jira_sync_meta`
    }

    globalThis.fetch = jiraFetchStub(standardRoutes()).fn
  })

  afterEach(async () => {
    globalThis.fetch = previousFetch
    if (sql) {
      await sql.end({ timeout: 1 })
      sql = null
    }
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  pgTest('lists Jira tasks from a shared Postgres cache through the CLI path', async () => {
    const tasks = expectOk<Task[]>(await run(['task', 'list', '-c', 'To Do']))

    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      id: 'jira:10001',
      externalRef: 'ENG-1',
      title: 'Postgres cached Jira issue',
      priority: 'high',
      assignee: 'Alice',
      project: 'ENG',
    })
  })

  pgTest('creates Jira tasks and writes comments through Postgres storage', async () => {
    const created = expectOk<Task>(
      await run(['task', 'add', 'Created through Postgres Jira', '-p', 'high', '-a', 'Alice']),
    )

    expect(created).toMatchObject({
      id: 'jira:10002',
      externalRef: 'ENG-2',
      title: 'Created through Postgres Jira',
      priority: 'high',
      assignee: 'Alice',
    })

    const comment = expectOk(await run(['comment', 'add', 'ENG-2', 'Garage projection comment']))
    expect(comment).toMatchObject({
      id: 'comment-1',
      task_id: 'jira:10002',
      body: 'Garage projection comment',
    })

    const comments = expectOk(await run(['comment', 'list', 'ENG-2']))
    expect(comments).toHaveLength(1)
  })

  pgTest('moves Jira tasks through Postgres storage', async () => {
    const moved = expectOk<Task>(await run(['task', 'move', 'ENG-1', 'Done']))

    expect(moved).toMatchObject({
      id: 'jira:10001',
      externalRef: 'ENG-1',
      column_id: '20',
    })
  })
})
