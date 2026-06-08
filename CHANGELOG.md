# Changelog

## 0.6.0 - 2026-06-08

- Fixed Jira issue sync to follow the `/rest/api/3/search/jql` cursor. That
  endpoint omits `total` and paginates by an opaque `nextPageToken`, but the
  sync loop still terminated on the legacy `accumulated < total` condition, so
  once `total` came back `undefined` it stopped after the first page. On any
  project with more than 100 issues, every issue beyond the oldest 100 (by
  `updated ASC`) — including newly-created tickets — was silently never cached.
  The loop now follows `nextPageToken` until `isLast`. `JiraSearchPage`'s
  `startAt`/`maxResults`/`total` are now optional and `nextPageToken`/`isLast`
  are exposed.
- Jira create/update/move now perform read-after-write via `GET /issue/{key}`
  instead of `sync(true)` + cache read. The direct issue endpoint has no
  search-index lag, so a just-created or just-transitioned issue is reflected
  immediately. The previous pattern raced the search index — creates reported
  "not yet visible", and a move's new status sometimes failed to land, causing
  the poll loop to re-issue the same move repeatedly.
- A forced sync (`sync(true)`) on the Postgres provider no longer triggers a
  full 1970-based reconcile. `force` still bypasses the poll throttle so a write
  sees its own result, but the expensive whole-project re-fetch (plus a
  per-issue changelog call) now runs only on the periodic full-reconcile
  schedule. Column and catalog (users/priorities/issue types) refreshes, which
  use racy `DELETE`+`INSERT`, are likewise gated to full reconciles to avoid
  primary-key collisions under concurrent syncs.

## 0.5.1 - 2026-05-30

- Fixed Jira board cache sync when Jira returns duplicate board column names.
  Board-sourced cache ids remain unchanged for unique names and gain a
  positional suffix only for duplicate names, preventing Postgres and SQLite
  `jira_columns` primary-key collisions during sync.
- Jira column resolution (task move/list `--column`) now matches an exact column
  id first and rejects a name that maps to multiple columns with an actionable
  error listing the candidate ids, instead of silently picking the first match.
- The dashboard now submits column ids (not names) when adding and moving tasks,
  so add/move target the correct column on boards with duplicate column names.

## 0.5.0 - 2026-05-15

- Tasks can now carry labels end to end. The local provider stores a JSON
  `labels` column (added to both bun:sqlite and Postgres tasks tables via
  migration), `kanban task add` accepts repeated `--label` flags (each value
  may be comma-separated), and `POST /api/tasks` accepts a `labels` array.
- Jira and Linear `createTask` now forward `labels`. For Linear the names are
  resolved to label IDs against the workspace catalog before the GraphQL
  mutation; unknown names raise a clear upstream error.

## 0.4.0 - 2026-05-12

- Postgres providers now record a best-effort receipt into a new `webhook_events`
  table on every received webhook (`provider`, `event_type`, `external_ref`,
  `status` of `accepted`/`skipped`/`error`, plus a `detail` jsonb that only
  carries `{ error }` on failures). The table is created on provider bootstrap,
  the write never fails or slows a webhook, and the whole feature no-ops when
  `KANBAN_WEBHOOK_EVENTS` is set to `0`/`false`/`off`/`no`. It is not used by
  agent-kanban itself — it lets an external consumer (e.g. Garage Band's Studio
  view) see whether the sidecar received/processed a tracker webhook. See
  `docs/webhook-events.md`.

## 0.3.7 - 2026-05-12

- Fixed Jira webhook ingestion for SMTS payloads whose `issue.fields.description`
  arrives as a plain string instead of an ADF document, preventing
  `/api/webhooks/jira` from returning 500 on normal issue updates.
- Added Jira webhook and ADF regression coverage for string descriptions.

## 0.3.6 - 2026-05-11

