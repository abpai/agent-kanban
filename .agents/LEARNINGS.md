# LEARNINGS

## Corrections

| Date       | Source                   | What Went Wrong                                                                                | What To Do Instead                                                                                          |
| ---------- | ------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 2026-02-20 | agent-browser smoke test | `find text` can fail in strict mode when the same string appears in both card and detail panel | Use `agent-browser find nth ...` or `find title "Click to edit"` to target specific editable nodes reliably |

## User Preferences

- Treat "review" requests as code-review output: findings first, severity-ordered, with file/line references.

## Patterns That Work

- Start review tasks by comparing requested plan scope against actual implementation across backend and frontend.
- For UI smoke checks with duplicate visible text, use stable locators (`title`, `nth`, `role+name`) rather than plain text locators.
- For Bun CLIs, adding `#!/usr/bin/env bun` to the bin entrypoint plus `bun link` gives a reliable global command workflow (`kanban ...`) for local agent usage.
- For readability-only refactors, extract tiny helpers for repeated response/header/error logic to reduce duplication while keeping behavior identical.

## Patterns That Don't Work

- Skipping project memory initialization causes avoidable process misses.

## Domain Notes

- agent-kanban includes Bun/SQLite backend and React/Zustand frontend; major roadmap includes Mission Control style board and websocket updates.

## Review Findings Patterns

- CLI code paths that do not call `initSchema()` (for example `task add/list/update`) can bypass migrations; schema changes must be invoked right after `openDb()` or before any CRUD command.
- API mutation signaling should be based on successful response status, not just HTTP verb, to avoid false WebSocket refresh broadcasts.
- Adaptive polling tied to a one-time `setInterval` delay can silently ignore WebSocket state changes; use recursive `setTimeout` with per-tick delay selection.
