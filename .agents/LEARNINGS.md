# LEARNINGS

## Corrections

| Date       | Source                   | What Went Wrong                                                                                | What To Do Instead                                                                                          |
| ---------- | ------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 2026-02-20 | agent-browser smoke test | `find text` can fail in strict mode when the same string appears in both card and detail panel | Use `agent-browser find nth ...` or `find title "Click to edit"` to target specific editable nodes reliably |
| 2026-03-04 | self                     | Used `apply_patch` through `exec_command`                                                      | Call the dedicated `apply_patch` tool directly for patch edits                                              |
| 2026-03-04 | self                     | `claude -p` can occasionally exit `0` with empty stdout on long prompts                        | Treat empty output as soft failure; rerun once using temp-file prompt pattern and stricter output contract  |
| 2026-03-08 | shell review             | Used `local path=...` in a zsh function, which clobbered the special `path`/`PATH` lookup      | Never use `path` as a local variable name in zsh; prefer `worktree_path`, `found_path`, etc.                |

## User Preferences

- Treat "review" requests as code-review output: findings first, severity-ordered, with file/line references.
- Pre-launch architecture can break backward compatibility if it creates a cleaner long-term API design.

## Patterns That Work

- Start review tasks by comparing requested plan scope against actual implementation across backend and frontend.
- For UI smoke checks with duplicate visible text, use stable locators (`title`, `nth`, `role+name`) rather than plain text locators.
- For Bun CLIs, adding `#!/usr/bin/env bun` to the bin entrypoint plus `bun link` gives a reliable global command workflow (`kanban ...`) for local agent usage.
- For readability-only refactors, extract tiny helpers for repeated response/header/error logic to reduce duplication while keeping behavior identical.
- For mixed local/remote backends, a single bootstrap endpoint (`provider + capabilities + board + config`) keeps the UI simpler than parallel feature-specific fetches and makes unsupported-provider behavior much easier to gate.
- For `.env.example` updates, derive variables from actual `process.env` reads and then cross-check docs so the example only includes live config keys.

## Patterns That Don't Work

- Skipping project memory initialization causes avoidable process misses.

## Domain Notes

- agent-kanban includes Bun/SQLite backend and React/Zustand frontend; major roadmap includes Mission Control style board and websocket updates.

## Review Findings Patterns

- CLI code paths that do not call `initSchema()` (for example `task add/list/update`) can bypass migrations; schema changes must be invoked right after `openDb()` or before any CRUD command.
- API mutation signaling should be based on successful response status, not just HTTP verb, to avoid false WebSocket refresh broadcasts.
- Adaptive polling tied to a one-time `setInterval` delay can silently ignore WebSocket state changes; use recursive `setTimeout` with per-tick delay selection.
