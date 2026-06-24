---
'@andypai/agent-kanban': patch
---

Close a webhook-secret fail-open and tighten config parsing (#77). `assertTunnelSecurity` now resolves each provider's webhook signing-secret env through a single `WEBHOOK_SECRET_ENV` source of truth, so a future webhook-capable provider can no longer start a public tunnel with no signing secret enforced. `KANBAN_SYNC_INTERVAL_MS` env parsing is also tightened to digits-only + safe-integer (rejecting hex/scientific notation), matching the strict `--sync-interval-ms` flag.
