import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import postgres from 'postgres'

import { run } from '../index'
import type { Task, TaskComment } from '../types'

const databaseUrl = process.env['KANBAN_PG_TEST_URL'] ?? process.env['DATABASE_URL']
const pgTest = databaseUrl ? test : test.skip

type StubIssue = {
  id: string
  identifier: string
  title: string
  description: string
  priority: number
  url: string
  createdAt: string
  updatedAt: string
  assignee: { id: string; name: string; displayName: string } | null
  project: { id: string; name: string; url: string; state: string } | null
  state: { id: string; name: string; position: number }
  labels: { nodes: Array<{ id: string; name: string }> }
  comments: { nodes: Array<{ id: string }>; pageInfo: { hasNextPage: boolean; endCursor: null } }
}

type StubComment = {
  id: string
  body: string
  createdAt: string
  updatedAt: string
  user: { id: string; name: string; displayName: string }
}

function expectOk<T>(result: Awaited<ReturnType<typeof run>>): T {
  expect(result.exitCode).toBe(0)
  expect(result.output.ok).toBe(true)
  if (!result.output.ok) throw new Error('expected successful CLI output')
  return result.output.data as T
}

function makeIssue(overrides: Partial<StubIssue> = {}): StubIssue {
  return {
    id: overrides.id ?? 'lin-1',
    identifier: overrides.identifier ?? 'GB-1',
    title: overrides.title ?? 'Postgres cached Linear issue',
    description: overrides.description ?? 'Cached in Postgres',
    priority: overrides.priority ?? 2,
    url: overrides.url ?? 'https://linear.app/issue/GB-1',
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-01-02T00:00:00.000Z',
    assignee: overrides.assignee ?? { id: 'user-1', name: 'Alice', displayName: 'Alice' },
    project: overrides.project ?? {
      id: 'proj-1',
      name: 'Garage',
      url: 'https://linear.app/project/garage',
      state: 'started',
    },
    state: overrides.state ?? { id: 'state-todo', name: 'Todo', position: 0 },
    labels: overrides.labels ?? { nodes: [{ id: 'label-1', name: 'garage' }] },
    comments: overrides.comments ?? {
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  }
}

function linearFetchStub(): typeof fetch {
  const commentsByIssue = new Map<string, StubComment[]>()
  const issues: StubIssue[] = [makeIssue()]
  const states = [
    { id: 'state-todo', name: 'Todo', position: 0, color: '#888', type: 'unstarted' },
    { id: 'state-done', name: 'Done', position: 1, color: '#0a0', type: 'completed' },
  ]
  const team = { id: 'team-1', key: 'GB', name: 'Garage Band', states: { nodes: states } }
  const users = {
    nodes: [
      { id: 'user-1', name: 'Alice', displayName: 'Alice', active: true },
      { id: 'user-2', name: 'Bob', displayName: 'Bob', active: true },
    ],
  }
  const projects = {
    nodes: [
      { id: 'proj-1', name: 'Garage', url: 'https://linear.app/project/garage', state: 'started' },
    ],
  }

  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      query: string
      variables?: Record<string, unknown>
    }
    const query = body.query
    const variables = body.variables ?? {}

    if (query.includes('query TeamSnapshot')) {
      return Response.json({ data: { team } })
    }
    if (query.includes('query Users')) {
      return Response.json({ data: { users } })
    }
    if (query.includes('query Projects')) {
      return Response.json({ data: { projects } })
    }
    if (query.includes('query Issues')) {
      return Response.json({
        data: {
          issues: {
            nodes: issues,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      })
    }
    if (query.includes('mutation CreateIssue')) {
      const input = variables.input as {
        title: string
        description?: string
        priority?: number
        stateId?: string
        assigneeId?: string
        projectId?: string
      }
      const state = states.find((candidate) => candidate.id === input.stateId) ?? states[0]!
      const issue = makeIssue({
        id: 'lin-2',
        identifier: 'GB-2',
        title: input.title,
        description: input.description ?? '',
        priority: input.priority ?? 0,
        state,
        assignee: users.nodes.find((user) => user.id === input.assigneeId) ?? null,
        project: projects.nodes.find((project) => project.id === input.projectId) ?? null,
        updatedAt: '2026-01-03T00:00:00.000Z',
      })
      issues.push(issue)
      return Response.json({ data: { issueCreate: { success: true, issue } } })
    }
    if (query.includes('mutation UpdateIssue')) {
      const issue = issues.find((candidate) => candidate.id === variables.id)
      const input = variables.input as { stateId?: string; title?: string }
      if (issue) {
        if (input.stateId) {
          const state = states.find((candidate) => candidate.id === input.stateId)
          if (state) issue.state = state
        }
        if (input.title) issue.title = input.title
        issue.updatedAt = '2026-01-04T00:00:00.000Z'
      }
      return Response.json({ data: { issueUpdate: { success: true } } })
    }
    if (query.includes('query IssueComments')) {
      const issueId = String(variables.issueId)
      return Response.json({
        data: {
          issue: {
            comments: {
              nodes: commentsByIssue.get(issueId) ?? [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      })
    }
    if (query.includes('query Comment')) {
      const comment = [...commentsByIssue.values()]
        .flat()
        .find((candidate) => candidate.id === variables.id)
      return Response.json({ data: { comment: comment ?? null } })
    }
    if (query.includes('mutation CommentCreate')) {
      const input = variables.input as { issueId: string; body: string }
      const row: StubComment = {
        id: `comment-${(commentsByIssue.get(input.issueId)?.length ?? 0) + 1}`,
        body: input.body,
        createdAt: '2026-01-05T00:00:00.000Z',
        updatedAt: '2026-01-05T00:00:00.000Z',
        user: { id: 'user-1', name: 'Alice', displayName: 'Alice' },
      }
      commentsByIssue.set(input.issueId, [...(commentsByIssue.get(input.issueId) ?? []), row])
      return Response.json({ data: { commentCreate: { success: true, comment: row } } })
    }
    if (query.includes('mutation CommentUpdate')) {
      const row = [...commentsByIssue.values()]
        .flat()
        .find((candidate) => candidate.id === variables.id)
      if (row) {
        row.body = (variables.input as { body: string }).body
        row.updatedAt = '2026-01-06T00:00:00.000Z'
      }
      return Response.json({ data: { commentUpdate: { success: true, comment: row ?? null } } })
    }
    if (query.includes('query IssueHistory')) {
      return Response.json({
        data: {
          issue: {
            history: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      })
    }
    if (query.includes('query IssueTeam')) {
      return Response.json({ data: { issue: { team: { id: 'team-1', key: 'GB' } } } })
    }

    return Response.json({ errors: [{ message: 'unhandled Linear query' }] }, { status: 500 })
  }) as typeof fetch
}

describe('postgres linear provider', () => {
  let previousEnv: Record<string, string | undefined>
  let previousFetch: typeof fetch
  let sql: postgres.Sql | null = null

  beforeEach(async () => {
    previousFetch = globalThis.fetch
    previousEnv = {
      KANBAN_STORAGE: process.env['KANBAN_STORAGE'],
      KANBAN_DATABASE_URL: process.env['KANBAN_DATABASE_URL'],
      KANBAN_PROVIDER: process.env['KANBAN_PROVIDER'],
      LINEAR_API_KEY: process.env['LINEAR_API_KEY'],
      LINEAR_TEAM_ID: process.env['LINEAR_TEAM_ID'],
      KANBAN_SYNC_INTERVAL_MS: process.env['KANBAN_SYNC_INTERVAL_MS'],
    }
    process.env['KANBAN_STORAGE'] = 'postgres'
    process.env['KANBAN_DATABASE_URL'] = databaseUrl
    process.env['KANBAN_PROVIDER'] = 'linear'
    process.env['LINEAR_API_KEY'] = 'linear-key'
    process.env['LINEAR_TEAM_ID'] = 'GB'
    process.env['KANBAN_SYNC_INTERVAL_MS'] = '1000'

    if (databaseUrl) {
      sql = postgres(databaseUrl, { max: 1, onnotice: () => {} })
      await sql`DROP TABLE IF EXISTS linear_activity`
      await sql`DROP TABLE IF EXISTS linear_issues`
      await sql`DROP TABLE IF EXISTS linear_projects`
      await sql`DROP TABLE IF EXISTS linear_users`
      await sql`DROP TABLE IF EXISTS linear_states`
      await sql`DROP TABLE IF EXISTS linear_sync_meta`
    }
    globalThis.fetch = linearFetchStub()
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

  pgTest('lists Linear tasks from a shared Postgres cache through the CLI path', async () => {
    const tasks = expectOk<Task[]>(await run(['task', 'list', '-c', 'Todo']))

    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      id: 'linear:lin-1',
      externalRef: 'GB-1',
      title: 'Postgres cached Linear issue',
      priority: 'high',
      assignee: 'Alice',
      project: 'Garage',
    })
  })

  pgTest('creates, moves, and comments on Linear tasks through Postgres storage', async () => {
    const created = expectOk<Task>(
      await run([
        'task',
        'add',
        'Created through Postgres Linear',
        '-d',
        'from the public CLI path',
        '-p',
        'medium',
        '-a',
        'Alice',
        '--project',
        'Garage',
      ]),
    )

    expect(created).toMatchObject({
      id: 'linear:lin-2',
      externalRef: 'GB-2',
      title: 'Created through Postgres Linear',
      priority: 'medium',
    })

    const moved = expectOk<Task>(await run(['task', 'move', 'GB-2', 'Done']))
    expect(moved.column_id).toBe('state-done')

    const comment = expectOk<TaskComment>(
      await run(['comment', 'add', 'GB-2', 'Garage projection comment']),
    )
    expect(comment).toMatchObject({
      id: 'comment-1',
      task_id: 'linear:lin-2',
      body: 'Garage projection comment',
    })

    const comments = expectOk<TaskComment[]>(await run(['comment', 'list', 'GB-2']))
    expect(comments).toHaveLength(1)
  })
})
