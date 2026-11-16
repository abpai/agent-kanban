---
'@andypai/agent-kanban': major
---

Jira descriptions and comments now convert faithfully between ADF and markdown.

- Reads never drop content. Nested lists at any depth, headings, quotes, tables, code blocks with a language, task lists, expands, all common text marks, smart links, mentions, emoji, status lozenges and dates render as markdown. Anything else renders as a visible `[unsupported Jira content: ...]` marker plus a warning.
- Writes refuse markdown Jira cannot represent (images, raw HTML, aligned table columns, leftover markers) with `INVALID_ARGUMENT` before any request is sent.
- Writes are confirmed by a structural comparison of normalized ADF. A mismatch is `PROVIDER_UPSTREAM_ERROR` with the differing paths.
- New subpath `@andypai/agent-kanban/jira-adf` exports `adfToMarkdown`, `markdownToAdf`, `normalizeAdf`, `compareAdf`, `describeAdfDifferences` and `JIRA_ADF_CONVERTER_VERSION`.

Breaking: `taskDescriptionText` is removed from `@andypai/agent-kanban/provider-runtime`. The Jira provider now confirms its own writes structurally; use `markdownToAdf` and `compareAdf` from `@andypai/agent-kanban/jira-adf` for any check of your own. Cached Jira descriptions and comment bodies are markdown, so their text changes (for example `**Repo**: <https://...>` and `## Heading`).
