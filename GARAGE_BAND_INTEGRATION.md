# GARAGE_BAND_INTEGRATION.md

## Purpose

Integrate the reusable tracker MCP core from `agent-kanban` into `garage-band`.

The ownership split is:

- `agent-kanban` owns:
  - tracker provider comment support
  - the reusable tracker MCP core
- `garage-band` owns:
  - hosting that core inside dispatch
  - token validation and scope resolution
  - `agentKind` authorization rules
  - typed-prefix ownership rules
  - audit hooks
  - readiness and shutdown behavior
  - sandbox env wiring

## Scope

- `garage-band` should not build a bespoke tracker MCP server from scratch.
- `garage-band` should import and host the reusable MCP core exported by `agent-kanban`.
- `garage-band` policy remains daemon-specific and must not be pushed back into `agent-kanban`.

## Upstream Dependency

This integration assumes access to the current source-level exports in
`agent-kanban`:

- `TaskComment` from `src/types.ts`
- provider support for:
  - `comment(idOrRef, body): Promise<TaskComment>`
  - `listComments(idOrRef): Promise<TaskComment[]>`
  - `getComment(idOrRef, commentId): Promise<TaskComment>`
  - `updateComment(idOrRef, commentId, body): Promise<TaskComment>`
- a two-layer MCP primitive:
  - `createTrackerCore({ provider, policy, hooks })` from `src/mcp/index.ts` — library layer with `core.handlers.*` functions
  - `createTrackerMcpServer({ core, auth, tools })` from `src/mcp/index.ts` — transport layer returning the shape below
- `TrackerMcpError` plus `TrackerMcpErrorCode` with the closed error-code set:
  - `auth_failed`
  - `policy_denied`
  - `ticket_not_found`
  - `comment_not_found`
  - `validation_failed`
  - `provider_unavailable`
  - `internal_error`

Expected transport return shape:

```ts
{
  fetch(req: Request): Promise<Response>
  selfPing(): Promise<void>
  close(signal?: AbortSignal): Promise<void>
}
```

These are intentionally source-level imports for now. `agent-kanban` does not
yet document stable package-root exports for the MCP layer, so `garage-band`
should treat these import paths as workspace-coupled until a public entrypoint
exists.

## Required Changes

### 1. Keep `@garage/tracker` narrow

Do not do a broad `@garage/tracker` rewrite just to host the MCP core.

- Keep the existing `Tracker` interface for the dispatch poll loop unless another garage-band change needs more.
- For MCP hosting, use the concrete `KanbanProvider` instance returned by:

```ts
import { createProvider } from '@andypai/agent-kanban/src/providers/index.ts'
```

- If needed for tests, add a small dispatch-local adapter type for the MCP host path instead of forcing the whole repo onto richer tracker types.

Separate garage-band follow-up:

- If garage-band's scheduler needs more read surface, sync `@garage/tracker`
  forward in a separate read-only slice with:
  - `TaskComment`
  - `listTasks(...)`
  - `listComments(idOrRef)`
- Do not use the MCP-host integration as the reason to add write-oriented
  comment APIs like `updateComment(...)` or `getBoard()` to `@garage/tracker`.

### 2. Host the reusable MCP core inside dispatch

Add a thin integration layer under `apps/dispatch` that:

- creates the existing tracker provider from `trackerDb`
- creates the reusable MCP core from `agent-kanban`
- mounts it on the existing Bun HTTP server
- delegates auth, policy, and hooks to garage-band-owned callbacks

Suggested route:

- `/mcp/tracker`

Do not:

- implement a second tracker MCP protocol stack locally
- fork the tool logic from `agent-kanban`
- move garage-band auth/policy into `agent-kanban`

### 3. Garage-band-specific auth resolver

`garage-band` should supply the auth layer to the reusable core.

Mint a short-lived opaque token before each agent invocation.

Recommended shape:

```ts
{
  token: string
  ticketId: string
  agentKind: 'triager' | 'planner' | 'coder' | 'evaluator' | 'merger'
  expiresAt: string
}
```

Where:

- `token` is opaque random bytes (for example 32 bytes base64-encoded)
- the authority lives in a garage-band-owned lookup row, not in signed claims
- revocation is done by deleting the row

The garage-band-owned lookup row should minimally resolve to:

```ts
{
  ticketId: string
  agentKind: 'triager' | 'planner' | 'coder' | 'evaluator' | 'merger'
  expiresAt: string
}
```

