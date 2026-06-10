import type { Sql } from 'postgres'

import { DEFAULT_POLLING_SYNC_INTERVAL_MS } from '../sync-config'
import type { WebhookRequest, WebhookResult } from '../webhooks'
import { withWebhookRecording } from '../webhook-events'
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
    return withWebhookRecording(this.sql, 'linear', payload, () => this.handleWebhookCore(payload))
  }
}
