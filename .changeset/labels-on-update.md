---
'@andypai/agent-kanban': minor
---

Add exact-replacement `labels?: string[]` on `UpdateTaskInput`. When present,
providers set the task's labels to exactly that array (including clearing with
`[]`); when absent, labels are left untouched.

- **Local (SQLite + Postgres)** — persist and activity-log label replacements.
- **Linear** — resolve names to ids and send `labelIds` (empty array clears).
- **Jira** — write `fields.labels` whenever `labels` is defined, including `[]`
  (create still skips empty labels; update must clear).
- New `ProviderCapabilities.labelReplacement` flag is `true` for all three
  providers so consumers can preflight before retiring intake labels.
