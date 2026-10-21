import { mockFetch } from './helpers/fetch'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { addTask, initSchema, seedDefaultColumns } from '../db'
import { createTrackerCore } from '../mcp/core'
import { TrackerMcpError } from '../mcp/errors'
import { defaultTools } from '../mcp/server'
import type { TrackerMcpHooks, TrackerMcpPolicy } from '../mcp/types'
import { JiraClient } from '../providers/jira-client'
import { JiraProvider } from '../providers/jira'
import {
  initJiraCacheSchema,
  saveJiraSyncMeta,
  saveTeamInfo,
  upsertJiraIssues,
} from '../providers/jira-cache'
import { LocalProvider } from '../providers/local'

interface TestScope {
  actor: string
}

type ObservedToolResult = Pick<
  Parameters<NonNullable<TrackerMcpHooks<TestScope>['onToolResult']>>[0],
  'tool' | 'result'
>

const scope: TestScope = { actor: 'agent' }
const ISSUE_URL = 'https://example.atlassian.net/rest/api/3/issue/ENG-1?fields=attachment'
const CONTENT_URL =
  'https://example.atlassian.net/rest/api/3/attachment/content/att-1?redirect=false'
const specBytes = new TextEncoder().encode('# spec\n\nread me\n')

const allowAll: TrackerMcpPolicy<TestScope> = {
  canReadTicket() {},
  canPostComment() {},
  canUpdateComment() {},
  canMoveTicket() {},
}

let requests: string[]
let originalFetch: typeof fetch

function makeJiraProvider(): JiraProvider {
  const db = new Database(':memory:')
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
  const config = {
    baseUrl: 'https://example.atlassian.net',
    email: 'user@example.com',
    apiToken: 'token',
    projectKey: 'ENG',
  }
  return new JiraProvider(db, config, new JiraClient(config))
}

async function trackerError(pending: Promise<unknown>): Promise<TrackerMcpError> {
  const err = await pending.then(
    () => null,
    (cause: unknown) => cause,
  )
  expect(err).toBeInstanceOf(TrackerMcpError)
  // SAFETY: the instanceof assertion above fails the test for any other value.
  return err as TrackerMcpError
}

beforeEach(() => {
  requests = []
  originalFetch = globalThis.fetch
  globalThis.fetch = mockFetch(async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString()
    requests.push(url)
    if (url === ISSUE_URL) {
      const attachment = [
        { id: 'att-1', filename: 'spec.md', mimeType: 'text/markdown', size: specBytes.length },
      ]
      return Response.json({ id: '10001', key: 'ENG-1', fields: { attachment } })
    }
    if (url === CONTENT_URL) return new Response(specBytes)
    throw new Error(`Unexpected Jira request: ${url}`)
  })
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('MCP attachment handlers (Jira)', () => {
  test('list metadata and read base64 content by filename, reporting hook metadata', async () => {
    const results: ObservedToolResult[] = []
    const hooks: TrackerMcpHooks<TestScope> = {
      onToolResult(event) {
        results.push({ tool: event.tool, result: event.result })
      },
    }
    const core = createTrackerCore({ provider: makeJiraProvider(), policy: allowAll, hooks })

    const listed = await core.handlers.listAttachments({ scope, ticketId: 'ENG-1' })
    const read = await core.handlers.getAttachment({
      scope,
      ticketId: 'ENG-1',
      attachment: 'spec.md',
    })

    expect(listed.map((a) => a.id)).toEqual(['att-1'])
    expect(read.attachment).toMatchObject({ id: 'att-1', filename: 'spec.md' })
    expect(read.encoding).toBe('base64')
    expect(Buffer.from(read.content, 'base64')).toEqual(Buffer.from(specBytes))
    expect(results).toEqual([
      { tool: 'listAttachments', result: { attachmentCount: 1 } },
      { tool: 'getAttachment', result: { attachmentId: 'att-1' } },
    ])
  })

  test('the default tool set routes getAttachment arguments to the handler', async () => {
    const core = createTrackerCore({ provider: makeJiraProvider(), policy: allowAll })
    const tool = defaultTools(core).find((candidate) => candidate.name === 'getAttachment')

    const read = await tool!.handler({
      scope,
      args: { ticketId: 'ENG-1', attachment: 'att-1', maxBytes: 1024 },
    })

    expect(read).toMatchObject({ attachment: { id: 'att-1' }, encoding: 'base64' })
  })

  test('policy denial stops the read before any Jira request', async () => {
    const core = createTrackerCore({
      provider: makeJiraProvider(),
      policy: {
        ...allowAll,
        canReadTicket() {
          throw new TrackerMcpError({ code: 'policy_denied', publicMessage: 'no' })
        },
      },
    })

    const err = await trackerError(
      core.handlers.getAttachment({ scope, ticketId: 'ENG-1', attachment: 'spec.md' }),
    )

    expect(err.code).toBe('policy_denied')
    expect(requests).toEqual([])
  })

  test('an unknown attachment and an oversized one are validation failures', async () => {
    const core = createTrackerCore({ provider: makeJiraProvider(), policy: allowAll })

    const missing = await trackerError(
      core.handlers.getAttachment({ scope, ticketId: 'ENG-1', attachment: 'nope.pdf' }),
    )
    const oversized = await trackerError(
      core.handlers.getAttachment({ scope, ticketId: 'ENG-1', attachment: 'att-1', maxBytes: 4 }),
    )

    expect(missing.code).toBe('validation_failed')
    expect(missing.publicMessage).toContain("no attachment with id or filename 'nope.pdf'")
    expect(oversized.code).toBe('validation_failed')
    expect(requests.includes(CONTENT_URL)).toBe(false)
  })
})

describe('MCP attachment handlers without provider support', () => {
  test('local refuses as a validation failure naming the unsupported operation', async () => {
    const db = new Database(':memory:')
    db.run('PRAGMA foreign_keys = ON')
    initSchema(db)
    seedDefaultColumns(db)
    const task = addTask(db, 'No files')
    const core = createTrackerCore({
      provider: new LocalProvider(db, ':memory:'),
      policy: allowAll,
    })

    const listErr = await trackerError(core.handlers.listAttachments({ scope, ticketId: task.id }))
    const getErr = await trackerError(
      core.handlers.getAttachment({ scope, ticketId: task.id, attachment: 'spec.md' }),
    )

    expect(listErr.code).toBe('validation_failed')
    expect(listErr.publicMessage).toBe('Attachments are not supported in local mode')
    expect(getErr.code).toBe('validation_failed')
  })
})
