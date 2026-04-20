import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { JiraClient } from '../providers/jira-client.ts'
import { JiraProvider, type JiraProviderConfig } from '../providers/jira.ts'
import {
  initJiraCacheSchema,
  saveJiraSyncMeta,
  saveTeamInfo,
  upsertJiraIssues,
} from '../providers/jira-cache.ts'

const baseConfig: JiraProviderConfig = {
  baseUrl: 'https://example.atlassian.net',
  email: 'user@example.com',
  apiToken: 'token',
  projectKey: 'ENG',
}

let db: Database
let originalFetch: typeof fetch
let requests: Array<{ url: string; init?: RequestInit }>

beforeEach(() => {
  db = new Database(':memory:')
  initJiraCacheSchema(db)
  saveJiraSyncMeta(db, {
    projectKey: 'ENG',
    boardId: null,
    lastSyncAt: new Date().toISOString(),
    lastIssueUpdatedAt: '2026-01-02T00:00:00Z',
  })
  saveTeamInfo(db, { id: '10000', key: 'ENG', name: 'Engineering' })
  upsertJiraIssues(db, [
    {
      id: '10001',
      key: 'ENG-1',
      summary: 'Issue 1',
      descriptionText: '',
      statusId: '10000',
      priorityName: 'High',
      issueTypeName: 'Task',
      assigneeAccountId: null,
      assigneeName: '',
      labels: [],
      commentCount: 0,
      projectKey: 'ENG',
      url: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    },
  ])
  originalFetch = globalThis.fetch
  requests = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = {
      url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      init,
    }
    requests.push(request)

    if (init?.method === 'POST') {
      return new Response(
        JSON.stringify({
          id: 'comment-1',
          body: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello from jira' }] }],
          },
          created: '2026-01-03T00:00:00Z',
          updated: '2026-01-03T00:00:00Z',
          author: { displayName: 'Jira User' },
        }),
        {
          status: 201,
          headers: { 'content-type': 'application/json' },
        },
      )
    }

    if (init?.method === 'GET' && /\/comment\/[^/?]+$/.test(request.url)) {
      return new Response(
        JSON.stringify({
          id: 'comment-1',
          body: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one jira comment' }] }],
          },
          created: '2026-01-03T00:00:00Z',
          updated: '2026-01-05T00:00:00Z',
          author: { displayName: 'Jira User' },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )
    }

    if (init?.method === 'GET') {
      return new Response(
        JSON.stringify({
          startAt: 0,
          maxResults: 100,
          total: 2,
          comments: [
            {
              id: 'comment-1',
              body: {
                type: 'doc',
                content: [
                  { type: 'paragraph', content: [{ type: 'text', text: 'first jira comment' }] },
                ],
              },
              created: '2026-01-03T00:00:00Z',
              updated: '2026-01-03T00:00:00Z',
              author: { displayName: 'Jira User' },
            },
            {
              id: 'comment-2',
              body: {
                type: 'doc',
                content: [
                  { type: 'paragraph', content: [{ type: 'text', text: 'second jira comment' }] },
                ],
              },
              created: '2026-01-04T00:00:00Z',
              updated: '2026-01-04T00:00:00Z',
              author: { displayName: 'Reviewer' },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )
    }

    if (init?.method === 'PUT') {
      return new Response(
        JSON.stringify({
          id: 'comment-1',
          body: {
            type: 'doc',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'edited jira comment' }] },
            ],
          },
          created: '2026-01-03T00:00:00Z',
          updated: '2026-01-04T00:00:00Z',
          author: { displayName: 'Jira User' },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )
    }

    if (init?.method === 'DELETE') {
      return new Response(null, { status: 204 })
    }

    throw new Error(`Unexpected Jira request: ${request.url}`)
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('JiraProvider.comment', () => {
  test('posts an ADF comment to the Jira issue endpoint and advertises comment capability', async () => {
    const client = new JiraClient({
      baseUrl: baseConfig.baseUrl,
      email: baseConfig.email,
      apiToken: baseConfig.apiToken,
    })
    const provider = new JiraProvider(db, baseConfig, client)

    const comment = await provider.comment('ENG-1', 'hello from jira')

    expect(requests[0]?.url).toBe('https://example.atlassian.net/rest/api/3/issue/ENG-1/comment')
    expect(requests[0]?.init?.method).toBe('POST')
    const body = JSON.parse(String(requests[0]?.init?.body)) as {
      body: { type: string; content: unknown[] }
    }
    expect(body.body.type).toBe('doc')
    expect(body.body.content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'hello from jira' }] },
    ])
    expect(comment).toMatchObject({
      id: 'comment-1',
      task_id: 'jira:10001',
      body: 'hello from jira',
      author: 'Jira User',
    })
    expect((await provider.getTask('ENG-1')).comment_count).toBe(1)

    const context = await provider.getContext()
    expect(context.capabilities.comment).toBe(true)
  })

  test('gets Jira issue comments and normalizes them into TaskComment rows', async () => {
    const client = new JiraClient({
      baseUrl: baseConfig.baseUrl,
      email: baseConfig.email,
      apiToken: baseConfig.apiToken,
    })
    const provider = new JiraProvider(db, baseConfig, client)

    const comments = await provider.listComments('ENG-1')

    expect(requests[0]?.url).toBe(
      'https://example.atlassian.net/rest/api/3/issue/ENG-1/comment?startAt=0&maxResults=100',
    )
    expect(requests[0]?.init?.method).toBe('GET')
    expect(comments).toEqual([
      {
        id: 'comment-1',
        task_id: 'jira:10001',
        body: 'first jira comment',
        author: 'Jira User',
        created_at: '2026-01-03T00:00:00Z',
        updated_at: '2026-01-03T00:00:00Z',
      },
      {
        id: 'comment-2',
        task_id: 'jira:10001',
        body: 'second jira comment',
        author: 'Reviewer',
        created_at: '2026-01-04T00:00:00Z',
        updated_at: '2026-01-04T00:00:00Z',
      },
    ])
  })

  test('gets a single Jira issue comment by id', async () => {
    const client = new JiraClient({
      baseUrl: baseConfig.baseUrl,
      email: baseConfig.email,
      apiToken: baseConfig.apiToken,
    })
    const provider = new JiraProvider(db, baseConfig, client)

    const comment = await provider.getComment('ENG-1', 'comment-1')

    expect(requests[0]?.url).toBe(
      'https://example.atlassian.net/rest/api/3/issue/ENG-1/comment/comment-1',
    )
    expect(requests[0]?.init?.method).toBe('GET')
    expect(comment).toMatchObject({
      id: 'comment-1',
      task_id: 'jira:10001',
      body: 'one jira comment',
      author: 'Jira User',
      updated_at: '2026-01-05T00:00:00Z',
    })
  })

  test('puts an updated ADF comment to the Jira issue comment endpoint', async () => {
    const client = new JiraClient({
      baseUrl: baseConfig.baseUrl,
      email: baseConfig.email,
      apiToken: baseConfig.apiToken,
    })
    const provider = new JiraProvider(db, baseConfig, client)

    const comment = await provider.updateComment('ENG-1', 'comment-1', 'edited jira comment')

    expect(requests[0]?.url).toBe(
      'https://example.atlassian.net/rest/api/3/issue/ENG-1/comment/comment-1',
    )
    expect(requests[0]?.init?.method).toBe('PUT')
    expect(comment).toMatchObject({
      id: 'comment-1',
      task_id: 'jira:10001',
      body: 'edited jira comment',
    })
  })
})
