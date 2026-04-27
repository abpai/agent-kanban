# Jira Integration

**Status: shipped**

## Overview

`agent-kanban` supports Jira Cloud as a third backend alongside the local SQLite
provider and the Linear provider. All three implement the same `KanbanProvider`
interface, so the CLI, REST API, and web UI do not need to know which backend is
active.

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
  |- JiraProvider   -> calls Jira Cloud REST + Agile API
```

Jira topology mirrors Linear: at startup the provider fetches the project's
workflow statuses and (optionally) the Agile board's column configuration,
caches them in memory, and uses the cache to translate between kanban column
names and Jira status ids. Priorities are cached the same way and mapped by
name (`low`, `medium`, `high`, `urgent`).

The provider is selected at startup via `KANBAN_PROVIDER=jira`. Only Jira Cloud
(`*.atlassian.net`) is supported — not Jira Server or Data Center.

## Prerequisites

- A Jira Cloud site (`https://<your-domain>.atlassian.net`).
- An Atlassian account email with access to the target project.
- An Atlassian API token. Create one at
  [https://id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens).
- A Jira project key (e.g. `ENG`), supplied via `JIRA_PROJECT_KEY`.
- Optionally an Agile board id (`JIRA_BOARD_ID`) if you want kanban columns to
  follow the board's column ordering instead of the raw project status list.

## Environment variables

| Variable                  | Default | Required                             | Description                                                                         |
| ------------------------- | ------- | ------------------------------------ | ----------------------------------------------------------------------------------- |
| `JIRA_BASE_URL`           | —       | Required when `KANBAN_PROVIDER=jira` | Atlassian site base URL, no trailing slash (e.g. `https://acme.atlassian.net`).     |
| `JIRA_EMAIL`              | —       | Required when `KANBAN_PROVIDER=jira` | Atlassian account email used for HTTP Basic auth together with the API token.       |
| `JIRA_API_TOKEN`          | —       | Required when `KANBAN_PROVIDER=jira` | Atlassian API token. See the Prerequisites section for the creation link.           |
| `JIRA_PROJECT_KEY`        | —       | Required when `KANBAN_PROVIDER=jira` | Project key that scopes the kanban board (e.g. `ENG`).                              |
| `JIRA_BOARD_ID`           | —       | Optional when `KANBAN_PROVIDER=jira` | Agile board id for ordered kanban columns. Falls back to project statuses if unset. |
| `JIRA_ISSUE_TYPE`         | `Task`  | Optional when `KANBAN_PROVIDER=jira` | Default issue type for newly created tasks.                                         |
| `KANBAN_SYNC_INTERVAL_MS` | `30000` | Optional                             | Polling sync interval in milliseconds. Must be an integer >= 1000.                  |

Authentication uses HTTP Basic auth: the `JIRA_EMAIL` + `JIRA_API_TOKEN` pair is
base64 encoded in the `Authorization` header on every request.

## Capabilities

| Capability                 | Local | Linear | Jira |
| -------------------------- | ----- | ------ | ---- |
| task create/update/move    | yes   | yes    | yes  |
| task delete                | yes   | no     | no   |
| activity log               | yes   | no     | no   |
| metrics                    | yes   | no     | no   |
| column CRUD                | yes   | no     | no   |
| bulk operations            | yes   | no     | no   |
| config edit                | yes   | no     | no   |
| webhooks                   | no    | yes    | yes  |
| comment read/create/update | yes   | yes    | yes  |
| labels (read)              | no    | yes    | yes  |
| comment count (read)       | no    | yes    | yes  |
| conflict detection         | yes   | yes    | yes  |

The CLI, API server, and web UI check capabilities before calling the provider.
Unsupported operations return `UNSUPPORTED_OPERATION` with exit code `1`. The UI
hides actions that the active provider does not support.

`activity log = no` here means Jira mode does not expose the same local
dashboard/bootstrap activity feed or metrics surface as the SQLite provider.
The provider still syncs changelog history into cache tables for reconciliation
and provider-backed reads.

## How moves work

Jira does not let callers write an issue's status directly. A status change is
always the result of executing a **workflow transition** from the issue's
current status to the target status. `moveTask` has to translate a kanban column
name into a transition id:

1. Kanban column names are resolved against the cached board configuration.
   When `JIRA_BOARD_ID` is set, the provider uses the board's column -> status
   mappings. Otherwise it uses the project's status list.
2. A single board column can map to **multiple** Jira statuses (for example a
   `Done` column that contains both `Resolved` and `Closed`). `moveTask` picks
   the **first mapped status** in the board-config order. This is deterministic
   across runs; the order is whatever Jira returns for the board config.
3. The provider fetches `/rest/api/3/issue/{key}/transitions` for the target
   issue, finds a transition whose `to.id` equals the chosen target status id,
   and POSTs back to that endpoint with the transition id.
4. If no matching transition exists from the issue's current status, the
   provider raises `PROVIDER_UPSTREAM_ERROR` with a message containing the
   exact substring `"has no transition to status"`. The message also lists the
   available transition names so an operator can see which Jira workflow edits
   are needed.

This means a move may succeed for one issue and fail for another in the same
column, because Jira workflows are per-issue-type and may not allow every
transition from every status.

## How descriptions work

Jira Cloud stores rich text as **Atlassian Document Format (ADF)**, a JSON tree.
The provider does a best-effort round-trip between plain text and ADF:

- **Writes (plain text -> ADF).** The input string is wrapped in an ADF
  document. The following node types are produced from simple markdown-ish
  input:
  - paragraphs (default for each non-empty line)
  - bullet lists (`- item`)
  - ordered lists (`1. item`)
  - fenced code blocks (` ```lang ... ``` `)

  Anything else is emitted as a plain paragraph.

- **Reads (ADF -> plain text).** The provider walks the ADF tree and flattens
  it back to text. Supported node types round-trip cleanly. Headings are
  flattened to their text content. Unknown node types are **skipped
  gracefully** — the provider does not throw on unfamiliar ADF.

Content authored in the Jira web UI survives the round-trip as long as it only
uses the node set above. Richer content (panels, media, status lozenges, etc.)
is dropped on read. This is documented behavior, not a silent failure: expect
to lose those nodes if you round-trip through `agent-kanban`.

## Limitations

1. **Jira Cloud only.** Jira Server and Data Center are not supported; their
   auth and transition APIs differ.
2. **Single Jira project per instance.** `JIRA_PROJECT_KEY` scopes the whole
   board.
3. **Basic auth via email + API token only.** No OAuth flow.
4. **Webhook sync is optional.** The provider accepts Jira webhooks at
   `POST /api/webhooks/jira` and updates the cache immediately, while polling
   continues as the freshness and reconciliation fallback. See
   [Webhooks](#webhooks).
5. **Comment reads and writes are live, comment-body sync is not.** Jira labels
   and a lightweight comment count are mirrored into the local cache and shown
   on the card and detail view. Comment reads and writes go straight upstream,
   but full comment bodies are not mirrored into the cached board view. Label
   writes are still unsupported.
6. **Board column -> status mapping is many-to-one on read, one-of-many on
   write.** Moves always pick the first mapped status; if you need a different
   target status you must either reorder the board config or edit the issue
   directly in Jira.
7. ADF node types outside paragraphs, bullet/ordered lists, and fenced code
   blocks are dropped on read and not produced on write.

## Webhooks

`agent-kanban` exposes `POST /api/webhooks/jira` for real-time remote→local
propagation. The handler accepts the standard Jira webhook payload shape
(`{ webhookEvent, issue }`) and updates the cached issue directly, while the
normal poll loop continues so missed deletes and activity/changelog drift can
still be repaired.

Supported events: `jira:issue_created`, `jira:issue_updated`,
`jira:issue_deleted`.

### Optional HMAC verification

Jira Cloud's native webhooks do not sign payloads with a shared secret. If
you front the endpoint with a proxy (Cloudflare Worker, Atlassian Connect
JWT, etc.) that injects an HMAC-SHA256 of the raw body, set
`JIRA_WEBHOOK_SECRET` and the signature will be verified from the
`X-Hub-Signature-256` header (`sha256=<hex>` prefix is optional). Requests
with a missing or mismatched signature return HTTP 401.

If `JIRA_WEBHOOK_SECRET` is unset the endpoint is open — put it behind a
trusted network boundary.

### Public URL

Webhooks require a public URL. For local development, run the server with
the built-in `--tunnel` flag:

```sh
kanban serve --tunnel
```

This spawns `bunx cloudflared tunnel --url http://localhost:<port>` and
prints the public `https://*.trycloudflare.com` URL to stdout. Append
`/api/webhooks/jira` and register the result in Jira's webhook settings.
Install cloudflared first with `brew install cloudflared` or
`npm i -g cloudflared`; the server keeps running if it's missing, just
without the tunnel.

## Troubleshooting

| Error code                                                     | Likely cause                                                                                                                  | Fix                                                                                                                                                 |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROVIDER_NOT_CONFIGURED`                                      | One or more of the required `JIRA_*` environment variables is missing. The error message lists the missing keys.              | Set `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, and `JIRA_PROJECT_KEY`. Restart the CLI / server.                                              |
| `PROVIDER_AUTH_FAILED`                                         | Jira returned 401 or 403. Usually a bad `JIRA_EMAIL` + `JIRA_API_TOKEN` pair, a revoked token, or insufficient project scope. | Regenerate the API token, confirm the email matches the Atlassian account, and check that the account can see the project.                          |
| `PROVIDER_RATE_LIMITED`                                        | Jira returned 429. The shared Jira Cloud rate limit was exceeded.                                                             | Wait a few seconds and retry. Reduce poll frequency if you are driving the API from a script.                                                       |
| `PROVIDER_UPSTREAM_ERROR` with `"has no transition to status"` | The issue's current Jira workflow does not allow a transition to the resolved target status for the kanban column.            | Edit the Jira workflow so that a transition exists, or move the issue in the Jira UI first. The error message lists the available transition names. |
| `PROVIDER_UPSTREAM_ERROR` (other)                              | Generic upstream Jira error (5xx, unexpected response shape).                                                                 | Inspect the message; retry. If persistent, check Jira status page.                                                                                  |
| `COLUMN_NOT_FOUND`                                             | The column name or id passed to `moveTask` is not present in the cached board configuration.                                  | Run `kanban column list` to see the cached columns; re-check `JIRA_BOARD_ID` or the project's status list.                                          |
