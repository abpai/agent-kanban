import { beforeEach, afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHmac } from 'node:crypto'
import { verifyHmacSha256 } from '../webhooks.ts'
import { JiraProvider, type JiraProviderConfig } from '../providers/jira.ts'
import { JiraClient } from '../providers/jira-client.ts'
import { LinearProvider } from '../providers/linear.ts'
import {
  getCachedTasks as getCachedJiraTasks,
  initJiraCacheSchema,
  saveJiraSyncMeta,
  saveTeamInfo,
  replaceJiraColumns,
  upsertJiraIssues,
} from '../providers/jira-cache.ts'
import {
  getCachedTasks as getCachedLinearTasks,
  initLinearCacheSchema,
  loadSyncMeta,
  replaceStates,
  saveSyncMeta,
  upsertIssues,
} from '../providers/linear-cache.ts'

function hmac(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

describe('verifyHmacSha256', () => {
  test('accepts matching signature', () => {
    const body = '{"hello":"world"}'
    const sig = hmac('s3cr3t', body)
    expect(verifyHmacSha256('s3cr3t', body, sig)).toBe(true)
    expect(verifyHmacSha256('s3cr3t', body, `sha256=${sig}`)).toBe(true)
  })

  test('rejects tampered body', () => {
    const sig = hmac('s3cr3t', 'a')
    expect(verifyHmacSha256('s3cr3t', 'b', sig)).toBe(false)
  })

  test('rejects wrong secret', () => {
    const sig = hmac('s3cr3t', 'a')
    expect(verifyHmacSha256('other', 'a', sig)).toBe(false)
  })

  test('rejects missing signature', () => {
    expect(verifyHmacSha256('s3cr3t', 'a', undefined)).toBe(false)
  })
})

const jiraConfig: JiraProviderConfig = {
  baseUrl: 'https://example.atlassian.net',
  email: 'u@example.com',
  apiToken: 'tok',
  projectKey: 'ENG',
}

function seedJira(db: Database): void {
  initJiraCacheSchema(db)
  saveJiraSyncMeta(db, {
    projectKey: 'ENG',
    boardId: null,
    lastSyncAt: '2025-01-01T00:00:00.000Z',
    lastIssueUpdatedAt: '2025-01-01T00:00:00.000Z',
  })
  saveTeamInfo(db, { id: '1', key: 'ENG', name: 'Engineering' })
  replaceJiraColumns(db, [
    { id: 'status:1', name: 'To Do', position: 0, statusIds: ['1'], source: 'status' },
    { id: 'status:2', name: 'Done', position: 1, statusIds: ['2'], source: 'status' },
  ])
}

describe('Jira webhook', () => {
  let originalSecret: string | undefined

  beforeEach(() => {
    originalSecret = process.env['JIRA_WEBHOOK_SECRET']
  })

  afterEach(() => {
    if (originalSecret === undefined) delete process.env['JIRA_WEBHOOK_SECRET']
    else process.env['JIRA_WEBHOOK_SECRET'] = originalSecret
  })

  test('issue_created upserts the task', async () => {
    const db = new Database(':memory:')
    seedJira(db)
    delete process.env['JIRA_WEBHOOK_SECRET']
    const client = new JiraClient({
      baseUrl: jiraConfig.baseUrl,
      email: jiraConfig.email,
      apiToken: jiraConfig.apiToken,
    })
    const provider = new JiraProvider(db, jiraConfig, client)
    const body = JSON.stringify({
      webhookEvent: 'jira:issue_created',
      issue: {
        id: '100',
        key: 'ENG-100',
        fields: {
          summary: 'New issue',
          status: { id: '1', name: 'To Do' },
          issuetype: { id: '10000', name: 'Task' },
          assignee: null,
          labels: ['alpha'],
          comment: { total: 0 },
          created: '2025-02-01T00:00:00.000Z',
          updated: '2025-02-01T00:00:00.000Z',
          project: { id: '1', key: 'ENG' },
        },
      },
    })
    const result = await provider.handleWebhook({ headers: {}, rawBody: body })
    expect(result.handled).toBe(true)
    const tasks = getCachedJiraTasks(db)
    expect(tasks.find((t) => t.externalRef === 'ENG-100')?.title).toBe('New issue')
  })

  test('issue_deleted removes the task', async () => {
    const db = new Database(':memory:')
    seedJira(db)
    upsertJiraIssues(db, [
      {
        id: '200',
        key: 'ENG-200',
        summary: 'Doomed',
        descriptionText: '',
        statusId: '1',
        projectKey: 'ENG',
        createdAt: '2025-02-01',
        updatedAt: '2025-02-01',
      },
    ])
    delete process.env['JIRA_WEBHOOK_SECRET']
    const client = new JiraClient({
      baseUrl: jiraConfig.baseUrl,
      email: jiraConfig.email,
      apiToken: jiraConfig.apiToken,
    })
    const provider = new JiraProvider(db, jiraConfig, client)
    const body = JSON.stringify({
      webhookEvent: 'jira:issue_deleted',
      issue: {
        id: '200',
        key: 'ENG-200',
        fields: {
          summary: '',
          status: { id: '1', name: 'To Do' },
          issuetype: { id: '', name: '' },
          created: '',
          updated: '',
        },
      },
    })
    const result = await provider.handleWebhook({ headers: {}, rawBody: body })
    expect(result.handled).toBe(true)
    expect(getCachedJiraTasks(db).find((t) => t.externalRef === 'ENG-200')).toBeUndefined()
  })

  test('rejects bad signature when secret is configured', async () => {
    const db = new Database(':memory:')
    seedJira(db)
    process.env['JIRA_WEBHOOK_SECRET'] = 'topsecret'
    const client = new JiraClient({
      baseUrl: jiraConfig.baseUrl,
      email: jiraConfig.email,
      apiToken: jiraConfig.apiToken,
    })
    const provider = new JiraProvider(db, jiraConfig, client)
    const body = JSON.stringify({
      webhookEvent: 'jira:issue_created',
      issue: { id: '300', key: 'ENG-300', fields: {} },
    })
    const result = await provider.handleWebhook({
      headers: { 'x-hub-signature-256': 'sha256=deadbeef' },
      rawBody: body,
    })
    expect(result.unauthorized).toBe(true)
  })

  test('accepts valid signature when secret is configured', async () => {
    const db = new Database(':memory:')
    seedJira(db)
    process.env['JIRA_WEBHOOK_SECRET'] = 'topsecret'
    const client = new JiraClient({
      baseUrl: jiraConfig.baseUrl,
      email: jiraConfig.email,
      apiToken: jiraConfig.apiToken,
    })
    const provider = new JiraProvider(db, jiraConfig, client)
    const body = JSON.stringify({
      webhookEvent: 'jira:issue_created',
      issue: {
        id: '400',
        key: 'ENG-400',
        fields: {
          summary: 'Signed',
          status: { id: '1', name: 'To Do' },
          issuetype: { id: 't', name: 'Task' },
          project: { id: '1', key: 'ENG' },
          created: '2025-02-01',
          updated: '2025-02-01',
        },
      },
    })
    const sig = hmac('topsecret', body)
    const result = await provider.handleWebhook({
      headers: { 'x-hub-signature-256': sig },
      rawBody: body,
    })
    expect(result.handled).toBe(true)
  })

  test('ignores issue updates from other projects', async () => {
    const db = new Database(':memory:')
    seedJira(db)
    delete process.env['JIRA_WEBHOOK_SECRET']
    const client = new JiraClient({
      baseUrl: jiraConfig.baseUrl,
      email: jiraConfig.email,
      apiToken: jiraConfig.apiToken,
    })
    const provider = new JiraProvider(db, jiraConfig, client)
    const body = JSON.stringify({
      webhookEvent: 'jira:issue_updated',
      issue: {
        id: '500',
        key: 'OPS-500',
        fields: {
          summary: 'Wrong project',
          status: { id: '1', name: 'To Do' },
          issuetype: { id: 't', name: 'Task' },
          labels: [],
          comment: { total: 0 },
          created: '2025-02-01',
          updated: '2025-02-01',
          project: { id: '2', key: 'OPS' },
        },
      },
    })

    const result = await provider.handleWebhook({ headers: {}, rawBody: body })

    expect(result.handled).toBe(false)
    expect(result.message).toContain('Ignoring issue from project')
    expect(getCachedJiraTasks(db).find((task) => task.externalRef === 'OPS-500')).toBeUndefined()
  })
})

function seedLinear(db: Database): void {
  initLinearCacheSchema(db)
  saveSyncMeta(db, {
    team: { id: 'tid', key: 'DX', name: 'DX' },
    lastSyncAt: '2025-01-01T00:00:00.000Z',
    lastIssueUpdatedAt: '2025-01-01T00:00:00.000Z',
  })
  replaceStates(db, [
    { id: 's1', name: 'Todo', position: 0 },
    { id: 's2', name: 'Done', position: 1 },
  ])
}

describe('Linear webhook', () => {
  let originalSecret: string | undefined

  beforeEach(() => {
    originalSecret = process.env['LINEAR_WEBHOOK_SECRET']
  })

  afterEach(() => {
    if (originalSecret === undefined) delete process.env['LINEAR_WEBHOOK_SECRET']
    else process.env['LINEAR_WEBHOOK_SECRET'] = originalSecret
  })

  test('Issue.create upserts the task', async () => {
    const db = new Database(':memory:')
    seedLinear(db)
    delete process.env['LINEAR_WEBHOOK_SECRET']
    const provider = new LinearProvider(db, 'tid', 'key')
    const body = JSON.stringify({
      action: 'create',
      type: 'Issue',
      data: {
        id: 'i1',
        identifier: 'DX-1',
        title: 'Linear issue',
        description: 'body',
        priority: 2,
        url: 'https://linear.app/x/i/DX-1',
        createdAt: '2025-02-01T00:00:00.000Z',
        updatedAt: '2025-02-01T00:00:00.000Z',
        state: { id: 's1', name: 'Todo', position: 0 },
        labels: [{ id: 'l1', name: 'bug' }],
        commentCount: 1,
      },
    })
    const result = await provider.handleWebhook({ headers: {}, rawBody: body })
    expect(result.handled).toBe(true)
    const tasks = getCachedLinearTasks(db)
    const issue = tasks.find((t) => t.externalRef === 'DX-1')
    expect(issue?.title).toBe('Linear issue')
    expect(issue?.labels).toEqual(['bug'])
    expect(issue?.comment_count).toBe(1)
  })

  test('Issue.remove deletes cache row', async () => {
    const db = new Database(':memory:')
    seedLinear(db)
    upsertIssues(db, [
      {
        id: 'ix',
        identifier: 'DX-9',
        title: 'Bye',
        priority: 0,
        stateId: 's1',
        stateName: 'Todo',
        statePosition: 0,
        createdAt: '2025-01',
        updatedAt: '2025-01',
      },
    ])
    delete process.env['LINEAR_WEBHOOK_SECRET']
    const provider = new LinearProvider(db, 'tid', 'key')
    const body = JSON.stringify({
      action: 'remove',
      type: 'Issue',
      data: { id: 'ix', identifier: 'DX-9' },
    })
    const result = await provider.handleWebhook({ headers: {}, rawBody: body })
    expect(result.handled).toBe(true)
    expect(getCachedLinearTasks(db).find((t) => t.externalRef === 'DX-9')).toBeUndefined()
  })

  test('create event stamps lastWebhookAt without clobbering team/lastSyncAt', async () => {
    const db = new Database(':memory:')
    seedLinear(db)
    delete process.env['LINEAR_WEBHOOK_SECRET']
    const provider = new LinearProvider(db, 'tid', 'key')
    const body = JSON.stringify({
      action: 'create',
      type: 'Issue',
      data: {
        id: 'i2',
        identifier: 'DX-2',
        title: 'Webhook-driven',
        createdAt: '2025-02-01T00:00:00.000Z',
        updatedAt: '2025-02-01T00:00:00.000Z',
        state: { id: 's1', name: 'Todo', position: 0 },
      },
    })
    const before = Date.now()
    await provider.handleWebhook({ headers: {}, rawBody: body })
    const meta = loadSyncMeta(db)
    expect(meta.lastWebhookAt).not.toBeNull()
    expect(new Date(meta.lastWebhookAt!).getTime()).toBeGreaterThanOrEqual(before)
    expect(meta.team?.id).toBe('tid')
    expect(meta.lastSyncAt).toBe('2025-01-01T00:00:00.000Z')
  })

  test('linear partial saveSyncMeta preserves omitted keys; null clears', () => {
    const db = new Database(':memory:')
    initLinearCacheSchema(db)
    saveSyncMeta(db, {
      team: { id: 't', key: 'K', name: 'N' },
      lastSyncAt: '2025-01-01T00:00:00.000Z',
    })
    saveSyncMeta(db, { lastWebhookAt: '2025-01-02T00:00:00.000Z' })
    let meta = loadSyncMeta(db)
    expect(meta.team?.id).toBe('t')
    expect(meta.lastSyncAt).toBe('2025-01-01T00:00:00.000Z')
    expect(meta.lastWebhookAt).toBe('2025-01-02T00:00:00.000Z')

    saveSyncMeta(db, { team: null })
    meta = loadSyncMeta(db)
    expect(meta.team).toBeNull()
    expect(meta.lastSyncAt).toBe('2025-01-01T00:00:00.000Z')
  })

  test('rejects invalid linear-signature', async () => {
    const db = new Database(':memory:')
    seedLinear(db)
    process.env['LINEAR_WEBHOOK_SECRET'] = 'hushhush'
    const provider = new LinearProvider(db, 'tid', 'key')
    const body = JSON.stringify({
      action: 'update',
      type: 'Issue',
      data: {
        id: 'i1',
        identifier: 'DX-1',
        title: 'x',
        createdAt: '',
        updatedAt: '',
        state: { id: 's1', name: 'Todo', position: 0 },
      },
    })
    const result = await provider.handleWebhook({
      headers: { 'linear-signature': 'bogus' },
      rawBody: body,
    })
    expect(result.unauthorized).toBe(true)
  })
})
