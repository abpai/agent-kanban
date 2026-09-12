import { beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initSchema, seedDefaultColumns, addTask } from '../db'
import { KanbanError, ErrorCode } from '../errors'
import { handleRequest, type WebhookAcceptedEvent } from '../api'
import { createProvider } from '../providers/index'
import type { KanbanProvider } from '../providers/types'

let db: Database
let provider: KanbanProvider

beforeEach(() => {
  db = new Database(':memory:')
  db.run('PRAGMA foreign_keys = ON')
  initSchema(db)
  seedDefaultColumns(db)
  provider = createProvider(db, { provider: 'local' }, ':memory:')
})

describe('handleRequest', () => {
  test('returns API 404 envelope for unknown route', async () => {
    const req = new Request('http://localhost/api/not-a-route', { method: 'GET' })
    const result = await handleRequest(provider, req)

    expect(result.mutated).toBe(false)
    expect(result.response.status).toBe(404)
  })

  test('marks failed PATCH mutation as not mutated', async () => {
    const req = new Request('http://localhost/api/tasks/t_missing', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Nope' }),
    })
    const result = await handleRequest(provider, req)

    expect(result.response.status).toBe(404)
    expect(result.mutated).toBe(false)
  })

  test('returns the error envelope for a malformed JSON body', async () => {
    const req = new Request('http://localhost/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not valid json',
    })
    const result = await handleRequest(provider, req)
    const body = await result.response.json()

    expect(result.response.status).toBe(400)
    expect(result.mutated).toBe(false)
    expect(body).toHaveProperty('ok', false)
    expect(body).toHaveProperty('error.code', 'INVALID_REQUEST_BODY')
  })

  test('still returns MISSING_ARGUMENT when a valid body omits a required field', async () => {
    const req = new Request('http://localhost/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'no title' }),
    })
    const result = await handleRequest(provider, req)
    const body = await result.response.json()

    expect(result.response.status).toBe(400)
    expect(result.mutated).toBe(false)
    expect(body).toHaveProperty('error.code', 'MISSING_ARGUMENT')
  })

  test('rejects an invalid limit query parameter through the envelope', async () => {
    const req = new Request('http://localhost/api/tasks?limit=-5', { method: 'GET' })
    const result = await handleRequest(provider, req)
    const body = await result.response.json()

    expect(result.response.status).toBe(400)
    expect(body).toHaveProperty('ok', false)
    expect(body).toHaveProperty('error.code', 'INVALID_ARGUMENT')
  })

  test('marks successful task creation as mutated', async () => {
    const req = new Request('http://localhost/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Created via API', labels: ['garage-smoke', 'api-smoke'] }),
    })
    const result = await handleRequest(provider, req)
    const body = await result.response.json()

    expect(result.response.status).toBe(200)
    expect(result.mutated).toBe(true)
    expect(body).toHaveProperty('ok', true)
    expect(body).toHaveProperty('data.labels', ['garage-smoke', 'api-smoke'])
  })

  test('marks successful task delete as mutated', async () => {
    const task = addTask(db, 'Delete me')
    const req = new Request(`http://localhost/api/tasks/${task.id}`, { method: 'DELETE' })
    const result = await handleRequest(provider, req)

    expect(result.response.status).toBe(200)
    expect(result.mutated).toBe(true)
  })

  test('marks successful comment creation as mutated', async () => {
    const task = addTask(db, 'Comment me')
    const req = new Request(`http://localhost/api/tasks/${task.id}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'hello from api' }),
    })
    const result = await handleRequest(provider, req)
    const body = await result.response.json()

    expect(result.response.status).toBe(200)
    expect(result.mutated).toBe(true)
    expect(body).toHaveProperty('ok', true)
    expect(body).toHaveProperty('data.body', 'hello from api')
  })

  test('lists comments without marking the request as mutated', async () => {
    const task = addTask(db, 'Comment me')
    await provider.comment(task.id, 'hello from api')
    await provider.comment(task.id, 'second api comment')

    const req = new Request(`http://localhost/api/tasks/${task.id}/comments`, {
      method: 'GET',
    })
    const result = await handleRequest(provider, req)
    const body = await result.response.json()

    expect(result.response.status).toBe(200)
    expect(result.mutated).toBe(false)
    expect(body).toHaveProperty('ok', true)
    expect(body).toMatchObject({
      data: [{ body: 'hello from api' }, { body: 'second api comment' }],
    })
  })

  test('marks successful comment update as mutated', async () => {
    const task = addTask(db, 'Comment me')
    const created = await provider.comment(task.id, 'hello from api')

    const updateReq = new Request(`http://localhost/api/tasks/${task.id}/comments/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'edited via api' }),
    })
    const updated = await handleRequest(provider, updateReq)
    expect(updated.response.status).toBe(200)
    expect(updated.mutated).toBe(true)
  })

  test('emits task:upsert event on create', async () => {
    const req = new Request('http://localhost/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Optimistic', column: 'backlog' }),
    })
    const result = await handleRequest(provider, req)

    expect(result.mutated).toBe(true)
    expect(result.event?.type).toBe('task:upsert')
    if (result.event?.type !== 'task:upsert') throw new Error('unreachable')
    expect(result.event.task.title).toBe('Optimistic')
    expect('columnId' in result.event).toBe(true)
    expect('columnName' in result.event).toBe(false)
  })

  test('emits task:upsert event on move across columns', async () => {
    const task = addTask(db, 'Movable')
    const req = new Request(`http://localhost/api/tasks/${task.id}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ column: 'in-progress' }),
    })
    const result = await handleRequest(provider, req)

    expect(result.mutated).toBe(true)
    expect(result.event?.type).toBe('task:upsert')
    if (result.event?.type !== 'task:upsert') throw new Error('unreachable')
    expect(result.event.task.id).toBe(task.id)
    expect('columnId' in result.event).toBe(true)
    expect('columnName' in result.event).toBe(false)
  })

  test('emits task:delete event on delete', async () => {
    const task = addTask(db, 'Goodbye')
    const req = new Request(`http://localhost/api/tasks/${task.id}`, { method: 'DELETE' })
    const result = await handleRequest(provider, req)

    expect(result.mutated).toBe(true)
    expect(result.event).toEqual({ type: 'task:delete', id: task.id })
  })

  test('returns bootstrap payload', async () => {
    const req = new Request('http://localhost/api/bootstrap', { method: 'GET' })
    const result = await handleRequest(provider, req)
    const body = await result.response.json()

    expect(result.response.status).toBe(200)
    expect(body).toHaveProperty('ok', true)
    expect(body).toHaveProperty('data.provider', 'local')
    expect(body).toHaveProperty('data.capabilities.taskDelete', true)
  })

  test('F22: GET /api/activity returns an ok envelope wrapping an array', async () => {
    addTask(db, 'Generates activity')
    const req = new Request('http://localhost/api/activity?limit=5', { method: 'GET' })
    const result = await handleRequest(provider, req)
    const body = await result.response.json()
    expect(result.response.status).toBe(200)
    expect(result.mutated).toBe(false)
    expect(body).toHaveProperty('ok', true)
    expect(body).toHaveProperty('data', expect.any(Array))
  })

  test('F22: GET /api/activity rejects an invalid limit through the envelope', async () => {
    const req = new Request('http://localhost/api/activity?limit=0', { method: 'GET' })
    const result = await handleRequest(provider, req)
    const body = await result.response.json()
    expect(result.response.status).toBe(400)
    expect(body).toHaveProperty('error.code', 'INVALID_ARGUMENT')
  })

  test('F23: GET /api/metrics returns the metrics envelope', async () => {
    const req = new Request('http://localhost/api/metrics', { method: 'GET' })
    const result = await handleRequest(provider, req)
    const body = await result.response.json()
    expect(result.response.status).toBe(200)
    expect(result.mutated).toBe(false)
    expect(body).toHaveProperty('ok', true)
    expect(body).toHaveProperty('data.totalTasks', expect.any(Number))
    expect(body).toHaveProperty('data.tasksByColumn', expect.any(Array))
  })

  test('F24: GET /api/config returns config', async () => {
    const getReq = new Request('http://localhost/api/config', { method: 'GET' })
    const getRes = await handleRequest(provider, getReq)
    const getBody = await getRes.response.json()
    expect(getRes.response.status).toBe(200)
    expect(getRes.mutated).toBe(false)
    expect(getBody).toHaveProperty('data.provider', 'local')
  })

  test('F24: PATCH /api/config mutates without a precise WsEvent', async () => {
    // PATCH persists the config sidecar (config.json) next to the db path, so use
    // a hermetic temp dir instead of the shared ':memory:' provider, which would
    // write ./config.json into the checkout.
    const dir = mkdtempSync(join(tmpdir(), 'kanban-api-config-'))
    const cfgDb = new Database(':memory:')
    cfgDb.run('PRAGMA foreign_keys = ON')
    initSchema(cfgDb)
    seedDefaultColumns(cfgDb)
    const cfgProvider = createProvider(cfgDb, { provider: 'local' }, join(dir, 'board.db'))
    try {
      const patchReq = new Request('http://localhost/api/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ members: [{ name: 'alice', role: 'human' }] }),
      })
      const patchRes = await handleRequest(cfgProvider, patchReq)
      const patchBody = await patchRes.response.json()
      expect(patchRes.response.status).toBe(200)
      expect(patchRes.mutated).toBe(true)
      // No precise WsEvent → the server falls back to a 'refresh' broadcast.
      expect(patchRes.event).toBeUndefined()
      expect(patchBody).toHaveProperty(
        'data.members',
        expect.arrayContaining([expect.objectContaining({ name: 'alice' })]),
      )
    } finally {
      cfgDb.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// Minimal provider whose only relevant field is `type` plus an overridable
// handleWebhook — the webhook branch of handleRequest is the surface under test.
function webhookProvider(
  type: KanbanProvider['type'],
  handleWebhook?: KanbanProvider['handleWebhook'],
): KanbanProvider {
  const p: Partial<KanbanProvider> = { type }
  if (handleWebhook) p.handleWebhook = handleWebhook
  // SAFETY: these /webhooks requests access only provider.type and handleWebhook;
  // all other provider methods remain deliberately absent to detect route drift.
  return p as KanbanProvider
}

function webhookRequest(target: string): Request {
  return new Request(`http://localhost/api/webhooks/${target}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
}

describe('handleRequest webhook route (F25)', () => {
  test('target that does not match the active provider → 400 UNSUPPORTED_OPERATION, not mutated', async () => {
    const result = await handleRequest(
      webhookProvider('local', async () => ({ handled: true })),
      webhookRequest('jira'),
    )
    const body = await result.response.json()
    expect(result.response.status).toBe(400)
    expect(result.mutated).toBe(false)
    expect(body).toHaveProperty('error.code', 'UNSUPPORTED_OPERATION')
  })

  test('provider without handleWebhook → 400 UNSUPPORTED_OPERATION', async () => {
    const result = await handleRequest(webhookProvider('local'), webhookRequest('local'))
    const body = await result.response.json()
    expect(result.response.status).toBe(400)
    expect(result.mutated).toBe(false)
    expect(body).toHaveProperty('error.code', 'UNSUPPORTED_OPERATION')
  })

  test('unauthorized result → 401 PROVIDER_AUTH_FAILED, not mutated', async () => {
    const result = await handleRequest(
      webhookProvider('local', async () => ({ handled: false, unauthorized: true })),
      webhookRequest('local'),
    )
    const body = await result.response.json()
    expect(result.response.status).toBe(401)
    expect(result.mutated).toBe(false)
    expect(body).toHaveProperty('error.code', 'PROVIDER_AUTH_FAILED')
  })

  test('handled result → 200, mutated true', async () => {
    const result = await handleRequest(
      webhookProvider('local', async () => ({ handled: true, message: 'ok' })),
      webhookRequest('local'),
    )
    const body = await result.response.json()
    expect(result.response.status).toBe(200)
    expect(result.mutated).toBe(true)
    expect(body).toHaveProperty('data.handled', true)
  })

  test('handled result calls the accepted hook with the trusted delivery', async () => {
    const accepted: WebhookAcceptedEvent[] = []
    const result = await handleRequest(
      webhookProvider('local', async () => ({ handled: true })),
      new Request('http://localhost/api/webhooks/local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Delivery': 'delivery-1' },
        body: '{"task":"TASK-1"}',
      }),
      { onWebhookAccepted: (event) => void accepted.push(event) },
    )

    expect(result.response.status).toBe(200)
    expect(accepted).toHaveLength(1)
    expect(accepted[0]).toMatchObject({
      provider: 'local',
      rawBody: '{"task":"TASK-1"}',
      headers: { 'x-delivery': 'delivery-1' },
    })
  })

  test('skipped and unauthorized results do not call the accepted hook', async () => {
    const accepted: WebhookAcceptedEvent[] = []

    await handleRequest(
      webhookProvider('local', async () => ({ handled: false })),
      webhookRequest('local'),
      { onWebhookAccepted: (event) => void accepted.push(event) },
    )
    await handleRequest(
      webhookProvider('local', async () => ({ handled: false, unauthorized: true })),
      webhookRequest('local'),
      { onWebhookAccepted: (event) => void accepted.push(event) },
    )

    expect(accepted).toHaveLength(0)
  })

  test('a throwing accepted hook does not change the provider response', async () => {
    const result = await handleRequest(
      webhookProvider('local', async () => ({ handled: true })),
      webhookRequest('local'),
      {
        onWebhookAccepted: () => {
          throw new Error('consumer failed')
        },
      },
    )

    expect(result.response.status).toBe(200)
    expect(result.mutated).toBe(true)
  })

  test('skipped (handled:false) result → 200, NOT mutated (no broadcast)', async () => {
    const result = await handleRequest(
      webhookProvider('local', async () => ({ handled: false, message: 'ignored' })),
      webhookRequest('local'),
    )
    expect(result.response.status).toBe(200)
    expect(result.mutated).toBe(false)
  })
})

describe('handleRequest webhook route error containment (F55 regression)', () => {
  test('a throwing handleWebhook is enveloped as 500 INTERNAL_ERROR, never escapes as a rejection', async () => {
    const provider = webhookProvider('local', async () => {
      throw new Error('boom from provider.handleWebhook')
    })
    // Must NOT reject — before the fix this threw out of handleRequest.
    const result = await handleRequest(provider, webhookRequest('local'))
    const body = await result.response.json()
    expect(result.response.status).toBe(500)
    expect(result.mutated).toBe(false)
    expect(body).toHaveProperty('ok', false)
    expect(body).toHaveProperty('error.code', 'INTERNAL_ERROR')
    expect(body).toHaveProperty('error.message', expect.stringContaining('boom'))
  })

  test('a thrown KanbanError keeps its mapped status + code through the envelope', async () => {
    const provider = webhookProvider('local', async () => {
      throw new KanbanError(ErrorCode.CONFLICT, 'version conflict during webhook apply')
    })
    const result = await handleRequest(provider, webhookRequest('local'))
    const body = await result.response.json()
    expect(result.response.status).toBe(409)
    expect(result.mutated).toBe(false)
    expect(body).toHaveProperty('error.code', 'CONFLICT')
  })
})

describe('handleRequest malformed path encoding (D2 regression)', () => {
  test('malformed %-encoding in a task id → 400 INVALID_ARGUMENT, never thrown', async () => {
    const req = new Request('http://localhost/api/tasks/%E0%A4%A', { method: 'GET' })
    // Must not reject — before the fix decodeURIComponent threw a URIError that
    // escaped handleRequest.
    const result = await handleRequest(provider, req)
    const body = await result.response.json()
    expect(result.response.status).toBe(400)
    expect(result.mutated).toBe(false)
    expect(body).toHaveProperty('error.code', 'INVALID_ARGUMENT')
  })

  test('malformed %-encoding in a webhook target → 400 INVALID_ARGUMENT', async () => {
    const result = await handleRequest(webhookProvider('local'), webhookRequest('%E0%A4%A'))
    const body = await result.response.json()
    expect(result.response.status).toBe(400)
    expect(result.mutated).toBe(false)
    expect(body).toHaveProperty('error.code', 'INVALID_ARGUMENT')
  })
})

describe('statusForCode server-side mapping (D3 regression)', () => {
  const cases: { code: keyof typeof ErrorCode; status: number }[] = [
    { code: 'PROVIDER_UPSTREAM_ERROR', status: 502 },
    { code: 'PROVIDER_SYNC_REQUIRED', status: 503 },
    { code: 'INTERNAL_ERROR', status: 500 },
  ]
  for (const { code, status } of cases) {
    test(`${code} → ${status} (not the default 400)`, async () => {
      const provider = webhookProvider('local', async () => {
        throw new KanbanError(ErrorCode[code], `${code} from provider`)
      })
      const result = await handleRequest(provider, webhookRequest('local'))
      const body = await result.response.json()
      expect(result.response.status).toBe(status)
      expect(body).toHaveProperty('error.code', code)
      expect(result.mutated).toBe(false)
    })
  }
})