If garage-band wants extra host-local metadata for audit (for example
`sessionId` or `cycle`), it may keep that in the same lookup record, but
those fields are not required for the core auth contract and should not be
treated as token claims.

Pass into sandbox or agent env:

- `GARAGE_TRACKER_MCP_URL`
- `GARAGE_TRACKER_MCP_TOKEN`

The garage-band auth resolver should:

- read the bearer token from the request `headers` (the resolver receives `{ request, url, headers }` and must not read `request.body`)
- resolve the opaque token via garage-band-owned storage and validate expiry
- on success, resolve a garage-band scope object:

```ts
{
  ticketId: string
  agentKind: 'triager' | 'planner' | 'coder' | 'evaluator' | 'merger'
  expiresAt: string
}
```

- on missing, malformed, or expired tokens, throw `new TrackerMcpError({ code: "auth_failed", publicMessage: "unauthenticated" })` or equivalent. The core maps this to HTTP 401 before any SSE stream opens.

The reusable core should treat the scope object as opaque.

### 4. Garage-band-specific policy adapter

Garage-band should supply policy callbacks to the reusable core instead of embedding policy into the core.

Required garage-band policy decisions:

- all scopes may use:
  - `getTicket`
  - `listComments`
  - `getBoard`
  - `postComment`
  - `updateComment`
- `moveTicket` destinations:
  - `triager`: `inProgressColumn`
  - `planner`: none
  - `coder`: `humanReviewColumn`
  - `evaluator`: `humanReviewColumn`
  - `merger`: `doneColumn`

Column names come from `DispatchConfig` at daemon boot and remain fixed for the daemon lifetime.

Notes:

- the target-state config also includes `mergingColumn`, but no agent writes
  to it through tracker-mcp; humans move tickets into `Merging`
- the old `rejectColumn` / dedicated `Blocked` lane is retired in the
  target-state workflow

Prefix ownership also lives here.

Required prefix map:

- `triager` -> `garage-triage:`
- `planner` -> `garage-plan:`
- `coder` -> `garage-execute:`
- `evaluator` -> `garage-eval:`
- `merger` -> `garage-merge:`

Dispatch housekeeping remains outside the agent-scoped MCP surface and uses
untyped `garage: ` comments directly.

Rules:

- `postComment` rejects a body without the caller's required prefix
- `updateComment` rejects unless the existing target comment body starts with
  one of the caller's allowed prefixes, and the replacement body preserves an
  allowed prefix
- `listComments` is not filtered down to the caller's own prefix. Agents may
  read all comments on the ticket so planner/evaluator/retry flows can see
  prior typed batons and human feedback. If the ticket-scoped wrapper tool in
  §5 accepts an explicit `prefix` argument, that is only a caller-side
  narrowing helper layered on top of full ticket visibility.
- all tracker writes still use the daemon's tracker credentials; the prefix is only the role marker

Denial convention: every policy deny path throws `new TrackerMcpError({ code: "policy_denied", publicMessage: "<reason>" })` or equivalent, where `publicMessage` identifies the specific reason (for example `"prefix_mismatch"`, `"forbidden_tool"`, `"forbidden_column"`, `"not_owner"`, `"ticket_scope_violation"`). Those reason strings become the audit `outcome` values in §6.

### 5. Ticket-scoped garage-band tool surface

The reusable core is ticket-agnostic internally, but garage-band should expose
a ticket-scoped tool UX to agents by passing a custom `tools` array into
`createTrackerMcpServer(...)`. This is the recommended v1 surface: agents
never pass `ticketId`; the host injects it from validated scope.

Garage-band builds a concrete tool array around `core.handlers.*` and passes it into `createTrackerMcpServer({ core, auth, tools })`:

```ts
const tools: TrackerMcpTool<GarageBandScope>[] = [
  {
    name: 'getTicket',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: ({ scope }) => core.handlers.getTicket({ scope, ticketId: scope.ticketId }),
  },
  {
    name: 'listComments',
    inputSchema: {
      type: 'object',
      properties: { prefix: { type: 'string' } },
      required: [],
    },
    handler: async ({ scope, args }) => {
      const comments = await core.handlers.listComments({
        scope,
        ticketId: scope.ticketId,
      })
      return args.prefix ? comments.filter((c) => c.body.startsWith(args.prefix)) : comments
    },
  },
  {
    name: 'getBoard',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: ({ scope }) => core.handlers.getBoard({ scope }),
  },
  {
    name: 'postComment',
    inputSchema: {
      type: 'object',
      properties: { body: { type: 'string' } },
      required: ['body'],
    },
    handler: ({ scope, args }) =>
      core.handlers.postComment({
        scope,
        ticketId: scope.ticketId,
        body: args.body,
      }),
  },
  {
    name: 'updateComment',
    inputSchema: {
      type: 'object',
      properties: {
        commentId: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['commentId', 'body'],
    },
    handler: ({ scope, args }) =>
      core.handlers.updateComment({
        scope,
        ticketId: scope.ticketId,
        commentId: args.commentId,
        body: args.body,
      }),
  },
  {
    name: 'moveTicket',
    inputSchema: {
      type: 'object',
      properties: { column: { type: 'string' } },
      required: ['column'],
    },
    handler: ({ scope, args }) =>
      core.handlers.moveTicket({
        scope,
        ticketId: scope.ticketId,
        column: args.column,
      }),
  },
]
```

