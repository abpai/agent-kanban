---
'@andypai/agent-kanban': minor
---

Add a public `exports` map declaring stable subpaths (`./types`, `./providers/types`, `./provider-runtime`) alongside the package root, so consumers import the public surface by name instead of reaching into raw `src/*` internal paths.

Note: with an `exports` map now in place, undeclared deep paths such as `@andypai/agent-kanban/src/types` no longer resolve — import the declared subpaths instead.
