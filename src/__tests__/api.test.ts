import { beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initSchema, seedDefaultColumns, addTask } from '../db.ts'
import { handleRequest } from '../api.ts'
import { createProvider } from '../providers/index.ts'

let db: Database
let provider: ReturnType<typeof createProvider>

beforeEach(() => {
  process.env['KANBAN_PROVIDER'] = 'local'
  db = new Database(':memory:')
  db.run('PRAGMA foreign_keys = ON')
  initSchema(db)
  seedDefaultColumns(db)
  provider = createProvider(db, ':memory:')
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

  test('marks successful task creation as mutated', async () => {
    const req = new Request('http://localhost/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Created via API' }),
    })
    const result = await handleRequest(provider, req)

    expect(result.response.status).toBe(200)
    expect(result.mutated).toBe(true)
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

  test('marks successful comment update and delete as mutated', async () => {
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

    const deleteReq = new Request(`http://localhost/api/tasks/${task.id}/comments/${created.id}`, {
      method: 'DELETE',
    })
    const deleted = await handleRequest(provider, deleteReq)
    expect(deleted.response.status).toBe(200)
    expect(deleted.mutated).toBe(true)
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
    expect(result.event.columnName.toLowerCase()).toBe('backlog')
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
    expect(result.event.columnName.toLowerCase()).toBe('in-progress')
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
})
