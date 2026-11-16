---
'@andypai/agent-kanban': minor
---

Jira writes keep HTML as literal text instead of refusing it. Markdown such as `current_count=<integer>`, `<Suspense>` or an HTML block is stored as the characters typed and reads back escaped (`\<integer>`), which writes back unchanged. `<u>`, `<sub>`, `<sup>` and color spans are still formatting.
