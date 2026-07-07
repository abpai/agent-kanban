# Changelog

## 0.8.1

### Patch Changes

- [#86](https://github.com/abpai/agent-kanban/pull/86) [`f174bad`](https://github.com/abpai/agent-kanban/commit/f174bad86c4311f91ce5718b0aa8ac7764e80d31) Thanks [@abpai](https://github.com/abpai)! - Add autonomous-readiness tooling: a one-command `bootstrap` (root + UI install)
  and `smoke` script, and a local Postgres parity harness (`pg:up` / `pg:down` /
  `test:pg` + `docker-compose.postgres.yml` mirroring the CI Postgres service) so
  the `postgres-*` provider suites can be proven locally, not just in CI.

  Also adds a `knip` config + CI gate and trims the internal export surface:
  `KanbanStorageMode` and ~40 other symbols that were exported but never imported
  across modules are now module-private (or removed where fully dead). None were
  part of the public `exports`-map surface (`.`, `./types`, `./providers/types`,
  `./provider-runtime`), so consumers are unaffected.

## 0.8.0

### Minor Changes

- [#81](https://github.com/abpai/agent-kanban/pull/81) [`a4beede`](https://github.com/abpai/agent-kanban/commit/a4beede3591719b8cd95a2173d1eba9143916fa0) Thanks [@abpai](https://github.com/abpai)! - Strict `JIRA_BOARD_ID` parsing ([#79](https://github.com/abpai/agent-kanban/issues/79)). A non-empty malformed `JIRA_BOARD_ID` now fails config loading with `INVALID_CONFIG` instead of being silently coerced into a plausible-but-wrong board id (`'12abc'` → 12, `'-5'` → -5, `'1e3'` → 1) or dropped. An unset or blank value still means "no board pinned", and a valid positive integer is used as before. This matches how a malformed `KANBAN_SYNC_INTERVAL_MS` is already rejected.

  **Behavior change:** if `JIRA_BOARD_ID` is set to a non-numeric or non-positive value, config loading now errors instead of silently ignoring it. Set a valid board id or unset the variable.

### Patch Changes

- [#81](https://github.com/abpai/agent-kanban/pull/81) [`a4beede`](https://github.com/abpai/agent-kanban/commit/a4beede3591719b8cd95a2173d1eba9143916fa0) Thanks [@abpai](https://github.com/abpai)! - Honor the configured default task column when creating tasks through the local/SQLite CLI path ([#78](https://github.com/abpai/agent-kanban/issues/78)). `SqliteLocalStore.createTask` now applies `config.defaultTaskColumn` (falling back to the system default when unset), bringing it to parity with the Postgres store. Passing an explicit `--column` still overrides the default.

- [#81](https://github.com/abpai/agent-kanban/pull/81) [`a4beede`](https://github.com/abpai/agent-kanban/commit/a4beede3591719b8cd95a2173d1eba9143916fa0) Thanks [@abpai](https://github.com/abpai)! - Harden the `serve` HTTP API and webhook ingestion ([#76](https://github.com/abpai/agent-kanban/issues/76)). Webhook-route errors are now wrapped in the standard `{ ok: false, error }` envelope instead of leaking a raw, non-enveloped 500, alongside fixes across tunnel security, Postgres receipt handling, SSE broadcast, and base-path handling — 10 defects in total, with +66 regression tests.

- [#81](https://github.com/abpai/agent-kanban/pull/81) [`a4beede`](https://github.com/abpai/agent-kanban/commit/a4beede3591719b8cd95a2173d1eba9143916fa0) Thanks [@abpai](https://github.com/abpai)! - Close a webhook-secret fail-open and tighten config parsing ([#77](https://github.com/abpai/agent-kanban/issues/77)). `assertTunnelSecurity` now resolves each provider's webhook signing-secret env through a single `WEBHOOK_SECRET_ENV` source of truth, so a future webhook-capable provider can no longer start a public tunnel with no signing secret enforced. `KANBAN_SYNC_INTERVAL_MS` env parsing is also tightened to digits-only + safe-integer (rejecting hex/scientific notation), matching the strict `--sync-interval-ms` flag.

## 0.7.0

### Minor Changes

- [#73](https://github.com/abpai/agent-kanban/pull/73) [`f41a981`](https://github.com/abpai/agent-kanban/commit/f41a981ad62c7c9a8aeeb9707f833de27682ab5d) Thanks [@abpai](https://github.com/abpai)! - Add a public `exports` map declaring stable subpaths (`./types`, `./providers/types`, `./provider-runtime`) alongside the package root, so consumers import the public surface by name instead of reaching into raw `src/*` internal paths.

  Note: with an `exports` map now in place, undeclared deep paths such as `@andypai/agent-kanban/src/types` no longer resolve — import the declared subpaths instead.

## 0.6.5

### Patch Changes

- [#70](https://github.com/abpai/agent-kanban/pull/70) [`d41e1b2`](https://github.com/abpai/agent-kanban/commit/d41e1b225cc5d4985f932a0e1de75cf8a8396ab1) Thanks [@abpai](https://github.com/abpai)! - Harden provider state resolution and cache robustness:
  - **Linear & Jira state/column names** — resolve separator-collapsed names
    consistently (e.g. `In Progress` vs `in-progress`), and surface Jira issue
    statuses that map to no column instead of dropping them silently.
  - **Postgres cache** — batched cache upserts now tolerate duplicate issue ids
    in a single batch.
  - Internal refactors hardening the shared provider sync, cache-task-mapper, and
    local-provider cores (no behavior change).

## 0.6.4 - 2026-06-09

- Provider webhook open-dev-mode warnings now emit at most once per process via
  a shared `warnOnce` helper, preventing repeated unsigned webhook requests from
  flooding Jira/Linear dev logs while preserving the existing warning.

## 0.6.3 - 2026-06-09

- Linear `updateTask`/`moveTask` now hydrate only the mutated issue via a new
  `client.getIssue()` instead of forcing a whole-team `sync(true)` reconcile.
  The targeted re-fetch upserts the single row and ingests just that issue's
  history; it drops the local row and reports `TASK_NOT_FOUND` when the issue
  vanished upstream or moved out of the configured team. Sync metadata is left
  untouched so the next delta poll is unaffected.
- The Postgres local provider's `listTasks()` now pushes column/priority/
  assignee/project filters, a whitelisted `ORDER BY`, and `LIMIT` into SQL
  rather than loading the whole table and filtering in JS, and derives
  `comment_count` via a correlated subquery scoped to the returned rows. The
  `updated` sort now matches SQLite's ascending order for cross-backend parity.
- Extracted a shared `metrics-spec` (`classifyColumnRoles`/`assembleBoardMetrics`)
  so SQLite and Postgres feed raw aggregates through one assembler that owns
  every derived field. This removes hand-maintained drift — Postgres
  `tasksByPriority` now orders by severity like SQLite, and its in-progress
  count derives by column id so duplicate column names can no longer inflate it.
- Linear fixes: count comments beyond the inline first page, paginate the user
  and project catalogs, and reject unresolved assignee/project names instead of
  silently dropping them.
- Postgres fixes: record local activity at parity with SQLite, advertise
  `columnCrud`/`bulk`/`configEdit` as unsupported (and refuse config edits),
  migrate pre-existing `tasks` tables for project/revision columns, and bump the
  board revision on bulk moves.
- Transport hardening: validate `limit` inputs at the transport boundary and
  route malformed JSON bodies through the structured error envelope.
- UI fixes: support labels when creating a task, and normalize non-JSON and
  failed responses into `ApiError`.
- MCP: advertise the package version in MCP metadata and gate `getBoard` reads
  through the policy seam.
- Config: reject duplicate default column names.

## 0.6.2 - 2026-06-09

- Webhook authorization now accepts payloads when no signing secret is
  configured (open dev mode), instead of failing closed. When a secret is set,
  HMAC signature verification still runs unchanged. A `console.warn` is emitted
  per-request when the secret env var is absent so misconfigured production
  deployments are visible in logs.

## 0.6.1 - 2026-06-08

- Added optional bearer-token authentication and CORS controls for the HTTP API,
  and made provider webhook routes fail closed when their provider secret is not
  configured.
- Hardened Jira sync and board handling around unsafe delta cursors, WebSocket
  column ids, warm-cache reads, server shutdown, and per-server WebSocket client
  accounting.
- Fixed local and Postgres board correctness for custom columns: metrics now
  classify done/in-progress columns by role, SQLite honors `KANBAN_DEFAULT_COLUMNS`,
  Postgres column-time metrics stay accurate, and `kanban board init` works
  through the real CLI path on a fresh SQLite database.
- Made SQLite comment create/update operations atomic with their activity log
  entries, and aligned Linear activity truncation markers across SQLite and
  Postgres caches.
- Refactored the Jira/Linear cache repositories, shared provider cores,
  capability interfaces, CLI/HTTP/MCP use-case layer, and UI store slices while
  preserving the public provider/API surface.

## 0.6.0 - 2026-06-08

- Fixed Jira issue sync to follow the `/rest/api/3/search/jql` cursor. That
  endpoint omits `total` and paginates by an opaque `nextPageToken`, but the
  sync loop still terminated on the legacy `accumulated < total` condition, so
  once `total` came back `undefined` it stopped after the first page. On any
  project with more than 100 issues, every issue beyond the oldest 100 (by
  `updated ASC`) — including newly-created tickets — was silently never cached.
  The loop now follows `nextPageToken` until `isLast` (or until the server stops
  advancing the cursor — a repeated token is guarded against so a misbehaving
  server cannot spin the poll cycle forever, and a non-last empty page is no
  longer mistaken for the end). A scan aborted by a stalled cursor is treated as
  incomplete: the partial result is not recorded as a clean sync at all — it does
  not prune cached issues (which would delete issues that exist upstream on
  unfetched pages), and `lastSyncAt`/`lastIssueUpdatedAt`/the full-reconcile
  marker are all left unchanged, so the next sync is not throttled and retries
  promptly. The issues that were fetched stay cached (additive). If a
  non-standard server supplies the legacy `total` without a cursor, completeness
  honors `total`/`startAt` rather than page size so a full final page is not
  misread as "more pages remain". `JiraSearchPage`'s `startAt`/`maxResults`/`total`
  are now optional and `nextPageToken`/`isLast` are exposed.
- Jira create/update/move now perform read-after-write via `GET /issue/{key}`
  instead of `sync(true)` + cache read, in both the SQLite and Postgres
  providers. The direct issue endpoint has no search-index lag, so a just-created
  or just-transitioned issue is reflected immediately. The previous pattern raced
  the search index — creates reported "not yet visible", and a move's new status
  sometimes failed to land, causing the poll loop to re-issue the same move
  repeatedly. Hydration still ingests the issue changelog (best-effort), so a
  just-applied transition is recorded in `jira_activity` immediately rather than
  waiting for the next unthrottled sync.
- A forced sync (`sync(true)`) no longer triggers a full 1970-based reconcile in
  either provider. `force` still bypasses the poll throttle so a write sees its
  own result, but the expensive whole-project issue re-fetch (plus a per-issue
  changelog call) now runs only on the periodic full-reconcile schedule.
- The Postgres provider's column/catalog (users, priorities, issue types)
  refreshes are now race-safe. Each row is written with an idempotent UPSERT
  (`ON CONFLICT DO UPDATE`) on every sync, replacing the previous
  `DELETE`+`INSERT` that could trip `jira_priorities_pkey` (and peers) when
  multiple replicas refresh the shared cache concurrently; because the upsert is
  idempotent, a newly-created
  Jira status, column, priority, or assignable user is reflected on the next sync
  rather than only on a full reconcile. The obsolete-row delete (removing a row
  whose id is no longer upstream) now runs only on the periodic full reconcile,
  mirroring how upstream-missing issues are pruned: a delta sync's catalog
  snapshot can be stale, and a stale snapshot's delete would drop a row another
  replica just added with a fresher snapshot. Confining the delete to the full
  reconcile (additions still self-heal via the every-sync upsert) keeps catalog
  pruning consistent with issue pruning and off the common delta path.

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
