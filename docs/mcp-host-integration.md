# Hosting the reusable tracker MCP core

`agent-kanban` ships a reusable tracker MCP layer under `src/mcp/` so a sibling
tool or app can host its own tracker-backed MCP server without reimplementing
the policy and transport layers. This guide is the concrete embedding recipe;
[`mcp.md`](./mcp.md) is the overview of what the layer ships and when to use it.

Use this path (rather than the bundled `kanban mcp` stdio server) when the host
needs its own **auth**, **scope resolution**, **policy**, or **audit**. The
stdio server uses an allow-all local policy and is meant for trusted local use.

## The three pieces

```ts
import {
  createTrackerCore,
  createTrackerMcpServer,
  TrackerMcpError,
} from '@andypai/agent-kanban/src/mcp/index.ts'
import { createProvider } from '@andypai/agent-kanban/src/providers/index.ts'

const provider = createProvider(/* env / db */)
const core = createTrackerCore({ provider, policy, hooks })
const server = createTrackerMcpServer({ core, auth, tools })
```

- `provider` — any concrete `KanbanProvider` (local, Linear, or Jira). All three
  implement the comment contract the MCP layer relies on.
- `core` (`createTrackerCore`) — provider-backed handlers (`core.handlers.*`)
  plus the host-owned `policy` and observability `hooks`.
- `server` (`createTrackerMcpServer`) — a Streamable HTTP MCP server that wraps
  the core with the host-owned `auth` resolver and the host's `tools` array. It
  returns `{ fetch, selfPing, close }`.

The MCP helpers live under `src/mcp/` and are not yet published as stable
package-root exports, so treat these import paths as workspace-coupled until a
public entrypoint exists.

## 1. Auth resolver → your scope

The resolver turns an inbound request into a host-defined **scope** object the
core treats as opaque. Its contract (`TrackerMcpAuthResolver<TScope>`):

```ts
type TrackerMcpAuthResolver<TScope> = (ctx: {
  request: Request
  url: URL
  headers: Headers
}) => Promise<TScope>
```

Recommended pattern — a short-lived opaque bearer token resolved against
host-owned storage, not signed claims:

```ts
interface Scope {
  ticketId: string
  role: string // whatever role vocabulary the host enforces
  expiresAt: string
}

const auth: TrackerMcpAuthResolver<Scope> = async ({ headers }) => {
  const token = headers.get('authorization')?.replace(/^Bearer /, '')
  const row = token ? await lookupToken(token) : undefined // host storage
  if (!row || new Date(row.expiresAt) < new Date()) {
    throw new TrackerMcpError({ code: 'auth_failed', publicMessage: 'unauthenticated' })
  }
  return { ticketId: row.ticketId, role: row.role, expiresAt: row.expiresAt }
}
```

- Read only from `headers`/`url`; do not consume `request.body`.
- Throw `TrackerMcpError({ code: 'auth_failed' })` on missing/malformed/expired
  tokens. The core maps it to HTTP 401 before any SSE stream opens.
- Revoke by deleting the storage row.

## 2. Policy callbacks

Supply a `TrackerMcpPolicy<TScope>` instead of embedding rules in the core.
Deny by throwing `TrackerMcpError({ code: 'policy_denied', publicMessage })`,
where `publicMessage` is a stable reason string (e.g. `forbidden_column`,
`not_owner`) — those reasons are what your audit hooks record.

```ts
interface TrackerMcpPolicy<TScope> {
  canReadTicket(scope, ticketId): Promise<void> | void
  canPostComment(scope, ticketId, body): Promise<void> | void
  canUpdateComment(scope, ticketId, comment, body): Promise<void> | void
  canMoveTicket(scope, ticketId, destinationColumn): Promise<void> | void
  filterComment?(scope, comment): boolean | Promise<boolean> // drop comments from reads
  canReadBoard?(scope): Promise<void> | void // gate the whole board
  filterTask?(scope, task): boolean | Promise<boolean> // hide tickets from getBoard
}
```

Note `filterTask`: without it, `getBoard` exposes every ticket and bypasses
per-ticket `canReadTicket` gates.

## 3. Ticket-scoped tools

The core is ticket-agnostic, but a host usually wants agents to operate on
**one** ticket without ever passing a `ticketId`. Build a `tools` array that
injects `ticketId` from the validated scope and delegates to `core.handlers.*`
(never to the provider directly):

```ts
const tools: TrackerMcpTool<Scope>[] = [
  {
    name: 'getTicket',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: ({ scope }) => core.handlers.getTicket({ scope, ticketId: scope.ticketId }),
  },
  {
    name: 'postComment',
    inputSchema: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'] },
    handler: ({ scope, args }) =>
      core.handlers.postComment({ scope, ticketId: scope.ticketId, body: args.body }),
  },
  // getBoard, listComments, updateComment, moveTicket follow the same shape
]
```

Pass `defaultTools` instead if you want the full unscoped tool set. Policy runs
inside `core.handlers.*`, so custom tools stay thin wrappers.

## 4. Observability via hooks

Map the core's hooks (`TrackerMcpHooks<TScope>`) into the host's audit log —
don't teach the core about the host's storage:

- `onAuthFailure` — auth rejected (no `scope`, no `tool`); has `error`/`durationMs`.
- `onToolStart` — optional trace marker; most hosts skip it and log on result/error.
- `onToolResult` — success; `durationMs` plus a `result` record to pull ids from.
- `onToolError` — failure; `errorCode` + `error` (use `error.publicMessage` for
  the specific deny reason).

## 5. Lifecycle

- `selfPing()` is **in-process readiness only** — it does not hit the tracker.
  A host `/ready` check should also run its own upstream provider probe.
- `close(signal?)` stops accepting new requests and drains in-flight requests
  and active SSE streams. Enforce a shutdown budget by passing an
  `AbortController` signal; don't add a separate drain loop before calling it.
- Share one provider instance between the MCP host and any other consumer
  (e.g. a poll loop) in the same process.

## 6. Transport

The hosted endpoint is Streamable HTTP (with SSE) only — the same endpoint for
local and remote clients. Don't add a stdio fallback for the hosted path; stdio
is the separate `kanban mcp` server. This is a hosted remote MCP endpoint, not a
child process managed by an MCP client.

## Error codes

`TrackerMcpErrorCode` is a closed set: `auth_failed`, `policy_denied`,
`ticket_not_found`, `comment_not_found`, `validation_failed`,
`provider_unavailable`, `internal_error`.

## Host test checklist

- token validation and expiry
- ticket-scope injection from token into the tool surface
- tool authorization and move/column restrictions by scope
- comment policy (post/update) enforcement
- audit hook emission
- readiness gated on `selfPing()` **and** an upstream probe
- one end-to-end happy path against a stub or local `KanbanProvider`
- the policy adapter can be swapped without changing core wiring
