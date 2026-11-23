---
'@andypai/agent-kanban': patch
---

Jira sync no longer blocks the host process while it renders descriptions. A full reconcile reuses the Markdown it already rendered for a description whose raw ADF has not changed, and it yields to the event loop every 20 ms of rendering.
