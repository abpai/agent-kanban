---
'@andypai/agent-kanban': patch
---

Bound Jira and Linear requests to 30 seconds, including response bodies, and abort stalled requests without retrying mutations. Give the Postgres runtime a 60-second statement timeout while preserving explicit connection URL settings.
