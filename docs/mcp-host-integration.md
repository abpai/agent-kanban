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
  tokens. The server returns HTTP 401 before discovery or tool dispatch.
- Revoke by deleting the storage row.
- Authentication runs on every request. The protocol's `clientInfo` and
  `clientCapabilities` fields describe the caller and never supply its scope.

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
    handler: ({ scope, args }) => {
      if (typeof args.body !== 'string') {
        throw new TrackerMcpError({
          code: 'validation_failed',
          publicMessage: 'body must be a string',
        })
      }
      return core.handlers.postComment({ scope, ticketId: scope.ticketId, body: args.body })
    },
  },
  // getBoard, listComments, updateComment, moveTicket follow the same shape
]
```

Pass `tools: 'default'` instead if you want the full unscoped tool set. Policy runs
inside `core.handlers.*`, so custom tools stay thin wrappers.

An optional `outputSchema` validates the handler's raw return value. Tool
discovery advertises that schema inside an object with a required `result`
property, matching the shipped `structuredContent.result` envelope in both
protocol eras. This also supports raw string and array result schemas.

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
- `close(signal?)` stops accepting new requests, cancels modern response streams,
  and waits for accepted authentication and tool work in both protocol eras.
  A modern client can receive a connection-closed error while its accepted tool
  finishes; shutdown does not guarantee delivery of that tool's response.
  An authentication operation that completes during shutdown cannot start a
  tool call. Enforce a shutdown budget with an `AbortController` signal.
- Close the host-owned provider after `close()` completes so accepted calls can
  finish using it. The MCP wrapper does not own or close that provider.
- Share one provider instance between the MCP host and any other consumer
  (e.g. a poll loop) in the same process.

## 6. Transport

The hosted endpoint serves MCP 2026-07-28 with the SDK v2 web-standard
`createMcpHandler` entry. It accepts Bun `Request` objects and returns `Response`
objects, using JSON or SSE as the protocol requires. Mount `server.fetch` in a
host's `Bun.serve` handler and apply the host's Origin/Host policy before it.

Modern clients send protocol metadata on each request and do not initialize a
session. The SDK's stateless 2025 compatibility path accepts older clients'
handshake and tool requests on the same endpoint. It does not issue session ids
or support the old HTTP session `GET`/`DELETE` operations. The bundled
`kanban mcp` command separately serves modern and legacy stdio clients.

See [protocol revisions and client opt-in](./mcp.md#protocol-revisions) when
migrating a host or SDK client. The underlying SDK constructors alone retain
legacy behavior; the shipped serving entries enable modern support.

## Error codes

`TrackerMcpErrorCode` is a closed set: `auth_failed`, `policy_denied`,
`ticket_not_found`, `comment_not_found`, `validation_failed`,
`provider_unavailable`, `internal_error`.

| Tracker code                            | JSON-RPC code       |
| --------------------------------------- | ------------------- |
| `auth_failed`                           | `-32001` (HTTP 401) |
| `policy_denied`                         | `-32012`            |
| `ticket_not_found`, `comment_not_found` | `-32003`            |
| `validation_failed`                     | `-32602`            |
| `provider_unavailable`                  | `-32010`            |
| `internal_error`                        | `-32603`            |

Policy denial moved from `-32002` to `-32012` in the SDK v2 migration because
the SDK reserves the old code and rewrites it. Tool errors retain
`error.data.trackerMcpCode`, so hosts can branch on the tracker code instead of
the wire number. Protocol-level malformed requests and unsupported revisions
use the SDK's standard MCP errors.

## Host test checklist

- token validation and expiry
- ticket-scope injection from token into the tool surface
- tool authorization and move/column restrictions by scope
- comment policy (post/update) enforcement
- audit hook emission
- readiness gated on `selfPing()` **and** an upstream probe
- one end-to-end happy path against a stub or local `KanbanProvider`
- the policy adapter can be swapped without changing core wiring
