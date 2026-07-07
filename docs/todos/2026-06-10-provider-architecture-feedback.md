# Agent-kanban provider architecture feedback triage

Date: 2026-06-10
Base reviewed: `main` at `0c2ab1c`

## Now plan

Address the low-risk provider dedupe and hardening claims first. These changes
are small, behavior-preserving, and independently reviewable:

1. Extract Jira API issue -> cache row mapping and use it from sync, hydrate,
   and webhook paths.
2. Extract the Postgres webhook audit wrapper shared by Jira and Linear.
3. Share validated provider team-info parsing across Jira and Linear cache
   backends; corrupt persisted Linear team metadata should degrade to `null`.
4. Add a Linear `issueIdFor` helper so write/comment paths never send prefixed
   task ids upstream when `providerId` is missing.

Each subsequent item below should be handled as a separate stacked PR after the
prior branch lands or is used as the base.

## Claim triage

1. Local provider domain logic exists twice across SQLite and Postgres.
   Status: confirmed. `src/providers/postgres-local.ts` is 770 lines beside
   `src/db.ts` at 747 lines and `src/providers/local.ts` at 187 lines. The
   lockstep comment and observed comment ordering drift are present.
   Action: addressed in the sixth stacked PR. SQLite and Postgres local
   providers now sit behind `LocalProviderCore` and a `LocalStorePort`, sharing
   provider-facing enrichment, bootstrap/context assembly, comment-count
   projection, and optimistic-version checks. Storage-specific SQL remains in
   the store implementations rather than introducing a dialect adapter in this
   PR.

2. SQLite/Postgres Jira and Linear cache pairs duplicate mapper and SQL logic.
   Status: confirmed. Jira cache files are 686 and 587 lines; Linear cache files
   are 566 and 500 lines. `taskFromRow`, `parseLabels`, priority mapping, and
   metadata loops are duplicated.
   Action: partial now. The shared task-row mappers are extracted in the second
   stacked PR. The fifth stacked PR batches and transaction-wraps the Postgres
   catalog and issue write loops. SQL duplication and any broader dialect adapter
   still need later design.

3. Jira re-derives issue-to-cache-row mapping three times.
   Status: confirmed. The mapping appears in Jira sync, hydrate, and webhook
   paths; Linear already has `toCacheIssue`.
   Action: now. Extract `toCacheIssue` in `jira-core.ts`.

4. Jira and Linear duplicate sync-throttle/background-warmer state and list
   filtering.
   Status: confirmed. Both cores keep `backgroundManaged`, `syncCache`,
   `setBackgroundManaged`, `getSyncStatus`, and similar filter/sort/limit
   chains.
   Action: addressed in the third stacked PR. Remote providers now share
   `SyncGate`, sync-status projection, timestamp helpers, and common
   priority/assignee/project/sort/limit filtering.

5. Postgres webhook audit wrappers are identical.
   Status: confirmed. Jira and Linear wrappers only differ by provider literal.
   Action: now. Add `recordedWebhook` in `src/webhook-events.ts`.

6. Postgres cache writes are row-at-a-time and inconsistently transactional.
   Status: confirmed. Catalog writes loop per row; Jira `upsertIssues` has
   transaction treatment but Linear issue upserts remain row-at-a-time with
   prior-description reads.
   Action: addressed in the fifth stacked PR. Postgres Jira/Linear cache writes
   now batch catalog/activity/issue rows, wrap multi-statement cache mutations in
   transactions, and use advisory locks for destructive catalog and issue refresh
   windows. CI-backed Postgres tests cover Jira catalog rollback and Linear
   description-activity rollback.

7. Jira sync fetches changelogs serially.
   Status: confirmed. Jira awaits `ingestIssueActivity` in a per-issue loop
   while Linear batches history calls with concurrency 5.
   Action: addressed in the third stacked PR. Jira changelog ingest now uses the
   shared bounded-concurrency helper with the same best-effort failure behavior.

8. Storage x tracker construction and CLI capability gating are hand-rolled in
   multiple places.
   Status: confirmed. `provider-runtime.ts`, `providers/index.ts`, and
   `src/index.ts` all encode pieces of the matrix; CLI gates on `sqliteDb`
   despite capability flags.
   Action: addressed in the fourth stacked PR. SQLite/Postgres provider
   construction now goes through one factory module, runtime carries the
   provider capabilities selected by that factory, and CLI column/bulk/config
   gates use those capabilities instead of only checking the storage handle.

9. `use-cases.ts` is mostly pass-through wrappers.
   Status: confirmed by file shape; one label normalization path overlaps
   provider normalization.
   Action: addressed in the fourth stacked PR. Transports now call providers
   directly, while `use-cases.ts` is reduced to the remaining shared
   create-task label normalization seam.

10. CLI parsing uses `strict: false` and unchecked casts.
    Status: confirmed. `src/index.ts` has multiple `strict: false` parser calls
    and many casts.
    Action: addressed in the fourth stacked PR. CLI, serve, and MCP parsing now
    use strict option parsing and convert parser failures to `INVALID_ARGUMENT`.

11. API response envelopes are repeated per route.
    Status: confirmed. `src/api.ts` is 372 lines with repeated `wrapHandler`
    response shapes.
    Action: addressed in the fourth stacked PR. API routes now share read and
    mutation result helpers for `{ ok, data }` envelopes, mutation flags, and
    optional websocket event projection.

12. Linear repeats `task.providerId || task.id`.
    Status: confirmed before this triage; write/comment paths repeated this
    fallback.
    Action: now. Add `issueIdFor(task)`.

13. Linear team-info parsing is unchecked.
    Status: confirmed. SQLite and Postgres Linear caches cast
    `JSON.parse(teamRaw)` to `ProviderTeamInfo`; Jira validates.
    Action: now. Share `parseProviderTeamInfo`.

14. Some SQLite Jira cache SQL lives in the adapter.
    Status: confirmed. Several lookup queries remain inline in
    `src/providers/jira.ts`.
    Action: extracted to its own active spec —
    [`2026-07-06-jira-cache-lookup-sql.md`](./2026-07-06-jira-cache-lookup-sql.md).
    This is the only item from this triage not yet shipped.

15. `TaskDetail` repeats editable select UI and UI defaults capabilities to
    true.
    Status: confirmed. `TaskDetail.tsx` has repeated select-edit blocks;
    `board-slice.ts` defaults capabilities on.
    Action: addressed in the seventh stacked PR. The UI store now defaults
    capabilities closed until bootstrap supplies provider capabilities, and
    `TaskDetail` uses one reusable editable-select component for priority,
    assignee, and project fields.

## Suggested stack after the Postgres cache atomicity PR

All planned items from this feedback pass have been stacked.
