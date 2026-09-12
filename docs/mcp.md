# Reusable Tracker MCP

`agent-kanban` includes a reusable tracker MCP implementation under `src/mcp/`.
There are really two shipped entry points now:

- `kanban mcp`, which runs a local stdio MCP server
- the reusable helpers under `src/mcp/`, for sibling workspaces or in-repo
  consumers that want to host their own tracker-backed MCP server without
  reimplementing the policy and transport layers — see
  [`mcp-host-integration.md`](./mcp-host-integration.md) for the full embedding
  recipe

## What is shipped

The shipped MCP layer has three pieces:

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

## Protocol revisions

Both entry points support MCP **2026-07-28** through the stable TypeScript SDK
2.0.0. HTTP uses the SDK's `createMcpHandler`; stdio uses `serveStdio`. These
serving entries explicitly enable the 2026 protocol and also accept 2025-era
clients from the same tool definitions.

Modern HTTP requests carry their protocol revision and client metadata on each
request. They can discover and call tools without an `initialize` handshake,
and the server does not issue an `Mcp-Session-Id`. Authentication still runs on
every HTTP request, including discovery. Only the host's auth resolver supplies
the policy scope; client metadata never grants access.

Older HTTP clients can continue using the 2025 handshake and tools through the
SDK's stateless compatibility path. HTTP session operations (`GET`/`DELETE`
with a session id) are no longer supported. Stdio selects a protocol era when
the connection opens and retains it for that connection.

SDK v2 clients must explicitly opt into modern negotiation. For a known
2026-capable server:

```ts
import { Client } from '@modelcontextprotocol/client'

const client = new Client(
  { name: 'tracker-client', version: '1.0.0' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
)
```

Use `mode: 'auto'` when a client needs to discover support and fall back to the
2025 protocol. Leaving `versionNegotiation` unset retains the legacy handshake.
See the SDK's [protocol versions guide](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions)
and [2026 migration guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28).

### Major-version migration

- Policy denials now use JSON-RPC code **`-32012`**, replacing `-32002`, which
  SDK v2 reserves for its legacy resource-not-found handling. The stable
  `error.data.trackerMcpCode` remains `policy_denied`; policy hooks and public
  denial messages are unchanged.
- Hosts should remove assumptions about HTTP session ids. The six tool names,
  arguments, and `structuredContent.result` envelope are unchanged.
- `kanban mcp` keeps its provider open until the stdio connection closes and
  accepted tool calls finish. This also fixes the earlier premature database
  close after startup.

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
