---
'@andypai/agent-kanban': patch
---

Harden the `serve` HTTP API and webhook ingestion (#76). Webhook-route errors are now wrapped in the standard `{ ok: false, error }` envelope instead of leaking a raw, non-enveloped 500, alongside fixes across tunnel security, Postgres receipt handling, SSE broadcast, and base-path handling — 10 defects in total, with +66 regression tests.
