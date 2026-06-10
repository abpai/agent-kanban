import type { Sql } from 'postgres'

import type { WebhookRequest, WebhookResult } from '../webhooks'
import { withWebhookRecording } from '../webhook-events'
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
    return withWebhookRecording(this.sql, 'jira', payload, () => this.handleWebhookCore(payload))
  }
}
