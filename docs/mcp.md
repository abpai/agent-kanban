# Reusable Tracker MCP

`agent-kanban` includes a reusable tracker MCP implementation under `src/mcp/`.
It is designed for sibling workspaces and in-repo consumers that want to host a
tracker-backed MCP server without reimplementing the policy and transport
layers.

## What is shipped

The shipped MCP layer has two pieces:

- `createTrackerCore(...)`: provider-backed handlers plus host-owned policy and
  observability hooks
- `createTrackerMcpServer(...)`: a Streamable HTTP MCP server that wraps the
  core with host-owned auth

The current default tool set is:

- `getTicket`
- `listComments`
- `getBoard`
- `postComment`
- `updateComment`
- `moveTicket`

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
  the dashboard, `/api/*`, `/api/health`, and `/ws`, but not `/mcp`.
- The CLI does not currently expose MCP commands.
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
