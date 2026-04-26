# AGENTS.md

## Cursor Cloud specific instructions

### Overview

agent-kanban is a CLI-first kanban board tool with an optional web dashboard, built on **Bun** (not Node.js). It uses embedded SQLite via `bun:sqlite` — no external database server required.

### Shared vocabulary

Before planning or implementing provider/API work, read `UBIQUITOUS_LANGUAGE.md`.
Use its canonical terms in public types, CLI output, API responses, tests, and docs.

### Runtime

- **Bun ≥1.1.0** is the sole runtime. CI pins `1.3.11`. Install via `curl -fsSL https://bun.sh/install | bash`.
- Bun must be on `$PATH` (typically `~/.bun/bin`).

### Dependencies

Two separate install steps are required — root and UI are independent workspaces:

```bash
bun install              # root
cd ui && bun install     # UI (React/Vite)
```

### Commands reference

All scripts are in `package.json`. Key commands:

| Task             | Command                     |
| ---------------- | --------------------------- |
| Lint + typecheck | `bun run check`             |
| Tests            | `bun test`                  |
| Build CLI        | `bun run build`             |
| Build UI         | `bun run ui:build`          |
| Dev (watch mode) | `bun run dev`               |
| Dev (API + UI)   | `bun run dev:ui`            |
| Serve dashboard  | `bun run serve` (port 3000) |

### Gotchas

- The SQLite DB auto-resolves: local `.kanban/board.db` first, then `~/.kanban/board.db`. Running tests creates a DB in the cwd. Use `KANBAN_DB_PATH` env var to override.
- `bun link` makes the `kanban` CLI available globally from the source checkout.
- The web dashboard (`bun run serve`) requires `ui/dist/` to exist — run `bun run ui:build` first.
- Pre-commit hook runs `lint-staged` via Husky — ensure `bun install` has been run so Husky is set up.
- `bun run build` must use `--target bun` (already configured in `package.json`).
