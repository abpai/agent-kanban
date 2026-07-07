---
'@andypai/agent-kanban': patch
---

Add autonomous-readiness tooling: a one-command `bootstrap` (root + UI install)
and `smoke` script, and a local Postgres parity harness (`pg:up` / `pg:down` /
`test:pg` + `docker-compose.postgres.yml` mirroring the CI Postgres service) so
the `postgres-*` provider suites can be proven locally, not just in CI.

Also adds a `knip` config + CI gate and trims the internal export surface:
`KanbanStorageMode` and ~40 other symbols that were exported but never imported
across modules are now module-private (or removed where fully dead). None were
part of the public `exports`-map surface (`.`, `./types`, `./providers/types`,
`./provider-runtime`), so consumers are unaffected.
