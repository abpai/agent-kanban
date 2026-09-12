---
'@andypai/agent-kanban': major
---

Require Bun 1.4.2 or newer and align CI, container images, and TypeScript runtime
definitions. Upgrade MCP to protocol revision 2026-07-28 using the stable v2 SDK,
with stateless Streamable HTTP and compatibility for 2025-era clients.
Embedding hosts must remove assumptions about HTTP session IDs and session
GET/DELETE operations. Custom tool output schemas now describe the existing
`structuredContent.result` envelope so SDK clients can validate responses.
Policy denials now use JSON-RPC code -32012 because the previous -32002 code is
reserved by the new protocol; `data.trackerMcpCode` remains `policy_denied`.

Keep the stdio MCP database open until the client disconnects and accepted tool
calls finish, fixing the premature database close after connection setup.

Simplify the dashboard with a compact searchable toolbar, a shared responsive
board layout, and accessible task dialogs. Reduce unnecessary rendering and
remove external font requests while preserving live updates and provider-aware
task actions.

Use Bun's native WebSocket pub/sub for dashboard updates, preserving server
isolation and suppressing broadcasts after shutdown.
