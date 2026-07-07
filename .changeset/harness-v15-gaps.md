---
'@andypai/agent-kanban': patch
---

Add autonomous-readiness tooling: a one-command `bootstrap` (root + UI install)
and `smoke` script, and a local Postgres parity harness (`pg:up` / `pg:down` /
`test:pg` + `docker-compose.postgres.yml` mirroring the CI Postgres service) so
the `postgres-*` provider suites can be proven locally, not just in CI. Also
removes the unused internal `KanbanStorageMode` type alias (not part of the
public export surface).
