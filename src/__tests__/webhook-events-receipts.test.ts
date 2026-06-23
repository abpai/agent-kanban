import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Sql } from 'postgres'
import {
  ensureWebhookEventsSchema,
  recordWebhookEvent,
  withWebhookRecording,
} from '../webhook-events'

// A minimal fake of the `postgres` tagged-template client. It records every
// query (joined SQL text + interpolated values) and exposes `.json()` like the
// real client, so the receipts helpers can be unit-tested without a Postgres.
interface FakeSql {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>
  json: (v: unknown) => { __json: unknown }
  calls: { text: string; values: unknown[] }[]
}

function makeFakeSql(opts: { fail?: boolean } = {}): FakeSql {
  const calls: { text: string; values: unknown[] }[] = []
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join(' ? '), values })
    return opts.fail ? Promise.reject(new Error('db down')) : Promise.resolve([])
  }) as FakeSql
  fn.json = (v: unknown) => ({ __json: v })
  fn.calls = calls
  return fn
}

const asSql = (f: FakeSql): Sql => f as unknown as Sql

let prevFlag: string | undefined
beforeEach(() => {
  prevFlag = process.env['KANBAN_WEBHOOK_EVENTS']
  delete process.env['KANBAN_WEBHOOK_EVENTS'] // default = enabled
})
afterEach(() => {
  if (prevFlag === undefined) delete process.env['KANBAN_WEBHOOK_EVENTS']
  else process.env['KANBAN_WEBHOOK_EVENTS'] = prevFlag
})

describe('ensureWebhookEventsSchema (F37)', () => {
  test('enabled: issues CREATE TABLE + CREATE INDEX (idempotent DDL)', async () => {
    const sql = makeFakeSql()
    await ensureWebhookEventsSchema(asSql(sql))
    const text = sql.calls.map((c) => c.text).join('\n')
    expect(text).toContain('CREATE TABLE IF NOT EXISTS webhook_events')
    expect(text).toContain('CREATE INDEX IF NOT EXISTS webhook_events_received_at_idx')
    expect(sql.calls.length).toBe(2)
  })

  test('disabled: no DDL is issued', async () => {
    process.env['KANBAN_WEBHOOK_EVENTS'] = 'off'
    const sql = makeFakeSql()
    await ensureWebhookEventsSchema(asSql(sql))
    expect(sql.calls.length).toBe(0)
  })
})

describe('recordWebhookEvent (F40)', () => {
  test('enabled: inserts provider/eventType/externalRef/status/detail', async () => {
    const sql = makeFakeSql()
    await recordWebhookEvent(asSql(sql), {
      provider: 'jira',
      eventType: 'jira:issue_updated',
      externalRef: 'ENG-7',
      status: 'accepted',
      detail: { note: 'ok' },
    })
    expect(sql.calls.length).toBe(1)
    const insert = sql.calls[0]!
    expect(insert.text).toContain('INSERT INTO webhook_events')
    expect(insert.values).toEqual([
      'jira',
      'jira:issue_updated',
      'ENG-7',
      'accepted',
      { __json: { note: 'ok' } },
    ])
  })

  test('omitted eventType/externalRef/detail become null / empty json', async () => {
    const sql = makeFakeSql()
    await recordWebhookEvent(asSql(sql), { provider: 'linear', status: 'skipped' })
    const insert = sql.calls[0]!
    expect(insert.values).toEqual(['linear', null, null, 'skipped', { __json: {} }])
  })

  test('disabled: no insert', async () => {
    process.env['KANBAN_WEBHOOK_EVENTS'] = '0'
    const sql = makeFakeSql()
    await recordWebhookEvent(asSql(sql), { provider: 'jira', status: 'accepted' })
    expect(sql.calls.length).toBe(0)
  })

  test('a failing insert is swallowed (never throws) and is logged', async () => {
    const warnSpy = mock(() => {})
    const original = console.warn
    console.warn = warnSpy as unknown as typeof console.warn
    try {
      const sql = makeFakeSql({ fail: true })
      await recordWebhookEvent(asSql(sql), { provider: 'jira', status: 'accepted' })
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      console.warn = original
    }
  })
})

describe('withWebhookRecording (F39)', () => {
  test('success: returns dispatch result and records the mapped status', async () => {
    const sql = makeFakeSql()
    const body = JSON.stringify({ webhookEvent: 'jira:issue_updated', issue: { key: 'ENG-9' } })
    const result = await withWebhookRecording(
      asSql(sql),
      'jira',
      { headers: {}, rawBody: body },
      async () => ({ handled: true }),
    )
    expect(result).toEqual({ handled: true })
    const insert = sql.calls.find((c) => c.text.includes('INSERT INTO webhook_events'))
    expect(insert).toBeDefined()
    // provider, eventType(from body), externalRef(from body), status
    expect(insert!.values.slice(0, 4)).toEqual(['jira', 'jira:issue_updated', 'ENG-9', 'accepted'])
  })

  test('unhandled dispatch is recorded as skipped', async () => {
    const sql = makeFakeSql()
    const result = await withWebhookRecording(
      asSql(sql),
      'linear',
      { headers: {}, rawBody: '{}' },
      async () => ({ handled: false }),
    )
    expect(result).toEqual({ handled: false })
    const insert = sql.calls.find((c) => c.text.includes('INSERT INTO webhook_events'))!
    expect(insert.values[3]).toBe('skipped')
  })

  test('dispatch throw: records an error receipt and rethrows the original error', async () => {
    const sql = makeFakeSql()
    const boom = new Error('apply failed')
    let caught: unknown
    try {
      await withWebhookRecording(asSql(sql), 'jira', { headers: {}, rawBody: '{}' }, async () => {
        throw boom
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBe(boom)
    const insert = sql.calls.find((c) => c.text.includes('INSERT INTO webhook_events'))!
    expect(insert.values[3]).toBe('error')
    expect(insert.values[4]).toEqual({ __json: { error: 'apply failed' } })
  })
})
