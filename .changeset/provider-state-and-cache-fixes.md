---
"@andypai/agent-kanban": patch
---

Harden provider state resolution and cache robustness:

- **Linear & Jira state/column names** — resolve separator-collapsed names
  consistently (e.g. `In Progress` vs `in-progress`), and surface Jira issue
  statuses that map to no column instead of dropping them silently.
- **Postgres cache** — batched cache upserts now tolerate duplicate issue ids
  in a single batch.
- Internal refactors hardening the shared provider sync, cache-task-mapper, and
  local-provider cores (no behavior change).
