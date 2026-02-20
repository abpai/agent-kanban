import { beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initSchema, seedDefaultColumns, addTask } from '../db.ts'
import { handleRequest } from '../api.ts'

let db: Database

beforeEach(() => {
  db = new Database(':memory:')
  db.run('PRAGMA foreign_keys = ON')
  initSchema(db)
  seedDefaultColumns(db)
})

describe('handleRequest', () => {
  test('returns API 404 envelope for unknown route', async () => {
    const req = new Request('http://localhost/api/not-a-route', { method: 'GET' })
    const result = await handleRequest(db, req)

    expect(result.mutated).toBe(false)
    expect(result.response.status).toBe(404)
  })

  test('marks failed PATCH mutation as not mutated', async () => {
    const req = new Request('http://localhost/api/tasks/t_missing', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Nope' }),
    })
    const result = await handleRequest(db, req)

    expect(result.response.status).toBe(404)
    expect(result.mutated).toBe(false)
  })

  test('marks successful task creation as mutated', async () => {
    const req = new Request('http://localhost/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Created via API' }),
    })
    const result = await handleRequest(db, req)

    expect(result.response.status).toBe(200)
    expect(result.mutated).toBe(true)
  })

  test('marks successful task delete as mutated', async () => {
    const task = addTask(db, 'Delete me')
    const req = new Request(`http://localhost/api/tasks/${task.id}`, { method: 'DELETE' })
    const result = await handleRequest(db, req)

    expect(result.response.status).toBe(200)
    expect(result.mutated).toBe(true)
  })
})
