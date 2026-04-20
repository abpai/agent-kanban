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
let captured: { url: string; init?: RequestInit } | null

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
  captured = null
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    captured = {
      url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      init,
    }
    return new Response(JSON.stringify({ id: 'comment-1' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })
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

    await provider.comment('ENG-1', 'hello from jira')

    expect(captured?.url).toBe('https://example.atlassian.net/rest/api/3/issue/ENG-1/comment')
    expect(captured?.init?.method).toBe('POST')
    const body = JSON.parse(String(captured?.init?.body)) as {
      body: { type: string; content: unknown[] }
    }
    expect(body.body.type).toBe('doc')
    expect(body.body.content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'hello from jira' }] },
    ])

    const context = await provider.getContext()
    expect(context.capabilities.comment).toBe(true)
  })
})
