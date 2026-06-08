import type { Sql } from 'postgres'

import type { WebhookRequest, WebhookResult } from '../webhooks'
import { extractWebhookMeta, recordWebhookEvent, webhookEventStatus } from '../webhook-events'
import type { JiraClient } from './jira-client'
import { JiraProviderCore, type JiraProviderConfig } from './jira-core'
import { PostgresJiraCache } from './postgres-jira-cache'

export class PostgresJiraProvider extends JiraProviderCore {
  private readonly sql: Sql

  constructor(sql: Sql, config: JiraProviderConfig, client?: JiraClient) {
    super(new PostgresJiraCache(sql), config, client)
    this.sql = sql
  }

  // Postgres records every received webhook to the webhook_events audit table.
  // The shared dispatch lives in JiraProviderCore.handleWebhookCore; this wrapper
  // only adds the audit persistence around it.
  override async handleWebhook(payload: WebhookRequest): Promise<WebhookResult> {
    const meta = extractWebhookMeta('jira', payload.rawBody)
    let result: WebhookResult
    try {
      result = await this.handleWebhookCore(payload)
    } catch (err) {
      void recordWebhookEvent(this.sql, {
        provider: 'jira',
        ...meta,
        status: 'error',
        detail: { error: err instanceof Error ? err.message : String(err) },
      })
      throw err
    }
    void recordWebhookEvent(this.sql, {
      provider: 'jira',
      ...meta,
      status: webhookEventStatus(result),
    })
    return result
  }
}
