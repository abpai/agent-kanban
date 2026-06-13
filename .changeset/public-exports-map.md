---
'@andypai/agent-kanban': minor
---

Add a public `exports` map declaring stable subpaths (`./types`, `./providers/types`, `./provider-runtime`) alongside the package root. Consumers can now import the public surface without reaching into raw `src/*` internal paths, so an internal file move no longer silently breaks downstreams.

A `./src/*` deprecation bridge keeps every existing deep import resolving, so this is non-breaking; the bridge will be removed in a future major once consumers migrate to the declared subpaths.
