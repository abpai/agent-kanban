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
   Action: later. This is high-payoff but a large core refactor. Design
   `LocalStorePort` and `LocalProviderCore` with parity tests before rewriting.

2. SQLite/Postgres Jira and Linear cache pairs duplicate mapper and SQL logic.
   Status: confirmed. Jira cache files are 686 and 587 lines; Linear cache files
   are 566 and 500 lines. `taskFromRow`, `parseLabels`, priority mapping, and
   metadata loops are duplicated.
   Action: partial now. The shared task-row mappers are extracted in the second
   stacked PR. SQL duplication, catalog metadata loops, and any dialect adapter
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
   Action: later. This needs concurrency-aware tests and should be its own
   performance/atomicity PR.

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
   Action: later. Design a provider factory table and route CLI commands through
   capabilities rather than storage handles.

9. `use-cases.ts` is mostly pass-through wrappers.
   Status: confirmed by file shape; one label normalization path overlaps
   provider normalization.
   Action: later. Remove or justify the layer only after checking all transports
   and tests that import it.

10. CLI parsing uses `strict: false` and unchecked casts.
    Status: confirmed. `src/index.ts` has multiple `strict: false` parser calls
    and many casts.
    Action: later. This is user-facing CLI behavior; switch to strict parsing in
    a separate compatibility PR.

11. API response envelopes are repeated per route.
    Status: confirmed. `src/api.ts` is 372 lines with repeated `wrapHandler`
    response shapes.
    Action: later. Route-table refactor should be separate and backed by API
    tests.

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
    Action: later. Move lookup SQL into `jira-cache.ts` after the mapper
    extraction lands.

15. `TaskDetail` repeats editable select UI and UI defaults capabilities to
    true.
    Status: confirmed. `TaskDetail.tsx` has repeated select-edit blocks;
    `board-slice.ts` defaults capabilities on.
    Action: later. Treat as a UI PR with bootstrap-state testing.

## Suggested stack after the sync-core PR

1. Postgres cache atomicity: transaction and batch catalog refreshes, then Linear
   issue upserts.
2. Provider runtime and CLI capability matrix: table-driven construction plus
   capability-based CLI gating.
3. Local provider core refactor: introduce a storage port and migrate SQLite and
   Postgres local providers behind it.
4. UI capability defaults and `TaskDetail` editable field extraction.
