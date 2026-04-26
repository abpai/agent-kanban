# Changelog

## 0.3.2 - 2026-04-26

- Jira ADF round-trip now preserves inline marks. `plainTextToAdf`
  recognises `**bold**` and `[label](https://…)` (or `http://`) and emits
  ADF `strong` and `link` marks; `adfToPlainText` mirrors them back to
  markdown. Code-block content is left literal (the inline tokenizer is
  scoped to paragraphs and list items).
- Fixed dropped URLs in description / comment extraction. `adfToPlainText`
  now reads `inlineCard` and `blockCard` / `embedCard` smart-link nodes
  (emitting `attrs.url`) and `hardBreak` (emitting `\n`), so pasted URLs
  that Jira auto-converted to smart links no longer vanish on read.
  Split Jira field labels like bold `Repo` followed by plain `:` now render as
  `**Repo:**`, preserving a contiguous `Repo:` label for agent parsers.

## 0.3.1 - 2026-04-26

- Fixed Linear sync against the live GraphQL schema by removing the unsupported
  `comments.totalCount` query field and deriving cached comment counts from
  returned comment nodes.
- Added a Jira ADF regression test for garage-baton fenced comment round-trips.
- Added shared provider/API vocabulary guidance for agents and contributors.
- Removed internal `.ts` import specifiers from `src/` and `scripts/`, then
  dropped the now-unneeded `allowImportingTsExtensions` TypeScript setting.
- Centralized provider capability defaults and added regression coverage for
  local versus remote capability surfaces.

## 0.3.0 - 2026-04-22

- Added Jira provider support with changelog-backed activity and webhook-ready
  server flows.
- Added provider-native comments support, including comment edit behavior.
- Added reusable MCP server primitives and a stdio MCP subcommand for local
  integrations.
- Improved provider cache reconciliation, Linear description-change activity,
  exact Linear comment-count preservation, and task-level WebSocket updates.
- Refreshed MCP, comments, Jira, Linear, and webhook workflow docs.
- Simplified dashboard filters and cleaned up unused CLI and UI helpers.

## 0.2.0 - 2026-04-06

- Added a published GitHub Pages marketing site under `site/`.
- Improved the mobile kanban dashboard with a more focused small-screen board flow.
- Simplified mobile board UI internals to make the new layout easier to maintain.
- Added repository agent instructions for Cursor Cloud contributors.

## 0.1.0

- Initial public release of the Bun-based `agent-kanban` CLI and web dashboard.
