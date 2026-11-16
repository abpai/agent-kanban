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

Provider requests have a 30-second deadline covering response headers and body
consumption. A timeout aborts the request and returns `PROVIDER_UPSTREAM_ERROR`;
the client does not automatically retry a task mutation.

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
| label replacement (update) | yes   | yes    | yes  |
| webhooks                   | no    | yes    | yes  |
| comment read/create/update | yes   | yes    | yes  |
| attachment list/read       | no    | no     | yes  |
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

Jira Cloud stores rich text as **Atlassian Document Format (ADF)**, a JSON
tree. Descriptions and comments both go through
[`src/providers/jira-adf/`](../../src/providers/jira-adf/index.ts), which converts
between ADF and GitHub-flavored markdown. Consumers can import it as
`@andypai/agent-kanban/jira-adf`.

- **Reads never drop content.** `adfToMarkdown` renders every node as
  markdown, or as a visible `[unsupported Jira content: <type> ...]` marker
  plus an entry in `warnings`. Container markers wrap the content they hold
  (`[end unsupported Jira content: <type>]`), so no text disappears. The
  result also carries `lossless` (the markdown parses back to the same
  normalized ADF) and `converterVersion`.
- **Writes refuse what Jira cannot represent.** `markdownToAdf` returns
  `{ ok: false, issues }` for images, raw HTML, table column alignment, block
  types a container cannot hold under the ADF schema (a task list in a quote, a table in a nested
  expand), status colors outside the named set and `#rrggbb`, mentions with
  no account id, or markdown that still carries an unsupported-content marker
  (also when formatting or link syntax splits it). The provider turns a refusal
  into `INVALID_ARGUMENT` before any request is sent. `markdownToAdf` never
  throws.
  The test suite checks every converted document against Atlassian's published
  ADF JSON Schema (`@atlaskit/adf-schema`, a pinned dev dependency), so these
  rules follow the schema Jira enforces rather than guesses.
- **Writes are confirmed structurally.** After a description or comment write,
  the provider compares what Jira stored with what it sent using
  `compareAdf`. A mismatch is `WRITE_UNCONFIRMED` (HTTP 409, MCP
  `validation_failed`). The write has already happened at that point and the
  message names the issue key or comment id, so do not retry it as a new
  write.

### Markdown syntax per ADF node

| ADF                                          | Markdown                                                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| paragraph, hardBreak                         | text, `\` at line end (a soft line break also writes one)                                                         |
| heading 1-6                                  | `#` to `######`                                                                                                   |
| bulletList, orderedList (any depth, `order`) | `-`, `1.` (`7.` keeps the start number)                                                                           |
| listItem with several blocks                 | indented paragraphs, lists, and fenced code                                                                       |
| taskList, taskItem                           | `- [ ]`, `- [x]`                                                                                                  |
| codeBlock with language                      | fenced code                                                                                                       |
| blockquote                                   | `>`                                                                                                               |
| rule                                         | `---`                                                                                                             |
| table (header row, one paragraph per cell)   | GFM table                                                                                                         |
| expand, nestedExpand                         | `::: expand title="..."` ... `:::`                                                                                |
| strong, em, strike, code, link               | `**`, `*`, `~~`, backticks, `[text](url)`                                                                         |
| underline, subsup, textColor                 | `<u>`, `<sub>`/`<sup>`, `<span style="color: #rrggbb">`                                                           |
| inlineCard                                   | `<https://...>`                                                                                                   |
| mention, emoji, status, date                 | `[@Name](jira-mention:id)`, `[:smile:](jira-emoji:id)`, `[DONE](jira-status:green)`, `[2026-11-16](jira-date:ms)` |

A bare URL stays plain text, the way Jira stores a typed URL.

Shown as markers: panel, media nodes, decision lists, layouts, extensions,
block and embed cards, placeholders, unknown node types, and tables a GFM
table cannot hold (no header row, merged cells, block content in a cell,
numbered rows, or cell colors). Those tables still render flattened behind the
marker. Unsupported marks (for example `backgroundColor`, `annotation`,
`alignment`) keep their text and add a warning.

### Normalization

`normalizeAdf` defines when two documents are the same. It ignores
presentation-only data: `localId`, table layout and widths, column widths,
default attribute values, empty spacer paragraphs, line breaks at the start or
end of a paragraph, whitespace at the edges of a table cell, whitespace at the
edges of bold or italic text, emoji `text`, and mention access level. It merges
adjacent text with the same marks and treats `\n` inside text as a line break.

`lossless` uses the same definition. A table with custom column widths, or a
description with blank spacer paragraphs, reads as lossless, but writing the
markdown back drops the widths and spacers. `markdownToAdf` also gives tables,
task lists and status lozenges fresh random `localId`s on every call, so hash
`normalizeAdf(document)` rather than the raw document when comparing writes.

### Converter version

