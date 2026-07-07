# Architecture

Agent Kanban is a Bun-first tracker with one public task/board contract across
local SQLite, Postgres-backed caches, Linear, and Jira. The CLI is the primary
automation surface; the dashboard and MCP layer sit on the same provider
contract.

## Runtime shape

| Area                          | Start here                                                                                                                                     | Role                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| CLI entrypoint                | `src/index.ts`                                                                                                                                 | Parses commands, selects provider runtime, and dispatches board/task/comment/serve/mcp flows.    |
| Command modules               | `src/commands/`                                                                                                                                | Implements board, column, bulk, and MCP command helpers.                                         |
| Provider runtime              | `src/provider-runtime.ts`, `src/providers/factory.ts`, `src/providers/index.ts`                                                                | Reads env/config and constructs the active provider plus storage mode.                           |
| Provider contracts            | `src/providers/types.ts`, `src/providers/capabilities.ts`                                                                                      | Defines normalized provider operations and public capability flags.                              |
| Local storage                 | `src/db.ts`, `src/providers/sqlite-local-store.ts`, `src/providers/local-core.ts`, `src/providers/local.ts`, `src/providers/postgres-local.ts` | Owns local board behavior, SQLite persistence, and Postgres storage parity.                      |
| Remote providers              | `src/providers/linear*.ts`, `src/providers/jira*.ts`, `src/providers/sync-core.ts`                                                             | Owns Linear/Jira API translation, caches, sync, and webhook ingestion.                           |
| HTTP API and dashboard server | `src/server.ts`, `src/api.ts`, `src/webhooks.ts`, `src/webhook-events.ts`, `src/tunnel.ts`                                                     | Serves `/api/*`, health/readiness routes, `/ws`, static dashboard assets, and webhook endpoints. |
| MCP layer                     | `src/mcp/`, `src/commands/mcp.ts`                                                                                                              | Provides the stdio MCP entrypoint and reusable Streamable HTTP helpers.                          |
| Dashboard UI                  | `ui/src/`                                                                                                                                      | React/Vite board UI, transport state, task detail flows, and provider capability-aware controls. |

## Data flow

1. `src/index.ts` parses CLI or server options and asks the provider runtime for
   the active provider.
2. The provider runtime selects local, Linear, or Jira behavior from
   `KANBAN_PROVIDER` and storage behavior from `KANBAN_STORAGE`.
3. Local mode reads and writes SQLite or Postgres directly through the local
   provider contract.
4. Remote provider modes call Linear/Jira APIs for writes and maintain a local
   cache for board reads, comments, sync status, and dashboard responsiveness.
5. `kanban serve` exposes the provider through the REST API and WebSocket
   notifications; webhook endpoints update remote-provider caches when their
   provider secret is configured.
6. `kanban mcp` exposes a smaller tracker toolset over stdio for MCP-aware
   agents; host-owned MCP servers can reuse `src/mcp/` with their own auth and
   policy.

## Boundaries

- Public terminology comes from `UBIQUITOUS_LANGUAGE.md`.
- Provider-specific quirks stay in `src/providers/`; public API, CLI output, and
  tests use normalized tasks, columns, comments, capabilities, cache, webhook,
  polling sync, and full reconcile terms.
- Dashboard code consumes API/provider capability data rather than guessing
  which provider features are available.
- Webhook writes verify provider signatures when the matching secret is set.
  Without the secret, Linear/Jira webhooks run in local open dev mode; the
  `--tunnel` guard refuses to expose that unsigned mode on a public URL.
- Release automation lives in `.github/workflows/release.yml` and uses
  Changesets plus npm trusted publishing; do not replace it with manual publish
  steps.
