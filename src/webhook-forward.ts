import type { WebhookAcceptedEvent } from './api'
import { extractWebhookMeta, recordWebhookEvent, type WebhookEventSql } from './webhook-events'

export interface WebhookForwardConfig {
  readonly url: string
  readonly token: string
}

export type WebhookForwardFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

/** Resolve the external webhook consumer from the standard server environment. */
export function resolveWebhookForwardConfig(
  env: Record<string, string | undefined>,
): WebhookForwardConfig | undefined {
  const url = env['KANBAN_WEBHOOK_FORWARD_URL']?.trim()
  const token = env['KANBAN_WEBHOOK_FORWARD_TOKEN']?.trim()
  if (!url || !token) return undefined
  return { url, token }
}

const FORWARD_TIMEOUT_MS = 10_000

/**
 * Build a fire-and-forget hook that forwards an accepted provider webhook.
 * Every configured Postgres run records a durable success or failure receipt.
 */
export function buildWebhookForwardHook(
  config: WebhookForwardConfig,
  sql: WebhookEventSql | undefined,
  fetchImpl: WebhookForwardFetch = fetch,
): (event: WebhookAcceptedEvent) => void {
  return (event) => {
    void forwardWebhookDelivery(config, sql, fetchImpl, event)
  }
}

async function forwardWebhookDelivery(
  config: WebhookForwardConfig,
  sql: WebhookEventSql | undefined,
  fetchImpl: WebhookForwardFetch,
  event: WebhookAcceptedEvent,
): Promise<void> {
  try {
    const response = await fetchImpl(config.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
      body: event.rawBody,
      signal: globalThis.AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    })
    if (response.ok) {
      await recordForwardOutcome(sql, event, { forward: 'succeeded' })
    } else {
      await recordForwardOutcome(sql, event, {
        forward: 'failed',
        error: `webhook consumer responded ${response.status}`,
      })
    }
  } catch (err) {
    await recordForwardOutcome(sql, event, {
      forward: 'failed',
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function recordForwardOutcome(
  sql: WebhookEventSql | undefined,
  event: WebhookAcceptedEvent,
  detail: { forward: 'succeeded' } | { forward: 'failed'; error: string },
): Promise<void> {
  if (!sql) return
  try {
    const provider = event.provider
    const meta = extractWebhookMeta(provider, event.rawBody)
    await recordWebhookEvent(sql, {
      provider,
      ...meta,
      status: detail.forward === 'succeeded' ? 'accepted' : 'error',
      detail,
    })
  } catch (err) {
    console.warn('[webhook-forward] failed to record forward receipt:', err)
  }
}
