import { expect, test } from 'bun:test'
import postgres from 'postgres'

import { ensureWebhookEventsSchema, recordWebhookEvent } from '../webhook-events'

const databaseUrl = process.env['KANBAN_PG_TEST_URL'] ?? process.env['DATABASE_URL']
const pgTest = databaseUrl ? test : test.skip

pgTest('webhook receipt details remain queryable JSON objects in Postgres', async () => {
  if (!databaseUrl) throw new Error('A Postgres test database is required')
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} })
  const schema = `webhook_receipt_test_${crypto.randomUUID().replaceAll('-', '')}`
  const previousEnabled = process.env['KANBAN_WEBHOOK_EVENTS']
  process.env['KANBAN_WEBHOOK_EVENTS'] = '1'

  try {
    await sql`CREATE SCHEMA ${sql(schema)}`
    await sql`SET search_path TO ${sql(schema)}`
    await ensureWebhookEventsSchema(sql)

    const detail = {
      error: 'Upstream rejected "ticket"',
      signatureStatus: 'valid',
      nested: { attempts: [1, 2], retry: false, reason: null },
    }
    await recordWebhookEvent(sql, {
      provider: 'linear',
      eventType: 'Issue.update',
      externalRef: 'TEST-1',
      status: 'error',
      detail,
    })

    const rows = await sql<
      {
        detail_type: string
        detail: typeof detail
        error: string | null
        signature_status: string | null
        second_attempt: string | null
      }[]
    >`
      SELECT jsonb_typeof(detail) AS detail_type,
             detail,
             detail ->> 'error' AS error,
             detail ->> 'signatureStatus' AS signature_status,
             detail #>> '{nested,attempts,1}' AS second_attempt
        FROM webhook_events
       WHERE external_ref = 'TEST-1'
    `
    expect([...rows]).toEqual([
      {
        detail_type: 'object',
        detail,
        error: detail.error,
        signature_status: detail.signatureStatus,
        second_attempt: '2',
      },
    ])
  } finally {
    try {
      await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`
    } finally {
      if (previousEnabled === undefined) delete process.env['KANBAN_WEBHOOK_EVENTS']
      else process.env['KANBAN_WEBHOOK_EVENTS'] = previousEnabled
      await sql.end({ timeout: 1 })
    }
  }
})
