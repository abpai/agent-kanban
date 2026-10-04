import { mockFetch } from './helpers/fetch'
import { assertKanbanError } from './helpers/errors'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { ErrorCode, type KanbanError } from '../errors'
import { initSchema, seedDefaultColumns, addTask } from '../db'
import { JiraClient, attachmentDownloadTimeoutMs } from '../providers/jira-client'
import { JiraProvider, type JiraProviderConfig } from '../providers/jira'
import { LinearProvider } from '../providers/linear'
import { LocalProvider } from '../providers/local'
import {
  initJiraCacheSchema,
  saveJiraSyncMeta,
  saveTeamInfo,
  upsertJiraIssues,
} from '../providers/jira-cache'
import { initLinearCacheSchema } from '../providers/linear-cache'

const baseConfig: JiraProviderConfig = {
  baseUrl: 'https://example.atlassian.net',
  email: 'user@example.com',
  apiToken: 'token',
  projectKey: 'ENG',
}

const ISSUE_URL = 'https://example.atlassian.net/rest/api/3/issue/ENG-1?fields=attachment'
const CONTENT_URL =
  'https://example.atlassian.net/rest/api/3/attachment/content/att-1?redirect=false'

const specBytes = new TextEncoder().encode('# spec\n\nread me\n')

const jiraAttachments = [
  {
    id: 'att-1',
    filename: 'spec.md',
    mimeType: 'text/markdown',
    size: specBytes.byteLength,
    created: '2026-01-03T00:00:00Z',
    author: { accountId: 'u1', displayName: 'Jira User' },
  },
  {
    id: 'att-2',
    filename: 'packet.zip',
    mimeType: 'application/zip',
    size: 9_800_000,
    created: '2026-01-04T00:00:00Z',
  },
]

let db: Database
let originalFetch: typeof fetch
let requests: Array<{ url: string; init?: RequestInit }>
let issueReply: () => Response
let contentReply: () => Response

function issueResponse(): Response {
  const issue = { id: '10001', key: 'ENG-1', fields: { attachment: jiraAttachments } }
  return new Response(JSON.stringify(issue), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function bytesResponse(bytes: Uint8Array, headers: Record<string, string> = {}): Response {
  return new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'text/markdown', ...headers },
  })
}

/** A body that never ends: 1 KiB per pull until the reader cancels it. */
function endlessBody(onCancel: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(1024))
    },
    cancel() {
      onCancel()
    },
  })
}

function makeProvider(): JiraProvider {
  const client = new JiraClient({
    baseUrl: baseConfig.baseUrl,
    email: baseConfig.email,
    apiToken: baseConfig.apiToken,
  })
  return new JiraProvider(db, baseConfig, client)
}

