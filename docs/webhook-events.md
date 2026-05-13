# `webhook_events` receipts table

When agent-kanban runs with Postgres storage (`KANBAN_STORAGE=postgres`), the
Jira and Linear providers append a small receipt to a `webhook_events` table
every time a webhook hits the sidecar's `POST /api/webhooks/:provider` route.

agent-kanban does not read this table itself. It exists so an external consumer
— specifically Garage Band's Studio "Webhooks" panel — can answer "did the
sidecar receive and process a tracker webhook, and when". agent-kanban owns and
creates the table; consumers read it read-only.

## Schema

Created on provider bootstrap (idempotent `CREATE TABLE IF NOT EXISTS`):

```sql
CREATE TABLE IF NOT EXISTS webhook_events (
  id           bigserial   PRIMARY KEY,   -- newest-first tie-breaker for readers
  received_at  timestamptz NOT NULL DEFAULT now(),
  provider     text        NOT NULL,      -- 'jira' | 'linear'
  event_type   text,                      -- Jira's `webhookEvent`, or Linear's `type.action`; null ok
  external_ref text,                       -- tracker key when derivable from the body; null ok
  status       text        NOT NULL,      -- 'accepted' | 'skipped' | 'error'
  detail       jsonb       NOT NULL DEFAULT '{}'::jsonb -- emit-time-controlled; never raw secrets/payloads
);
CREATE INDEX IF NOT EXISTS webhook_events_received_at_idx
  ON webhook_events (received_at DESC, id DESC);
```

`status` maps from the provider's `WebhookResult`: `handled → accepted`,
unhandled → `skipped`, `unauthorized` or a thrown error → `error`. On `error`
rows, `detail` carries `{ "error": "<message>" }`; otherwise `detail` is `{}`.

## Guarantees

- **Best-effort.** The receipt `INSERT` is wrapped — a logging failure is logged
  and swallowed — and fired without `await`, so it never fails or slows the
  webhook itself.
- **No retention.** The table grows one row per webhook; pruning old rows (e.g. a
  periodic `DELETE FROM webhook_events WHERE received_at < now() - interval '30 days'`)
  is the operator's / consumer's responsibility.
- **No payloads or secrets.** Only the small fields above are stored; raw webhook
  bodies and headers are never written.
- **Opt-out.** Set `KANBAN_WEBHOOK_EVENTS` to `0`/`false`/`off`/`no` to disable
  the table and the writes entirely.
- **SQLite mode is unaffected** — this is a Postgres-only feature, since the only
  consumer reads the shared Postgres deployment.