`JIRA_ADF_CONVERTER_VERSION` changes whenever the same ADF could render to
different markdown. Store it next to anything derived from rendered text so
the derived value can be recomputed. After an upgrade, cached descriptions
re-render on the next full reconcile: same-instant snapshots with different
text trigger the existing authoritative `GET /issue` read.

### Fresh reads and description hashes

Every Jira task carries `description_hash`: `sha256:<hex>` of the raw ADF
description as Jira stores it, with object keys sorted. It never depends on the
converter, so a converter upgrade cannot make an unchanged description look
edited. It is `null` when the issue has no description, and
`adfContentHash(doc)` from `@andypai/agent-kanban/jira-adf` computes the same
value. Rows cached before this field existed are re-read once through
`GET /issue` on their next snapshot.

`provider.getTask(id, { fresh: true })` reads one issue now:

1. One `GET /issue/{id or key}`, skipping the background warmer and any sync.
2. The result is written into the cache as an authoritative row.
3. The task comes back with `description_hash` and `fresh_read`:
   `read_at`, `converter_version`, `description_lossless`,
   `description_warnings`, `attachments` (each with a `digest`), and
   `attachments_digest`.
4. If Jira cannot be reached or answers with an error, the read throws. It
   never falls back to the cache.

An attachment `digest` is `sha256:<hex>` of `[id, filename, size, mimeType,
created]`. Jira never edits an attachment in place (a re-upload gets a new id),
so this identifies the bytes without downloading them. `attachments_digest`
hashes the attachment digests sorted by attachment id. Linear also supports
`fresh: true` (one issue fetch, no `fresh_read`); the local provider is always
fresh.

## Cache freshness

SQLite and Postgres retain the newest task snapshot by Jira's `updated` instant,
including when a delayed polling result or webhook arrives after a successful
write. Duplicate rows in a polling batch follow the same rule. Repeated snapshots
are harmless; conflicting snapshots at the same instant trigger a direct
`GET /issue` read instead of choosing a column by arrival order. If that read
fails, the existing cache state is retained and the sync or webhook reports the
failure for retry. A genuinely newer move, including a move back to Backlog,
still updates the cache.

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
6. **Attachment reads are live, bounded, and Jira-origin only.**
   `listAttachments` reads `fields=attachment` from the issue on every call,
   refusing redirects and any entry without a valid size; nothing is cached.
   `readAttachment` downloads
   `/rest/api/3/attachment/content/{id}?redirect=false` with `redirect:
'manual'`. An id outside the issue's attachment list is `NOT_FOUND`; a
   redirect, a declared size above the caller's `maxBytes`, or a body whose
   length differs from the declared size is `ATTACHMENT_REFUSED`, which a
   retry cannot clear, unlike `PROVIDER_UPSTREAM_ERROR`. Error bodies are read
   up to 64 KiB. The download deadline is the request deadline plus one second
   per MiB of the declared size. Uploads are not supported. The CLI exposes
   these reads as `kanban task attachments` and `kanban task attachment get`;
   MCP exposes them as `listAttachments` and `getAttachment`.
7. **Board column -> status mapping is many-to-one on read, one-of-many on
   write.** Moves always pick the first mapped status; if you need a different
   target status you must either reorder the board config or edit the issue
   directly in Jira.
8. Some ADF content has no markdown form. It is shown as a marker on read, and
   markdown that still holds a marker is refused on write. See
   [How descriptions work](#how-descriptions-work).

## Webhooks

`agent-kanban` exposes `POST /api/webhooks/jira` for real-time remote→local
propagation. The handler accepts the standard Jira webhook payload shape
(`{ webhookEvent, issue }`) and updates the cached issue directly, while the
normal poll loop continues so missed deletes and activity/changelog drift can
still be repaired.

Supported events: `jira:issue_created`, `jira:issue_updated`,
`jira:issue_deleted`.

### HMAC verification

Jira Cloud admin webhooks sign payloads with a shared secret. Set
`JIRA_WEBHOOK_SECRET` to that secret; the signature is verified from Jira's
`X-Hub-Signature` header (`sha256=<hex>`). Requests with a missing or mismatched
signature return HTTP 401.

If `JIRA_WEBHOOK_SECRET` is unset, the endpoint accepts unsigned payloads in
local open dev mode and logs a warning. Do not expose that mode publicly:
`kanban serve --tunnel` refuses to start in Jira mode unless
`JIRA_WEBHOOK_SECRET` is set.

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

### Activity refresh and rate limits

Each provider instance remembers the last successful changelog read per issue
(up to 10,000 issues, in memory). Sync, webhook, and write read-back skip the
changelog request when the issue's `updated` timestamp is unchanged and the last
read is under 30 minutes old. Failed reads are not remembered, and a restart
simply re-fetches.

A Jira 429 blocks further requests on that client until the `Retry-After`
deadline (seconds or HTTP date; 60 seconds if missing or invalid). Blocked calls
fail with `PROVIDER_RATE_LIMITED` without touching the network, and nothing is
replayed automatically; the sync loop retries on its next tick.