- Jira webhook verification now uses Jira's native `X-Hub-Signature:
sha256=<hex>` header when `JIRA_WEBHOOK_SECRET` is configured.
- Retired the custom `X-Hub-Signature-256` Jira webhook compatibility path, so
  signed Jira webhooks use the same header shape Jira emits.

## 0.3.5 - 2026-05-11

- Added Postgres-backed provider storage for local, Jira, and Linear providers,
  including runtime storage configuration and provider-runtime wiring.
- Added Postgres provider contract coverage for task, comment, and cache-backed
  Jira/Linear flows.

## 0.3.4 - 2026-04-27

- Added `KANBAN_SYNC_INTERVAL_MS` to tune remote provider polling sync cadence
  for Jira and Linear. The default remains 30 seconds, and values must be
  integer milliseconds >= 1000.
- `kanban serve` uses the same sync interval for its background cache warmup
  loop, keeping CLI/API provider reads and dashboard refresh behavior aligned.

## 0.3.3 - 2026-04-26

- CLI now exposes task comment list/create/update operations with
  `kanban comment list`, `kanban comment add`, and `kanban comment update`.
- Jira ADF round-trip now preserves `expand` (collapsible disclosure) blocks.
  `plainTextToAdf` recognises a `::: expand` / `:::` fenced-div wire format
  with an optional `title="..."` attribute (escaped quotes supported);
  `adfToPlainText` mirrors expand nodes back to the same wrapper. The
  recursive parser handles arbitrary nested block content (paragraphs, lists,
  code blocks). Unterminated `::: expand` falls through to a paragraph,
  consistent with the existing unterminated-fence behaviour.

## 0.3.2 - 2026-04-26

- Jira ADF round-trip now preserves inline marks. `plainTextToAdf`
  recognises `**bold**` and `[label](https://…)` (or `http://`) and emits
  ADF `strong` and `link` marks; `adfToPlainText` mirrors them back to
  markdown. Code-block content is left literal (the inline tokenizer is
  scoped to paragraphs and list items).
- Fixed dropped URLs in description / comment extraction. `adfToPlainText`
  now reads `inlineCard` and `blockCard` / `embedCard` smart-link nodes
  (emitting `attrs.url`) and `hardBreak` (emitting `\n`), so pasted URLs
  that Jira auto-converted to smart links no longer vanish on read.
  Split Jira field labels like bold `Repo` followed by plain `:` now render as
  `**Repo:**`, preserving a contiguous `Repo:` label for agent parsers.

## 0.3.1 - 2026-04-26

- Fixed Linear sync against the live GraphQL schema by removing the unsupported
  `comments.totalCount` query field and deriving cached comment counts from
  returned comment nodes.
- Added a Jira ADF regression test for garage-baton fenced comment round-trips.
- Added shared provider/API vocabulary guidance for agents and contributors.
- Removed internal `.ts` import specifiers from `src/` and `scripts/`, then
  dropped the now-unneeded `allowImportingTsExtensions` TypeScript setting.
- Centralized provider capability defaults and added regression coverage for
  local versus remote capability surfaces.

## 0.3.0 - 2026-04-22

- Added Jira provider support with changelog-backed activity and webhook-ready
  server flows.
- Added provider-native comments support, including comment edit behavior.
- Added reusable MCP server primitives and a stdio MCP subcommand for local
  integrations.
- Improved provider cache reconciliation, Linear description-change activity,
  exact Linear comment-count preservation, and task-level WebSocket updates.
- Refreshed MCP, comments, Jira, Linear, and webhook workflow docs.
- Simplified dashboard filters and cleaned up unused CLI and UI helpers.

## 0.2.0 - 2026-04-06

- Added a published GitHub Pages marketing site under `site/`.
- Improved the mobile kanban dashboard with a more focused small-screen board flow.
- Simplified mobile board UI internals to make the new layout easier to maintain.
- Added repository agent instructions for Cursor Cloud contributors.

## 0.1.0 - 2026-03-28

- Initial public release of the Bun-based `agent-kanban` CLI and web dashboard.
