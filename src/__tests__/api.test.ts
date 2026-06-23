import { beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initSchema, seedDefaultColumns, addTask } from '../db'
import { KanbanError, ErrorCode } from '../errors'
import { handleRequest } from '../api'
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
    const body = (await result.response.json()) as {
      ok: boolean
      error: { code: string; message: string }
    }

    expect(result.response.status).toBe(400)
    expect(result.mutated).toBe(false)
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('INVALID_REQUEST_BODY')
  })

  test('still returns MISSING_ARGUMENT when a valid body omits a required field', async () => {
    const req = new Request('http://localhost/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'no title' }),
    })
    const result = await handleRequest(provider, req)
    const body = (await result.response.json()) as {
      ok: boolean
      error: { code: string }
    }

    expect(result.response.status).toBe(400)
    expect(result.mutated).toBe(false)
    expect(body.error.code).toBe('MISSING_ARGUMENT')
  })

  test('rejects an invalid limit query parameter through the envelope', async () => {
    const req = new Request('http://localhost/api/tasks?limit=-5', { method: 'GET' })
    const result = await handleRequest(provider, req)
    const body = (await result.response.json()) as {
      ok: boolean
      error: { code: string }
    }

    expect(result.response.status).toBe(400)
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('INVALID_ARGUMENT')
  })

  test('marks successful task creation as mutated', async () => {
    const req = new Request('http://localhost/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Created via API', labels: ['garage-smoke', 'api-smoke'] }),
    })
    const result = await handleRequest(provider, req)
    const body = (await result.response.json()) as {
      ok: boolean
      data: { labels: string[] }
    }

    expect(result.response.status).toBe(200)
    expect(result.mutated).toBe(true)
    expect(body.ok).toBe(true)
    expect(body.data.labels).toEqual(['garage-smoke', 'api-smoke'])
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
    const body = (await result.response.json()) as {
      ok: boolean
      data: { id: string; body: string }
    }

    expect(result.response.status).toBe(200)
    expect(result.mutated).toBe(true)
    expect(body.ok).toBe(true)
    expect(body.data.body).toBe('hello from api')
  })

  test('lists comments without marking the request as mutated', async () => {
    const task = addTask(db, 'Comment me')
    await provider.comment(task.id, 'hello from api')
    await provider.comment(task.id, 'second api comment')

    const req = new Request(`http://localhost/api/tasks/${task.id}/comments`, {
      method: 'GET',
    })
    const result = await handleRequest(provider, req)
    const body = (await result.response.json()) as {
      ok: boolean
      data: Array<{ id: string; body: string }>
    }

    expect(result.response.status).toBe(200)
    expect(result.mutated).toBe(false)
    expect(body.ok).toBe(true)
    expect(body.data.map((comment) => comment.body)).toEqual([
      'hello from api',
      'second api comment',
    ])
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
    const body = (await result.response.json()) as {
      ok: boolean
      data: { provider: string; capabilities: { taskDelete: boolean } }
    }

    expect(result.response.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.data.provider).toBe('local')
    expect(body.data.capabilities.taskDelete).toBe(true)
  })

  test('F22: GET /api/activity returns an ok envelope wrapping an array', async () => {
    addTask(db, 'Generates activity')
    const req = new Request('http://localhost/api/activity?limit=5', { method: 'GET' })
    const result = await handleRequest(provider, req)
    const body = (await result.response.json()) as { ok: boolean; data: unknown[] }
    expect(result.response.status).toBe(200)
    expect(result.mutated).toBe(false)
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.data)).toBe(true)
  })

  test('F22: GET /api/activity rejects an invalid limit through the envelope', async () => {
    const req = new Request('http://localhost/api/activity?limit=0', { method: 'GET' })
    const result = await handleRequest(provider, req)
    const body = (await result.response.json()) as { ok: boolean; error: { code: string } }
    expect(result.response.status).toBe(400)
    expect(body.error.code).toBe('INVALID_ARGUMENT')
  })

  test('F23: GET /api/metrics returns the metrics envelope', async () => {
    const req = new Request('http://localhost/api/metrics', { method: 'GET' })
    const result = await handleRequest(provider, req)
    const body = (await result.response.json()) as {
      ok: boolean
      data: { totalTasks: number; tasksByColumn: unknown[] }
    }
    expect(result.response.status).toBe(200)
    expect(result.mutated).toBe(false)
    expect(body.ok).toBe(true)
    expect(typeof body.data.totalTasks).toBe('number')
    expect(Array.isArray(body.data.tasksByColumn)).toBe(true)
  })

  test('F24: GET /api/config returns config; PATCH /api/config mutates without an event', async () => {
    const getReq = new Request('http://localhost/api/config', { method: 'GET' })
    const getRes = await handleRequest(provider, getReq)
    const getBody = (await getRes.response.json()) as { ok: boolean; data: { provider: string } }
    expect(getRes.response.status).toBe(200)
    expect(getRes.mutated).toBe(false)
    expect(getBody.data.provider).toBe('local')

    const patchReq = new Request('http://localhost/api/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ members: [{ name: 'alice', role: 'human' }] }),
    })
    const patchRes = await handleRequest(provider, patchReq)
    expect(patchRes.response.status).toBe(200)
    expect(patchRes.mutated).toBe(true)
    // config PATCH has no precise WsEvent → server falls back to a 'refresh' broadcast
    expect(patchRes.event).toBeUndefined()
  })
})

