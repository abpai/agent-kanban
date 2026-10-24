---
'@andypai/agent-kanban': patch
---

Prevent delayed Jira polling or webhook snapshots from overwriting newer cached task state. Keep the newest version in duplicate batches, resolve conflicting equal-version snapshots through a direct issue read, and preserve legitimate newer column changes in SQLite and Postgres.
