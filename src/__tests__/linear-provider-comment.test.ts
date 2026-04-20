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
let captured: { query: string; variables: Record<string, unknown> } | null

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
  captured = null
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      query: string
      variables: Record<string, unknown>
    }
    captured = body
    return new Response(JSON.stringify({ data: { commentCreate: { success: true } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('LinearProvider.comment', () => {
  test('posts the commentCreate mutation and advertises comment capability', async () => {
    const provider = new LinearProvider(db, 'team-1', 'lin_api_test')

    await provider.comment('ENG-1', 'hello from linear')

    expect(captured?.query).toContain('mutation CommentCreate')
    expect(captured?.variables).toEqual({
      input: {
        issueId: 'issue-1',
        body: 'hello from linear',
      },
    })

    const context = await provider.getContext()
    expect(context.capabilities.comment).toBe(true)
  })
})
