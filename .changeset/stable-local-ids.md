---
'@andypai/agent-kanban': patch
---

Jira writes derive the `localId` of task lists, task items, tables and statuses from each node's place and content instead of generating random ids. The same markdown now always writes the same document, so re-saving a description that was read back unchanged keeps its `description_hash` instead of looking like an edit.
