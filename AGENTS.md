# Agent guide

Agent Kanban is a Bun-first tracker with a CLI, optional dashboard, and reusable
MCP layer. Code, tests, and runtime behavior are the source of truth; docs route
you to the right code and validation path.

## Operating model

- Specs come from intake against `docs/SPEC_CONTRACT.md`; you own implementation
  through end-to-end proof.
- Identify the validation command before editing. Escalate per the spec
  contract; otherwise execute the change end to end.
- Use Bun, not Node.js. CI pins Bun 1.3.11 and `package.json` requires
  Bun >=1.1.0.

## Where to look

- Spec contract: `docs/SPEC_CONTRACT.md`
- Documentation index: `docs/INDEX.md`
- Architecture map: `docs/ARCHITECTURE.md`
- Commands: `docs/engineering/commands.md`
- Testing and proof map: `docs/engineering/testing.md`
- Product workflow: `docs/workflow.md`
- MCP guide: `docs/mcp.md`
- Provider guides: `docs/providers/linear.md`, `docs/providers/jira.md`
- Canonical terms: `UBIQUITOUS_LANGUAGE.md`

## Repo-specific rules

- Before provider/API work, read `UBIQUITOUS_LANGUAGE.md` and use its terms in
  public types, CLI output, API responses, tests, and docs.
- Root and UI dependencies are installed separately: `bun install`, then
  `cd ui && bun install`.
- SQLite auto-resolves `.kanban/board.db` before `~/.kanban/board.db`; use
  `KANBAN_DB_PATH` for hermetic local smokes.
- `bun run serve` requires `ui/dist/`; run `bun run ui:build` first.

## Done means

- The full validation lane in `docs/engineering/commands.md` passed, or every
  skipped/blocked command is explained.
- Proof is attached per `docs/SPEC_CONTRACT.md`.
- Durable knowledge landed on the smallest relevant surface; deferred work goes
  in `docs/todos` only when it is still real and actionable.
