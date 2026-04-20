# LEARNINGS

## Corrections

| Date       | Source                   | What Went Wrong                                                                                                  | What To Do Instead                                                                                          |
| ---------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 2026-02-20 | agent-browser smoke test | `find text` can fail in strict mode when the same string appears in both card and detail panel                   | Use `agent-browser find nth ...` or `find title "Click to edit"` to target specific editable nodes reliably |
| 2026-03-04 | self                     | Used `apply_patch` through `exec_command`                                                                        | Call the dedicated `apply_patch` tool directly for patch edits                                              |
| 2026-03-04 | self                     | `claude -p` can occasionally exit `0` with empty stdout on long prompts                                          | Treat empty output as soft failure; rerun once using temp-file prompt pattern and stricter output contract  |
| 2026-03-08 | shell review             | Used `local path=...` in a zsh function, which clobbered the special `path`/`PATH` lookup                        | Never use `path` as a local variable name in zsh; prefer `worktree_path`, `found_path`, etc.                |
| 2026-03-26 | open-source prep         | `bun build` defaulted to the browser target and broke the CLI bundle because the entrypoint imports `bun:sqlite` | Set `--target bun` when bundling Bun-native entrypoints, especially before wiring builds into CI            |
| 2026-04-06 | release prep             | Assumed npm publish would be available locally during release prep                                               | Check `npm whoami` before the final publish step so release work can be staged without blocking on auth     |

## User Preferences

- Treat "review" requests as code-review output: findings first, severity-ordered, with file/line references.
- Pre-launch architecture can break backward compatibility if it creates a cleaner long-term API design.

## Patterns That Work

- For mobile kanban layouts in this repo, use a phone-native single-column flow with explicit column tabs/stepper navigation and swipe gestures, instead of relying on the desktop board's horizontal scroll lane.
- For mobile grouped-list headers in the UI, keep the expand/collapse control and the add-task action as separate sibling buttons; nesting one interactive control inside another causes invalid markup and flaky behavior.
- Safe-area-aware root, overlay, and drawer padding is required for iPhone Safari; sticky mobile chrome should also account for the top inset.
- Start review tasks by comparing requested plan scope against actual implementation across backend and frontend.
- For session/work review in this repo, separate committed git history from the current dirty worktree; substantial agent work may be present, testable, and still not landed in a commit.
- For UI smoke checks with duplicate visible text, use stable locators (`title`, `nth`, `role+name`) rather than plain text locators.
- For Bun CLIs, adding `#!/usr/bin/env bun` to the bin entrypoint plus `bun link` gives a reliable global command workflow (`kanban ...`) for local agent usage.
- For readability-only refactors, extract tiny helpers for repeated response/header/error logic to reduce duplication while keeping behavior identical.
- For readability-only refactors in SQLite-heavy files, alias repeated scalar queries behind tiny `count`/`value` helpers to remove cast noise without changing SQL behavior.
- For static marketing pages in this repo, avoid nested interactive controls; keep one real button per action and read copyable command text from the rendered `<code>` element so markup and JS stay in sync.
- For mixed local/remote backends, a single bootstrap endpoint (`provider + capabilities + board + config`) keeps the UI simpler than parallel feature-specific fetches and makes unsupported-provider behavior much easier to gate.
- For `.env.example` updates, derive variables from actual `process.env` reads and then cross-check docs so the example only includes live config keys.
- When renaming Bun package scripts, cross-check script-to-script callers (`bun run ...`) and README commands together; tests may still pass while the dev workflow is broken.
- For Bun CLIs that also serve a static UI, ship `ui/dist` in the published package and build it in `prepack`; otherwise `serve` works locally but breaks for installed users.
- For docs cleanup in this repo, keep the root `README.md` as the quick-start front door and move longer operational or integration writeups under `docs/`.
- For releases in this repo, a lightweight `CHANGELOG.md` tied to the npm version makes GitHub/npm release notes easier to assemble than reconstructing changes from merges later.
- When triaging repo health after large agent-generated changes, run `bunx tsc --noEmit` separately from `bun run check`; lint/prettier can fail while the TypeScript build is still clean.
- For task-level WebSocket patches in the UI, dedupe optimistic temp rows against the server-issued task id before replacing optimistic state, or self-originated create events can render duplicate cards.
- For task-level WebSocket patches in the UI, preserve server ordering/position when reinserting a task; remove-and-append helpers make unchanged tasks jump to the bottom of their column.

## Patterns That Don't Work

- Skipping project memory initialization causes avoidable process misses.

## Domain Notes

- agent-kanban includes Bun/SQLite backend and React/Zustand frontend; major roadmap includes Mission Control style board and websocket updates.

## Review Findings Patterns

- CLI code paths that do not call `initSchema()` (for example `task add/list/update`) can bypass migrations; schema changes must be invoked right after `openDb()` or before any CRUD command.
- API mutation signaling should be based on successful response status, not just HTTP verb, to avoid false WebSocket refresh broadcasts.
- Adaptive polling tied to a one-time `setInterval` delay can silently ignore WebSocket state changes; use recursive `setTimeout` with per-tick delay selection.
- Jira webhook handlers must re-check the configured project key before caching issue payloads; otherwise a broadly scoped webhook can leak other Jira projects into the current board cache.
