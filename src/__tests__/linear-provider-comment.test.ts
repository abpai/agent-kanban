import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { LinearProvider } from '../providers/linear.ts'
import {
  initLinearCacheSchema,
  replaceStates,
  saveSyncMeta,
  upsertIssues,
} from '../providers/linear-cache.ts'

let db: Database
let originalFetch: typeof fetch
let requests: Array<{ query: string; variables: Record<string, unknown> }>

beforeEach(() => {
  db = new Database(':memory:')
  initLinearCacheSchema(db)
  replaceStates(db, [{ id: 'state-1', name: 'Todo', position: 0 }])
  upsertIssues(db, [
    {
      id: 'issue-1',
      identifier: 'ENG-1',
      title: 'Issue 1',
      stateId: 'state-1',
      stateName: 'Todo',
      statePosition: 0,
      commentCount: 0,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    },
  ])
  saveSyncMeta(db, {
    team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
    lastSyncAt: new Date().toISOString(),
    lastIssueUpdatedAt: '2026-01-02T00:00:00Z',
  })
  originalFetch = globalThis.fetch
  requests = []
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      query: string
      variables: Record<string, unknown>
    }
    requests.push(body)

    if (body.query.includes('mutation CommentCreate')) {
      return new Response(
        JSON.stringify({
          data: {
            commentCreate: {
              success: true,
              comment: {
                id: 'comment-1',
                body: String((body.variables.input as { body: string }).body),
                createdAt: '2026-01-03T00:00:00Z',
                updatedAt: '2026-01-03T00:00:00Z',
                user: { id: 'user-1', displayName: 'Linear User' },
              },
            },
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )
    }

    if (body.query.includes('mutation CommentUpdate')) {
      return new Response(
        JSON.stringify({
          data: {
            commentUpdate: {
              success: true,
              comment: {
                id: String(body.variables.id),
                body: String((body.variables.input as { body: string }).body),
                createdAt: '2026-01-03T00:00:00Z',
                updatedAt: '2026-01-04T00:00:00Z',
                user: { id: 'user-1', displayName: 'Linear User' },
              },
            },
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )
    }

    if (body.query.includes('query Comment(')) {
      return new Response(
        JSON.stringify({
          data: {
            comment: {
              id: String(body.variables.id),
              body: 'one linear comment',
              createdAt: '2026-01-03T00:00:00Z',
              updatedAt: '2026-01-05T00:00:00Z',
              user: { id: 'user-1', displayName: 'Linear User' },
            },
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )
    }

    if (body.query.includes('query IssueComments')) {
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              comments: {
                nodes: [
                  {
                    id: 'comment-1',
                    body: 'first linear comment',
                    createdAt: '2026-01-03T00:00:00Z',
                    updatedAt: '2026-01-03T00:00:00Z',
                    user: { id: 'user-1', displayName: 'Linear User' },
                  },
                  {
                    id: 'comment-2',
                    body: 'second linear comment',
                    createdAt: '2026-01-04T00:00:00Z',
                    updatedAt: '2026-01-04T00:00:00Z',
                    user: { id: 'user-2', displayName: 'Reviewer' },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )
    }

    throw new Error(`Unexpected Linear GraphQL query: ${body.query}`)
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('LinearProvider.comment', () => {
  test('posts the commentCreate mutation and advertises comment capability', async () => {
    const provider = new LinearProvider(db, 'team-1', 'lin_api_test')

    const comment = await provider.comment('ENG-1', 'hello from linear')

    expect(requests[0]?.query).toContain('mutation CommentCreate')
    expect(requests[0]?.variables).toEqual({
      input: {
        issueId: 'issue-1',
        body: 'hello from linear',
      },
    })
    expect(comment).toMatchObject({
      id: 'comment-1',
      task_id: 'linear:issue-1',
      body: 'hello from linear',
      author: 'Linear User',
    })
    expect((await provider.getTask('ENG-1')).comment_count).toBe(1)

    const context = await provider.getContext()
    expect(context.capabilities.comment).toBe(true)
  })

  test('queries issue comments and normalizes them into TaskComment rows', async () => {
    const provider = new LinearProvider(db, 'team-1', 'lin_api_test')

    const comments = await provider.listComments('ENG-1')

    expect(requests[0]?.query).toContain('query IssueComments')
    expect(requests[0]?.variables).toEqual({
      issueId: 'issue-1',
      after: null,
    })
    expect(comments).toEqual([
      {
        id: 'comment-1',
        task_id: 'linear:issue-1',
        body: 'first linear comment',
        author: 'Linear User',
        created_at: '2026-01-03T00:00:00Z',
        updated_at: '2026-01-03T00:00:00Z',
      },
      {
        id: 'comment-2',
        task_id: 'linear:issue-1',
        body: 'second linear comment',
        author: 'Reviewer',
        created_at: '2026-01-04T00:00:00Z',
        updated_at: '2026-01-04T00:00:00Z',
      },
    ])
  })

  test('queries a single Linear comment by id', async () => {
    const provider = new LinearProvider(db, 'team-1', 'lin_api_test')

    const comment = await provider.getComment('ENG-1', 'comment-1')

    expect(requests[0]?.query).toContain('query Comment(')
    expect(requests[0]?.variables).toEqual({ id: 'comment-1' })
    expect(comment).toMatchObject({
      id: 'comment-1',
      task_id: 'linear:issue-1',
      body: 'one linear comment',
      author: 'Linear User',
      updated_at: '2026-01-05T00:00:00Z',
    })
  })

  test('posts the commentUpdate mutation with the provided id', async () => {
    const provider = new LinearProvider(db, 'team-1', 'lin_api_test')

    const comment = await provider.updateComment('ENG-1', 'comment-1', 'edited linear comment')

    expect(requests[0]?.query).toContain('mutation CommentUpdate')
    expect(requests[0]?.variables).toEqual({
      id: 'comment-1',
      input: {
        body: 'edited linear comment',
      },
    })
    expect(comment).toMatchObject({
      id: 'comment-1',
      task_id: 'linear:issue-1',
      body: 'edited linear comment',
    })
  })
})
