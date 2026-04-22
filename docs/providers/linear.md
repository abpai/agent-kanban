# Linear Integration

**Status: shipped**

## Summary

`agent-kanban` runs against either a local SQLite backend or Linear's GraphQL
API. A `KanbanProvider` interface sits between the CLI, API, and UI so the rest
of the codebase does not need to know which backend is active.

## Architecture

```text
Agents / CLI / UI
      |
      v
REST API (existing routes, thin adapter)
      |
      v
KanbanProvider
  |- LocalProvider  -> wraps db.ts/activity.ts/metrics.ts
  |- LinearProvider -> calls Linear GraphQL API
```

`KANBAN_PROVIDER` selects the backend at startup. Linear mode requires
`LINEAR_API_KEY` and `LINEAR_TEAM_ID`.

## What shipped

Provider support lives in `src/providers/`:

| File               | Purpose                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `types.ts`         | `KanbanProvider` interface and shared DTOs                                                                      |
| `errors.ts`        | Provider-specific error constructors (`UNSUPPORTED_OPERATION`, `PROVIDER_AUTH_FAILED`, `PROVIDER_RATE_LIMITED`) |
| `capabilities.ts`  | Capability flags per provider                                                                                   |
| `index.ts`         | Factory that reads env vars and returns the active provider                                                     |
| `local.ts`         | `LocalProvider`, which wraps the SQLite implementation                                                          |
| `linear.ts`        | `LinearProvider`, which implements the interface against Linear                                                 |
| `linear-client.ts` | GraphQL client, query builders, and response parsing                                                            |
| `linear-cache.ts`  | SQLite-backed cache tables for synced issues, states, activity rows, and team metadata                          |

## Capability matrix

| Capability                 | Local | Linear |
| -------------------------- | ----- | ------ |
| task create/update/move    | yes   | yes    |
| task delete                | yes   | no     |
| activity log               | yes   | no     |
| metrics                    | yes   | no     |
| column CRUD                | yes   | no     |
| bulk operations            | yes   | no     |
| config edit                | yes   | no     |
| webhooks                   | no    | yes    |
| comment read/create/update | yes   | yes    |
| comment count (read)       | no    | yes    |
| labels (read)              | no    | yes    |
| conflict detection         | yes   | yes    |

The CLI, API server, and web UI check capabilities before calling the provider.
Unsupported operations return `UNSUPPORTED_OPERATION` with exit code `1`. The UI
hides actions the active provider does not support.

`activity log = no` here means Linear mode does not expose the same local
dashboard/bootstrap activity feed or metrics surface as the SQLite provider.
The provider still syncs upstream history into cache tables for reconciliation
and provider-backed reads.

## API and interface notes

Endpoint paths stayed the same. Internals switched from direct `db.ts` calls to
`provider.methodName()`.

Additional provider-facing error codes:

- `UNSUPPORTED_OPERATION`: capability is not available in the active provider
- `PROVIDER_AUTH_FAILED`: missing or invalid API key
- `PROVIDER_RATE_LIMITED`: Linear API rate limit was hit

Linear tasks include `externalRef` such as `TEAM-123` and a `url` in their
payload. Commands accept either the internal ID or the external ref.

## Test coverage

The shipped work includes:

- provider contract tests against `LocalProvider`
- API integration tests in local mode to preserve behavior parity
- manual live Linear validation for board view, task create, task update, task
  move, and major error paths

## Current limitations

1. Single Linear team per instance
2. API key auth only, with no OAuth flow
3. Webhook sync is optional; see [Webhooks](#webhooks). Polling still runs as
   the freshness and reconciliation fallback.
4. Comment bodies are not mirrored into the cached board view. Comment reads
   and writes go straight upstream, while the cached board keeps only
   `comment_count`.
5. Some local-only operations intentionally remain unsupported

## Webhooks

`agent-kanban` accepts Linear webhooks at `POST /api/webhooks/linear`. The
handler mirrors Linear's standard payload (`{ action, type, data }`) and
updates the cache immediately, while normal polling continues so activity
history, missed deliveries, and upstream deletions can still be reconciled.

Supported events: `Issue.create`, `Issue.update`, `Issue.remove`.

Issue webhooks that do not belong to the configured team are ignored.

### Signature verification

If `LINEAR_WEBHOOK_SECRET` is set, the handler verifies HMAC-SHA256 of the
raw body against the `Linear-Signature` header (hex digest). Requests with a
missing or mismatched signature return HTTP 401. If the env var is unset the
endpoint is open — put it behind a trusted network boundary.

### Public URL

Webhooks require a public URL. For local development, run the server with
the built-in `--tunnel` flag:

```sh
kanban serve --tunnel
```

This spawns `bunx cloudflared tunnel --url http://localhost:<port>` and
prints the public `https://*.trycloudflare.com` URL to stdout. Append
`/api/webhooks/linear` and register the result in Linear's webhook settings.
Install cloudflared first with `brew install cloudflared` or
`npm i -g cloudflared`; the server keeps running if it's missing, just
without the tunnel.

## Future work

- Label writes synced from the UI back to Linear
- Delete-as-archive behavior in Linear mode
- Multi-team support
