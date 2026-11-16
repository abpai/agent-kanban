---
'@andypai/agent-kanban': major
---

Jira descriptions and comments now convert faithfully between ADF and markdown.

- Reads never drop content. Nested lists at any depth, headings, quotes, tables, code blocks with a language, task lists, expands, all common text marks, smart links, mentions, emoji, status lozenges and dates render as markdown. Anything else renders as a visible `[unsupported Jira content: ...]` marker plus a warning.
- Writes refuse markdown Jira cannot represent (images, raw HTML, aligned table columns, shapes the ADF schema rejects, leftover markers) with `INVALID_ARGUMENT` before any request is sent.
- Writes are confirmed by a structural comparison of normalized ADF. A mismatch is the new `WRITE_UNCONFIRMED` error code (HTTP 409): the write landed, so do not retry it as new.
- New subpath `@andypai/agent-kanban/jira-adf` exports `adfToMarkdown`, `markdownToAdf`, `normalizeAdf`, `compareAdf`, `describeAdfDifferences`, `adfContentHash` and `JIRA_ADF_CONVERTER_VERSION`.
- Jira tasks carry `description_hash`, a hash of the raw ADF description that does not change with the converter.
- `getTask(id, { fresh: true })` reads one issue straight from the provider, skipping the warmer and sync, writes it into the cache, and throws instead of falling back to the cache. On Jira it also returns `fresh_read` with the converter version, warnings, `lossless`, and attachment digests.

Breaking: `taskDescriptionText` is removed from `@andypai/agent-kanban/provider-runtime`. The Jira provider now confirms its own writes structurally; use `markdownToAdf` and `compareAdf` from `@andypai/agent-kanban/jira-adf` for any check of your own. Cached Jira descriptions and comment bodies are markdown, so their text changes (for example `**Repo**: <https://...>` and `## Heading`).
