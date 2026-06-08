import type { Sql } from 'postgres'

import { DEFAULT_POLLING_SYNC_INTERVAL_MS } from '../sync-config'
import type { WebhookRequest, WebhookResult } from '../webhooks'
import { extractWebhookMeta, recordWebhookEvent, webhookEventStatus } from '../webhook-events'
import { LinearClient } from './linear-client'
import { LinearProviderCore } from './linear-core'
import { PostgresLinearCache } from './postgres-linear-cache'

/**
 * Postgres-backed Linear provider. All business logic lives in
 * LinearProviderCore; this subclass injects the Postgres cache repository and
 * keeps the `sql` client only to record webhook-event audit rows (a
 * Postgres-only feature) around the shared webhook dispatch.
 */
export class PostgresLinearProvider extends LinearProviderCore {
  constructor(
    private readonly sql: Sql,
    teamId: string,
    apiKey: string,
    pollingSyncIntervalMs = DEFAULT_POLLING_SYNC_INTERVAL_MS,
    client?: LinearClient,
  ) {
    super(
      new PostgresLinearCache(sql),
      teamId,
      client ?? new LinearClient(apiKey),
      pollingSyncIntervalMs,
    )
  }

  override async handleWebhook(payload: WebhookRequest): Promise<WebhookResult> {
    const meta = extractWebhookMeta('linear', payload.rawBody)
    let result: WebhookResult
    try {
      result = await this.handleWebhookCore(payload)
    } catch (err) {
      void recordWebhookEvent(this.sql, {
        provider: 'linear',
        ...meta,
        status: 'error',
        detail: { error: err instanceof Error ? err.message : String(err) },
      })
      throw err
    }
    void recordWebhookEvent(this.sql, {
      provider: 'linear',
      ...meta,
      status: webhookEventStatus(result),
    })
    return result
  }
}
