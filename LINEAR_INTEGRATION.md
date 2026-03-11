# Linear Integration Plan

## Summary

Keep the current REST/CLI surface and introduce a strict provider abstraction so we can run against either:

- Local SQLite backend (`local`)
- Linear backend (`linear`)

This avoids a large API rewrite and ships value faster.

## Architecture

### Provider-first design

Create a `KanbanProvider` interface and route all business operations through it.

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

## Phase 1: First Changes in This Repo

1. Add provider contract and shared DTOs:
   - `src/providers/types.ts`
   - `src/providers/errors.ts`
   - `src/providers/capabilities.ts`
2. Implement `LocalProvider` wrapper:
   - `src/providers/local.ts`
   - Reuse logic in `src/db.ts`, `src/activity.ts`, `src/metrics.ts`
3. Add provider factory and runtime selection:
   - `src/providers/index.ts`
   - Env vars:
     - `KANBAN_PROVIDER=local|linear` (default `local`)
     - `LINEAR_API_KEY` (required for `linear`)
     - `LINEAR_TEAM_ID` (required for create/move in linear mode)
4. Route server through provider:
   - Update `src/api.ts`, `src/server.ts`
   - Unsupported provider features return `UNSUPPORTED_OPERATION`
5. Route CLI through provider:
   - Update `src/index.ts` and `src/commands/*`
   - Keep current command names (`task`, `column`, etc.)

## Phase 2: Linear Adapter

1. Implement `LinearProvider`:
   - `src/providers/linear.ts`
   - `src/providers/linear-client.ts`
   - `src/providers/linear-mappers.ts`
2. v1 parity across both providers:
   - `task list/view/add/update/move`
   - `column list`
   - board view
3. Mark local-only for v1 (capabilities false in linear mode):
   - activity log
   - metrics
   - column CRUD
   - bulk commands
   - config-discovery extras

## Phase 3: UI and Agent Hardening

1. Capability-aware UI:
   - Update `ui/src/api.ts`, `ui/src/types.ts`, affected components
   - Hide/disable unsupported actions in linear mode
2. Stable identifiers:
   - Return both:
     - `id` (provider-native)
     - `externalRef` (e.g. `ABC-123` from Linear)

## API/Interface Changes

1. Keep endpoint paths, switch internals to provider-backed behavior.
2. Add capability surface (config endpoint extension or dedicated endpoint).
3. Add provider-aware error codes:
   - `UNSUPPORTED_OPERATION`
   - `PROVIDER_AUTH_FAILED`
   - `PROVIDER_RATE_LIMITED`

## Test Strategy

1. Provider contract suite:
   - Run shared tests against `LocalProvider` and `LinearProvider` (mocked by default)
2. Integration:
   - API tests in local mode for current behavior parity
   - API tests in linear mode for mapping and error translation
3. Optional live linear smoke tests:
   - Enabled only when `LINEAR_API_KEY` exists
4. Guardrails:
   - ESLint rule: no direct `db.ts` imports outside `LocalProvider`
   - CI matrix for provider-mode smoke tests

## Milestones

1. Milestone A: Provider contract + LocalProvider + server wiring
   - Checkpoint: existing API tests pass in local mode
2. Milestone B: CLI migrated to provider path
   - Checkpoint: CLI tests green with parity
3. Milestone C: Linear read support
   - Checkpoint: board/task list/view in linear mode
4. Milestone D: Linear write support
   - Checkpoint: add/update/move works; unsupported ops return capability errors
5. Milestone E: UI capability adaptation
   - Checkpoint: UI works cleanly in both modes

## Defaults

1. Single Linear team in v1
2. API key auth only in v1
3. No webhook sync in v1 (poll/manual refresh acceptable)
4. Endpoint stability preferred unless intentionally changed

## Questions to Ask at the End of Implementation

1. Should v2 include labels/comments across both providers?
2. In linear mode, should delete be archive-only or hard-delete if available?
3. Do we need webhook near-real-time sync, or keep polling/manual refresh?
4. Should the UI always show provider-agnostic issue identifier columns?
