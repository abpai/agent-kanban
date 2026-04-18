import { afterEach, describe, expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { ErrorCode, KanbanError } from '../errors.ts'
import { JiraClient } from '../providers/jira-client.ts'

const origFetch = globalThis.fetch
let lastRequest: { url: string; init?: RequestInit } | null = null

afterEach(() => {
  globalThis.fetch = origFetch
  lastRequest = null
})

function stub(response: Response): void {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    lastRequest = { url: String(url), init }
    return response
  }) as unknown as typeof fetch
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeClient(): JiraClient {
  return new JiraClient({
    baseUrl: 'https://example.atlassian.net/',
    email: 'user@example.com',
    apiToken: 'tok123',
  })
}

describe('JiraClient', () => {
  test('auth header format', async () => {
    stub(jsonResponse({ id: '10000', key: 'ABC', name: 'Alpha' }))
    const client = makeClient()
    await client.getProject('ABC')
    expect(lastRequest).not.toBeNull()
    const headers = (lastRequest!.init!.headers ?? {}) as Record<string, string>
    const expected = `Basic ${Buffer.from('user@example.com:tok123').toString('base64')}`
    expect(headers.Authorization).toBe(expected)
    expect(headers.Accept).toBe('application/json')
    expect(headers['Content-Type']).toBe('application/json')
    expect(lastRequest!.url).toBe('https://example.atlassian.net/rest/api/3/project/ABC')
  })

  test('happy path getIssue', async () => {
    const body = {
      id: '10001',
      key: 'ABC-1',
      fields: {
        summary: 'hello',
        status: { id: '1', name: 'To Do' },
        issuetype: { id: '10000', name: 'Task' },
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-02T00:00:00.000Z',
      },
    }
    stub(jsonResponse(body))
    const client = makeClient()
    const issue = await client.getIssue('ABC-1')
    expect(issue.key).toBe('ABC-1')
    expect(issue.fields.summary).toBe('hello')
    expect(issue.fields.status.name).toBe('To Do')
  })

  test('401 maps to PROVIDER_AUTH_FAILED', async () => {
    stub(new Response('', { status: 401 }))
    const client = makeClient()
    let err: unknown
    try {
      await client.getIssue('ABC-1')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(KanbanError)
    expect((err as KanbanError).code).toBe(ErrorCode.PROVIDER_AUTH_FAILED)
  })

  test('403 maps to PROVIDER_AUTH_FAILED', async () => {
    stub(new Response('', { status: 403 }))
    const client = makeClient()
    let err: unknown
    try {
      await client.getIssue('ABC-1')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(KanbanError)
    expect((err as KanbanError).code).toBe(ErrorCode.PROVIDER_AUTH_FAILED)
  })

  test('429 maps to PROVIDER_RATE_LIMITED', async () => {
    stub(new Response('', { status: 429 }))
    const client = makeClient()
    let err: unknown
    try {
      await client.getIssue('ABC-1')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(KanbanError)
    expect((err as KanbanError).code).toBe(ErrorCode.PROVIDER_RATE_LIMITED)
  })

  test('400 with errorMessages and errors maps to PROVIDER_UPSTREAM_ERROR', async () => {
    stub(
      jsonResponse(
        {
          errorMessages: ['Field required'],
          errors: { summary: 'is required' },
        },
        400,
      ),
    )
    const client = makeClient()
    let err: unknown
    try {
      await client.createIssue({ fields: {} })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(KanbanError)
    const ke = err as KanbanError
    expect(ke.code).toBe(ErrorCode.PROVIDER_UPSTREAM_ERROR)
    expect(ke.message).toContain('Field required')
    expect(ke.message).toContain('summary')
    expect(ke.message).toContain('is required')
  })

  test('listIssues pagination passes startAt and maxResults as query params', async () => {
    stub(jsonResponse({ startAt: 50, maxResults: 100, total: 0, issues: [] }))
    const client = makeClient()
    await client.listIssues({
      jql: 'project = ABC',
      startAt: 50,
      maxResults: 100,
    })
    expect(lastRequest).not.toBeNull()
    const url = lastRequest!.url
    expect(url).toContain('startAt=50')
    expect(url).toContain('maxResults=100')
    // URLSearchParams canonical form uses '+' for spaces and %3D for '='
    expect(url).toContain('jql=project+%3D+ABC')
  })

  test('updateIssue succeeds on HTTP 204 without JSON parse', async () => {
    stub(new Response(null, { status: 204 }))
    const client = makeClient()
    const result = await client.updateIssue('ABC-1', {
      fields: { summary: 'new' },
    })
    expect(result).toBeUndefined()
  })

  test('transitionIssue succeeds on HTTP 204', async () => {
    stub(new Response(null, { status: 204 }))
    const client = makeClient()
    await client.transitionIssue('ABC-1', '11')
    expect(lastRequest).not.toBeNull()
    expect(lastRequest!.init!.method).toBe('POST')
    const sentBody = String(lastRequest!.init!.body)
    expect(sentBody).toContain('"transition":{"id":"11"}')
  })
})
