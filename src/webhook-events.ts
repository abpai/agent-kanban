/**
 * `webhook_events` — a small, generically-named receipts table that the Postgres
 * providers append to on every received webhook. It is *not* used by agent-kanban
 * itself; it exists so an external consumer (for example a software factory's
 * dashboard "Webhooks" panel) can show "did the sidecar receive/process a
 * tracker webhook, and when".
 *
 * Ownership: agent-kanban owns and creates this table; consumers read it
 * read-only. Columns a consumer can rely on:
 *   id           bigserial   — newest-first tie-breaker (required by readers'
 *                              `ORDER BY received_at DESC, id DESC`)
 *   received_at  timestamptz — when the webhook hit the sidecar
 *   provider     text        — 'jira' | 'linear'
 *   event_type   text|null   — Jira's `webhookEvent`, or Linear's `type.action`
 *   external_ref text|null   — tracker key when derivable from the body
 *   status       text        — 'accepted' (handled) | 'skipped' (unhandled) |
 *                              'error' (unauthorized or threw)
 *   detail       jsonb       — emit-time-controlled; never raw secrets/payloads
 *                              (currently only `{ error }` on error rows)
 *
 * Best-effort by design: a receipt write must never fail or slow a webhook, and
 * the whole feature no-ops when `KANBAN_WEBHOOK_EVENTS` is off, so it is safe to
 * ship before any consumer exists.
 */

import type { JsonObject, JsonValue } from './json'

export interface WebhookEventSql {
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- Receipt writes ignore the driver-specific result; callers only await completion.
  (strings: TemplateStringsArray, ...values: (string | null)[]): PromiseLike<unknown>
}

import type { TrackerProvider } from './tracker-config'
import type { WebhookRequest, WebhookResult } from './webhooks'

interface WebhookMeta {
  eventType?: string
  externalRef?: string
}

export type WebhookEventStatus = 'accepted' | 'skipped' | 'error'

export interface WebhookEventRecord {
  provider: TrackerProvider
  eventType?: string | undefined
  externalRef?: string | undefined
  status: WebhookEventStatus
  detail?: JsonObject | undefined
}

/** `KANBAN_WEBHOOK_EVENTS` toggles the receipts table; enabled unless explicitly off. */
export function webhookEventsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env['KANBAN_WEBHOOK_EVENTS']?.trim().toLowerCase()
  return value !== '0' && value !== 'false' && value !== 'off' && value !== 'no'
}

/** Idempotent — call from a Postgres provider's schema bootstrap. */
export async function ensureWebhookEventsSchema(sql: WebhookEventSql): Promise<void> {
  if (!webhookEventsEnabled()) return
  await sql`
    CREATE TABLE IF NOT EXISTS webhook_events (
      id           bigserial   PRIMARY KEY,
      received_at  timestamptz NOT NULL DEFAULT now(),
      provider     text        NOT NULL,
      event_type   text,
      external_ref text,
      status       text        NOT NULL,
      detail       jsonb       NOT NULL DEFAULT '{}'::jsonb
    )
  `
  await sql`
    CREATE INDEX IF NOT EXISTS webhook_events_received_at_idx
      ON webhook_events (received_at DESC, id DESC)
  `
}

export function webhookEventStatus(result: WebhookResult): WebhookEventStatus {
  if (result.unauthorized) return 'error'
  return result.handled ? 'accepted' : 'skipped'
}

/** Run a webhook dispatch and record its outcome (accepted/skipped/error) fire-and-forget. */
export async function withWebhookRecording(
  sql: WebhookEventSql,
  provider: TrackerProvider,
  payload: WebhookRequest,
  dispatch: () => Promise<WebhookResult>,
): Promise<WebhookResult> {
  const meta = extractWebhookMeta(provider, payload.rawBody)
  let result: WebhookResult
  try {
    result = await dispatch()
  } catch (err) {
    void recordWebhookEvent(sql, {
      provider,
      ...meta,
      status: 'error',
      detail: { error: err instanceof Error ? err.message : String(err) },
    })
    throw err
  }
  void recordWebhookEvent(sql, {
    provider,
    ...meta,
    status: webhookEventStatus(result),
    ...(result.signatureStatus === undefined
      ? {}
      : { detail: { signatureStatus: result.signatureStatus } }),
  })
  return result
}

/** Append a receipt. Swallows every error — a logging miss must never fail the webhook. */
export async function recordWebhookEvent(
  sql: WebhookEventSql,
  record: WebhookEventRecord,
): Promise<void> {
  if (!webhookEventsEnabled()) return
  try {
    // Bind serialized JSON as text so postgres.js does not JSON-encode the string again.
    await sql`
      INSERT INTO webhook_events (provider, event_type, external_ref, status, detail)
      VALUES (
        ${record.provider},
        ${record.eventType ?? null},
        ${record.externalRef ?? null},
        ${record.status},
        ${JSON.stringify(record.detail ?? {})}::text::jsonb
      )
    `
  } catch (err) {
    console.warn('[webhook-events] failed to record receipt:', err)
  }
}

/** Light, provider-shaped peek at the raw body for a receipt's `event_type` / `external_ref`. */
export function extractWebhookMeta(providerType: TrackerProvider, rawBody: string): WebhookMeta {
  let parsed: JsonValue
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return {}
  }
  if (!isJsonObject(parsed)) return {}
  const body = parsed

  if (providerType === 'jira') {
    const eventType = typeof body['webhookEvent'] === 'string' ? body['webhookEvent'] : undefined
    const externalRef = nestedString(body['issue'], 'key')
    return withDefined({ eventType, externalRef })
  }
  if (providerType === 'linear') {
    const type = typeof body['type'] === 'string' ? body['type'] : undefined
    const action = typeof body['action'] === 'string' ? body['action'] : undefined
    const eventType = type && action ? `${type}.${action}` : (type ?? action)
    const externalRef = nestedString(body['data'], 'identifier') ?? nestedString(body['data'], 'id')
    return withDefined({ eventType, externalRef })
  }
  return {}
}

function nestedString(container: JsonValue | undefined, key: string): string | undefined {
  if (!isJsonObject(container)) return undefined
  const value = container[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function withDefined(meta: WebhookMeta): WebhookMeta {
  const result: WebhookMeta = {}
  if (meta.eventType) result.eventType = meta.eventType
  if (meta.externalRef) result.externalRef = meta.externalRef
  return result
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
