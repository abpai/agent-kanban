# Reusable Tracker MCP

`agent-kanban` includes a reusable tracker MCP implementation under `src/mcp/`.
There are really two shipped entry points now:

- `kanban mcp`, which runs a local stdio MCP server
- the reusable helpers under `src/mcp/`, for sibling workspaces or in-repo
  consumers that want to host their own tracker-backed MCP server without
  reimplementing the policy and transport layers

## What is shipped

The shipped MCP layer has two pieces:

- `createTrackerCore(...)`: provider-backed handlers plus host-owned policy and
  observability hooks
- `createTrackerMcpServer(...)`: a Streamable HTTP MCP server that wraps the
  core with host-owned auth
- `kanban mcp`: a bundled stdio server built on the same default tool set for
  trusted local use

The current default tool set is:

- `getTicket`
- `listComments`
- `getBoard`
- `postComment`
- `updateComment`
- `moveTicket`

## Quick start

Use the bundled stdio server when you want the fastest path for a local MCP
client:

```sh
kanban mcp
```

It accepts the same provider env vars as the CLI. If you want to point it at a
specific local database file, pass `--db <path>`.

## Comment behavior

The MCP layer depends on the provider comment contract now implemented across
local, Linear, and Jira:

- `listComments(idOrRef)`
- `getComment(idOrRef, commentId)`
- `comment(idOrRef, body)`
- `updateComment(idOrRef, commentId, body)`

`updateComment` reads the existing comment first so host policy can validate the
edit against the current body and authoring rules.

## Important caveats

- `kanban serve` does not mount this MCP server. The shipped app server exposes
  the dashboard, `/api/*`, `/api/health`, `/api/ready`, `/api/sync-status`,
  and `/ws`, but not `/mcp`.
- The CLI does expose MCP over stdio via `kanban mcp`.
- The bundled stdio server uses an allow-all local policy. If you need host
  auth, scope resolution, or stricter policy checks, use
  `createTrackerMcpServer(...)` in your own host instead.
- The MCP helpers live under `src/mcp/` and are not yet documented as stable
  package-root exports such as `@andypai/agent-kanban`.
- The public HTTP API exposes comment list/create/update routes, but not a
  public single-comment REST route and not comment delete.

## Good fit

Use the MCP layer when you want:

- host-owned auth and scope resolution
- host-owned policy for comment rules or move restrictions
- reusable tracker tools backed by the existing provider implementations

Keep using the CLI and dashboard when you want:

- local board management
- provider-backed task operations from the terminal
- the built-in web UI and REST server
