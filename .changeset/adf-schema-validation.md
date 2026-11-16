---
'@andypai/agent-kanban': minor
---

Jira writes now follow Atlassian's published ADF schema, which the test suite checks every converted document against.

- Task lists inside list items and status lozenges with a `#rrggbb` color are written instead of refused; the schema allows both.
- A list item whose first child is a numbered list starting above 1, after a paragraph, now round-trips. Its markdown changes, so `JIRA_ADF_CONVERTER_VERSION` is now `agent-kanban/adf-markdown@3`.