// Minimal provider whose only relevant field is `type` plus an overridable
// handleWebhook — the webhook branch of handleRequest is the surface under test.
function webhookProvider(
  type: string,
  handleWebhook?: KanbanProvider['handleWebhook'],
): KanbanProvider {
  const p: Partial<KanbanProvider> = { type: type as KanbanProvider['type'] }
  if (handleWebhook) p.handleWebhook = handleWebhook
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
    const body = (await result.response.json()) as { ok: boolean; error: { code: string } }
    expect(result.response.status).toBe(400)
    expect(result.mutated).toBe(false)
    expect(body.error.code).toBe('UNSUPPORTED_OPERATION')
  })

  test('provider without handleWebhook → 400 UNSUPPORTED_OPERATION', async () => {
    const result = await handleRequest(webhookProvider('local'), webhookRequest('local'))
    const body = (await result.response.json()) as { ok: boolean; error: { code: string } }
    expect(result.response.status).toBe(400)
    expect(result.mutated).toBe(false)
    expect(body.error.code).toBe('UNSUPPORTED_OPERATION')
  })

  test('unauthorized result → 401 PROVIDER_AUTH_FAILED, not mutated', async () => {
    const result = await handleRequest(
      webhookProvider('local', async () => ({ handled: false, unauthorized: true })),
      webhookRequest('local'),
    )
    const body = (await result.response.json()) as { ok: boolean; error: { code: string } }
    expect(result.response.status).toBe(401)
    expect(result.mutated).toBe(false)
    expect(body.error.code).toBe('PROVIDER_AUTH_FAILED')
  })

  test('handled result → 200, mutated true', async () => {
    const result = await handleRequest(
      webhookProvider('local', async () => ({ handled: true, message: 'ok' })),
      webhookRequest('local'),
    )
    const body = (await result.response.json()) as { ok: boolean; data: { handled: boolean } }
    expect(result.response.status).toBe(200)
    expect(result.mutated).toBe(true)
    expect(body.data.handled).toBe(true)
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
    const body = (await result.response.json()) as {
      ok: boolean
      error: { code: string; message: string }
    }
    expect(result.response.status).toBe(500)
    expect(result.mutated).toBe(false)
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('INTERNAL_ERROR')
    expect(body.error.message).toContain('boom')
  })

  test('a thrown KanbanError keeps its mapped status + code through the envelope', async () => {
    const provider = webhookProvider('local', async () => {
      throw new KanbanError(ErrorCode.CONFLICT, 'version conflict during webhook apply')
    })
    const result = await handleRequest(provider, webhookRequest('local'))
    const body = (await result.response.json()) as { ok: boolean; error: { code: string } }
    expect(result.response.status).toBe(409)
    expect(result.mutated).toBe(false)
    expect(body.error.code).toBe('CONFLICT')
  })
})

describe('handleRequest malformed path encoding (D2 regression)', () => {
  test('malformed %-encoding in a task id → 400 INVALID_ARGUMENT, never thrown', async () => {
    const req = new Request('http://localhost/api/tasks/%E0%A4%A', { method: 'GET' })
    // Must not reject — before the fix decodeURIComponent threw a URIError that
    // escaped handleRequest.
    const result = await handleRequest(provider, req)
    const body = (await result.response.json()) as { ok: boolean; error: { code: string } }
    expect(result.response.status).toBe(400)
    expect(result.mutated).toBe(false)
    expect(body.error.code).toBe('INVALID_ARGUMENT')
  })

  test('malformed %-encoding in a webhook target → 400 INVALID_ARGUMENT', async () => {
    const result = await handleRequest(webhookProvider('local'), webhookRequest('%E0%A4%A'))
    const body = (await result.response.json()) as { ok: boolean; error: { code: string } }
    expect(result.response.status).toBe(400)
    expect(result.mutated).toBe(false)
    expect(body.error.code).toBe('INVALID_ARGUMENT')
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
      const body = (await result.response.json()) as { ok: boolean; error: { code: string } }
      expect(result.response.status).toBe(status)
      expect(body.error.code).toBe(code)
      expect(result.mutated).toBe(false)
    })
  }
})