async function failure<T>(run: () => Promise<T>): Promise<KanbanError> {
  try {
    await run()
  } catch (error) {
    assertKanbanError(error)
    return error
  }
  throw new Error('expected the call to fail')
}

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
  issueReply = issueResponse
  contentReply = () => bytesResponse(specBytes)
  globalThis.fetch = mockFetch(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString()
    requests.push({ url, init })
    if (url === ISSUE_URL) return issueReply()
    if (url === CONTENT_URL) return contentReply()
    throw new Error(`Unexpected Jira request: ${url}`)
  })
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('JiraProvider.listAttachments', () => {
  test('reads the attachment field live and normalizes it into TaskAttachment rows', async () => {
    const provider = makeProvider()

    const attachments = await provider.listAttachments('ENG-1')

    expect(requests.map((r) => r.url)).toEqual([ISSUE_URL])
    expect(attachments).toEqual([
      {
        id: 'att-1',
        task_id: 'jira:10001',
        filename: 'spec.md',
        media_type: 'text/markdown',
        byte_size: specBytes.byteLength,
        author: 'Jira User',
        created_at: '2026-01-03T00:00:00Z',
      },
      {
        id: 'att-2',
        task_id: 'jira:10001',
        filename: 'packet.zip',
        media_type: 'application/zip',
        byte_size: 9_800_000,
        author: null,
        created_at: '2026-01-04T00:00:00Z',
      },
    ])
    expect((await provider.getContext()).capabilities.attachments).toBe(true)
  })

  test('refuses an unknown task before touching the network', async () => {
    const error = await failure(() => makeProvider().listAttachments('ENG-404'))

    expect(error.code).toBe(ErrorCode.TASK_NOT_FOUND)
    expect(requests).toEqual([])
  })

  test('refuses a redirected issue read instead of trusting another list', async () => {
    issueReply = () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://example.atlassian.net/rest/api/3/issue/ENG-2' },
      })

    const error = await failure(() => makeProvider().listAttachments('ENG-1'))

    expect(requests[0]?.init?.redirect).toBe('manual')
    expect(error.code).toBe(ErrorCode.ATTACHMENT_REFUSED)
    expect(error.message).toContain('redirected')
  })

  test('refuses an entry without a valid size, so no download can run unbounded', async () => {
    issueReply = () =>
      new Response(
        JSON.stringify({
          id: '10001',
          key: 'ENG-1',
          fields: { attachment: [{ ...jiraAttachments[0], size: '17' }] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    const provider = makeProvider()

    const listError = await failure(() => provider.listAttachments('ENG-1'))
    expect(listError.code).toBe(ErrorCode.PROVIDER_UPSTREAM_ERROR)
    expect(listError.message).toContain('no valid size')

    const readError = await failure(() =>
      provider.readAttachment('ENG-1', 'att-1', { maxBytes: 1024 }),
    )
    expect(readError.code).toBe(ErrorCode.PROVIDER_UPSTREAM_ERROR)
    expect(requests.map((r) => r.url)).toEqual([ISSUE_URL, ISSUE_URL])
  })
})

describe('JiraProvider.readAttachment', () => {
  test('downloads from the Jira origin without following redirects', async () => {
    const read = await makeProvider().readAttachment('ENG-1', 'att-1', { maxBytes: 1024 })

    expect(requests.map((r) => r.url)).toEqual([ISSUE_URL, CONTENT_URL])
    const download = requests[1]?.init
    expect(download?.redirect).toBe('manual')
    expect(new Headers(download?.headers).get('authorization')).toMatch(/^Basic /)
    expect(read.attachment.id).toBe('att-1')
    expect(new TextDecoder().decode(read.bytes)).toBe('# spec\n\nread me\n')
  })

  test('rejects a maxBytes that is not a positive integer', async () => {
    for (const maxBytes of [0, -1, 1.5, Number.NaN]) {
      const error = await failure(() =>
        makeProvider().readAttachment('ENG-1', 'att-1', { maxBytes }),
      )
      expect(error.code).toBe(ErrorCode.INVALID_ARGUMENT)
    }
    expect(requests).toEqual([])
  })

  test('refuses an id the issue does not list', async () => {
    const error = await failure(() =>
      makeProvider().readAttachment('ENG-1', 'att-999', { maxBytes: 1024 }),
    )

    expect(error.code).toBe(ErrorCode.NOT_FOUND)
    expect(requests.map((r) => r.url)).toEqual([ISSUE_URL])
  })

  test('refuses a declared size above maxBytes before downloading', async () => {
    const error = await failure(() =>
      makeProvider().readAttachment('ENG-1', 'att-2', { maxBytes: 2 * 1024 * 1024 }),
    )

    expect(error.code).toBe(ErrorCode.ATTACHMENT_REFUSED)
    expect(error.message).toContain('9800000 bytes')
    expect(requests.map((r) => r.url)).toEqual([ISSUE_URL])
  })

  test('gives a download one second per MiB on top of the request deadline', () => {
    expect(attachmentDownloadTimeoutMs(30_000, 1)).toBe(31_000)
    expect(attachmentDownloadTimeoutMs(30_000, 20 * 1024 * 1024)).toBe(50_000)
  })

  test('refuses a redirect instead of following it', async () => {
    contentReply = () =>
      new Response(null, {
        status: 303,
        headers: { location: 'https://api.media.atlassian.com/file/abc' },
      })

    const error = await failure(() =>
      makeProvider().readAttachment('ENG-1', 'att-1', { maxBytes: 1024 }),
    )

    expect(error.code).toBe(ErrorCode.ATTACHMENT_REFUSED)
    expect(error.message).toContain('redirected')
    expect(requests.map((r) => r.url)).toEqual([ISSUE_URL, CONTENT_URL])
  })

  test('refuses a content-length above the bound before reading the body', async () => {
    contentReply = () =>
      new Response(
        endlessBody(() => undefined),
        {
          status: 200,
          headers: { 'content-length': String(specBytes.byteLength + 1) },
        },
      )

    const error = await failure(() =>
      makeProvider().readAttachment('ENG-1', 'att-1', { maxBytes: 1024 }),
    )

    expect(error.code).toBe(ErrorCode.ATTACHMENT_REFUSED)
    expect(error.message).toContain('at most 16 are read')
  })

  test('cancels a body that runs past the bound', async () => {
    let cancelled = false
    contentReply = () =>
      new Response(
        endlessBody(() => (cancelled = true)),
        { status: 200 },
      )

    const error = await failure(() =>
      makeProvider().readAttachment('ENG-1', 'att-1', { maxBytes: 1024 }),
    )

    expect(error.code).toBe(ErrorCode.ATTACHMENT_REFUSED)
    expect(error.message).toContain('exceeds')
    expect(cancelled).toBe(true)
  })

  test('cancels an oversized error body instead of reading it whole', async () => {
    let cancelled = false
    contentReply = () =>
      new Response(
        endlessBody(() => (cancelled = true)),
        { status: 500 },
      )

    const error = await failure(() =>
      makeProvider().readAttachment('ENG-1', 'att-1', { maxBytes: 1024 }),
    )

    expect(error.code).toBe(ErrorCode.PROVIDER_UPSTREAM_ERROR)
    expect(error.message).toContain('failed with 500')
    expect(cancelled).toBe(true)
  })

  test('refuses a body longer than the declared size', async () => {
    contentReply = () => bytesResponse(new Uint8Array(specBytes.byteLength + 1))

    const error = await failure(() =>
      makeProvider().readAttachment('ENG-1', 'att-1', { maxBytes: 1024 }),
    )

    expect(error.code).toBe(ErrorCode.ATTACHMENT_REFUSED)
    expect(error.message).toContain('exceeds')
  })

  test('refuses a body shorter than the declared size', async () => {
    contentReply = () => bytesResponse(specBytes.subarray(0, 4))

    const error = await failure(() =>
      makeProvider().readAttachment('ENG-1', 'att-1', { maxBytes: 1024 }),
    )

    expect(error.code).toBe(ErrorCode.ATTACHMENT_REFUSED)
    expect(error.message).toContain('declared')
  })

  test('maps a 401 or 403 on the content route to PROVIDER_AUTH_FAILED', async () => {
    for (const status of [401, 403]) {
      contentReply = () => new Response(null, { status })

      const error = await failure(() =>
        makeProvider().readAttachment('ENG-1', 'att-1', { maxBytes: 1024 }),
      )

      expect(error.code).toBe(ErrorCode.PROVIDER_AUTH_FAILED)
    }
  })

  test('a 429 on the content route starts the client-wide cooldown', async () => {
    contentReply = () => new Response(null, { status: 429, headers: { 'retry-after': '30' } })
    const provider = makeProvider()

    const first = await failure(() => provider.readAttachment('ENG-1', 'att-1', { maxBytes: 1024 }))
    expect(first.code).toBe(ErrorCode.PROVIDER_RATE_LIMITED)

    const second = await failure(() => provider.listAttachments('ENG-1'))
    expect(second.code).toBe(ErrorCode.PROVIDER_RATE_LIMITED)
    expect(second.message).toContain('cooldown')
    expect(requests.map((r) => r.url)).toEqual([ISSUE_URL, CONTENT_URL])
  })
})

describe('providers without attachments', () => {
  test('local refuses with UNSUPPORTED_OPERATION and advertises attachments: false', async () => {
    const localDb = new Database(':memory:')
    localDb.run('PRAGMA foreign_keys = ON')
    initSchema(localDb)
    seedDefaultColumns(localDb)
    const provider = new LocalProvider(localDb, ':memory:')
    const task = addTask(localDb, 'No files here')

    expect((await provider.getContext()).capabilities.attachments).toBe(false)
    const listError = await failure(() => provider.listAttachments(task.id))
    expect(listError.code).toBe(ErrorCode.UNSUPPORTED_OPERATION)
    const readError = await failure(() =>
      provider.readAttachment(task.id, 'att-1', { maxBytes: 1024 }),
    )
    expect(readError.code).toBe(ErrorCode.UNSUPPORTED_OPERATION)
  })

  test('Linear refuses with UNSUPPORTED_OPERATION without a network call', async () => {
    const linearDb = new Database(':memory:')
    initLinearCacheSchema(linearDb)
    const provider = new LinearProvider(linearDb, 'team-1', 'lin_api_test')

    const listError = await failure(() => provider.listAttachments('ENG-1'))
    expect(listError.code).toBe(ErrorCode.UNSUPPORTED_OPERATION)
    const readError = await failure(() =>
      provider.readAttachment('ENG-1', 'att-1', { maxBytes: 1024 }),
    )
    expect(readError.code).toBe(ErrorCode.UNSUPPORTED_OPERATION)
    expect(requests).toEqual([])
  })
})
