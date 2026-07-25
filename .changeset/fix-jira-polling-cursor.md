---
'@andypai/agent-kanban': patch
---

Normalize Jira polling cursors to JQL minute precision so delta syncs continue
to see tasks after Jira returns an ISO timestamp.
