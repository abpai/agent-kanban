import { describe, expect, mock, test } from 'bun:test'
import type { Sql } from 'postgres'

import type { WebhookAcceptedEvent } from '../api'
import {
  buildWebhookForwardHook,
  resolveWebhookForwardConfig,
  type WebhookForwardConfig,
} from '../webhook-forward'

interface FakeSql {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>
  json: (value: unknown) => { __json: unknown }
  calls: { text: string; values: unknown[] }[]
}

function makeFakeSql(): FakeSql {
  const calls: { text: string; values: unknown[] }[] = []
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join(' ? '), values })
    return Promise.resolve([])
  }) as unknown as FakeSql
  sql.json = (value: unknown) => ({ __json: value })
  sql.calls = calls
  return sql
}

const asSql = (sql: FakeSql): Sql => sql as unknown as Sql

const EVENT = {
  provider: 'jira',
  rawBody: JSON.stringify({ webhookEvent: 'jira:issue_created', issue: { key: 'TASK-1' } }),
  headers: { 'content-type': 'application/json' },
} satisfies WebhookAcceptedEvent

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('resolveWebhookForwardConfig', () => {
  test('returns a complete forward target', () => {
    expect(
      resolveWebhookForwardConfig({
        KANBAN_WEBHOOK_FORWARD_URL: 'https://consumer.test/webhooks',
        KANBAN_WEBHOOK_FORWARD_TOKEN: 'token-1',
      }),
    ).toEqual({ url: 'https://consumer.test/webhooks', token: 'token-1' })
  })

  test('returns undefined when either value is absent', () => {
    expect(resolveWebhookForwardConfig({})).toBeUndefined()
    expect(
      resolveWebhookForwardConfig({ KANBAN_WEBHOOK_FORWARD_URL: 'https://consumer.test' }),
    ).toBeUndefined()
    expect(resolveWebhookForwardConfig({ KANBAN_WEBHOOK_FORWARD_TOKEN: 'token-1' })).toBeUndefined()
  })
})

describe('buildWebhookForwardHook', () => {
  const config: WebhookForwardConfig = {
    url: 'https://consumer.test/webhooks',
    token: 'token-1',
  }

  test('posts the accepted raw body and records success', async () => {
    const calls: { input: string | URL | Request; init?: RequestInit }[] = []
    const fetchImpl = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push({ input, ...(init ? { init } : {}) })
      return new Response(null, { status: 200 })
    }
    const sql = makeFakeSql()

    buildWebhookForwardHook(config, asSql(sql), fetchImpl)(EVENT)
    await flush()

    expect(calls).toHaveLength(1)
    const { input, init } = calls[0]!
    expect(input).toBe(config.url)
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe(EVENT.rawBody)
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer token-1')
    expect(init?.signal).toBeInstanceOf(globalThis.AbortSignal)
    expect(sql.calls[0]!.values).toEqual([
      'jira',
      'jira:issue_created',
      'TASK-1',
      'accepted',
      { __json: { forward: 'succeeded' } },
    ])
  })

  test('records an HTTP failure without throwing', async () => {
    const fetchImpl = mock(async () => new Response(null, { status: 503 }))
    const sql = makeFakeSql()

    expect(() =>
      buildWebhookForwardHook(config, asSql(sql), fetchImpl as unknown as typeof fetch)(EVENT),
    ).not.toThrow()
    await flush()

    expect(sql.calls[0]!.values[3]).toBe('error')
    expect(sql.calls[0]!.values[4]).toEqual({
      __json: { forward: 'failed', error: 'webhook consumer responded 503' },
    })
  })

  test('records a network failure without throwing', async () => {
    const fetchImpl = mock(async () => {
      throw new Error('connection refused')
    })
    const sql = makeFakeSql()

    buildWebhookForwardHook(config, asSql(sql), fetchImpl as unknown as typeof fetch)(EVENT)
    await flush()

    expect(sql.calls[0]!.values[4]).toEqual({
      __json: { forward: 'failed', error: 'connection refused' },
    })
  })

  test('does not require receipt storage in SQLite mode', async () => {
    const fetchImpl = mock(async () => new Response(null, { status: 200 }))

    buildWebhookForwardHook(config, undefined, fetchImpl as unknown as typeof fetch)(EVENT)
    await flush()

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
