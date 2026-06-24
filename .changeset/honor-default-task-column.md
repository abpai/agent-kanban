---
'@andypai/agent-kanban': patch
---

Honor the configured default task column when creating tasks through the local/SQLite CLI path (#78). `SqliteLocalStore.createTask` now applies `config.defaultTaskColumn` (falling back to the system default when unset), bringing it to parity with the Postgres store. Passing an explicit `--column` still overrides the default.
