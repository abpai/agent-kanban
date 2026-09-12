import type { WebhookEventSql } from '../../webhook-events'

interface SqlCall {
  text: string
  values: (string | null)[]
}

export function makeWebhookSql({ fail = false } = {}) {
  const calls: SqlCall[] = []
  const sql: WebhookEventSql = async (strings, ...values) => {
    calls.push({ text: strings.join(' ? '), values })
    if (fail) throw new Error('db down')
  }
  return Object.assign(sql, { calls })
}