Implementation rules:

- `ticketId` is always injected from the validated token scope — agents never pass it
- policy enforcement (prefix ownership, `agentKind` tool permissions, move whitelist) happens inside `core.handlers.*` via the policy callbacks garage-band registers on the core
- handlers must delegate through `core.handlers.*` and never call the provider directly

This keeps the agent-facing surface narrow while preserving the reusable core's ability to support broader scopes in other hosts.

### 6. Audit via host hooks

Garage-band should map reusable-core hook callbacks into `SqliteEventLog`. Wire all four hooks explicitly:

- `onAuthFailure` → append an audit row with `outcome: "unauthenticated"` (no `scope`, no `tool`)
- `onToolStart` → optional, for trace start markers; most hosts skip this and log on result/error only
- `onToolResult` → append with `outcome: "ok"`, pulling `agentKind` from
  `scope`, `latencyMs` from `durationMs`, and `commentId`/`movedTo` from
  `result`. If garage-band carries host-local metadata like `cycle`, it may
  attach it here, but the reusable core should not require it.
- `onToolError` → append with `outcome` derived from `publicMessage` on `policy_denied` errors (`prefix_mismatch`, `forbidden_tool`, etc.), or `outcome: "upstream_error"` on `provider_unavailable`

Append every MCP tool call as:

```ts
{
  type: 'tracker.mcp.call'
  tool: string
  agentKind: string
  ticketId: string
  cycle?: string
  outcome: string
  latencyMs: number
  commentId?: string
  movedTo?: string
}
```

Suggested outcomes:

- `ok`
- `unauthenticated`
- `forbidden_tool`
- `prefix_mismatch`
- `not_owner`
- `forbidden_column`
- `ticket_scope_violation`
- `upstream_error`

This should be implemented via the reusable core's `hooks`, not by modifying the core to know about `SqliteEventLog`.

### 7. Readiness and lifecycle

Garage-band owns lifecycle around the hosted core.

Rules:

- start the MCP host alongside the dispatch daemon
- share the same provider instance created from `createProvider(trackerDb)`
- `/healthz` turns green only after both `trackerMcp.selfPing()` (in-process readiness) and a garage-band-owned upstream provider probe succeed. `selfPing()` is explicitly in-process only per the core contract — it does not hit the tracker — so garage-band must add its own upstream probe.
- on shutdown, call `trackerMcp.close(abortController.signal)`, which itself stops accepting new requests and drains in-flight requests and active SSE streams. Enforce the 5 second budget with that `AbortController`; do not add a separate drain loop before calling `close(...)`.

### 8. Transport

The hosted tracker MCP endpoint should use HTTP+SSE only for v1.

Rules:

- local docker mode uses the same HTTP endpoint as remote sandboxes
- do not add a stdio fallback
- do not try to route this through `packages/tools-mcp`, which is stdio-only today

This integration is a hosted remote MCP endpoint, not a `McpClientManager` child process.

## Tests

Required garage-band test coverage:

- token validation
- token expiry
- ticket scope injection from token into the hosted tool surface
- tool authorization by `agentKind`
- prefix ownership checks
- move whitelist checks
- audit hook emission to `SqliteEventLog`
- `/healthz` readiness gated on `selfPing()`
- one end-to-end happy path using a stub or local `KanbanProvider`

Recommended additional test:

- prove the garage-band host layer can be swapped to a different policy adapter without changing the reusable MCP core wiring

## Non-Goals

- no bespoke tracker MCP implementation in `garage-band`
- no garage-band-specific auth or prefix rules added to `agent-kanban`
- no stdio transport for v1
- no cross-ticket agent access in garage-band, even though the reusable core may support it for other hosts
