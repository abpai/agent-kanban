# Engineering commands

Agent Kanban uses Bun as its runtime and package manager. CI pins Bun 1.3.11;
the local package manager field currently names Bun 1.3.3.

## Bootstrap

| Task                           | Command                | Notes                                                                        |
| ------------------------------ | ---------------------- | ---------------------------------------------------------------------------- |
| Install root dependencies      | `bun install`          | Run from the repo root.                                                      |
| Install dashboard dependencies | `cd ui && bun install` | The UI is an independent Vite package.                                       |
| Link the local CLI             | `bun link`             | Optional; use `bun src/index.ts ...` when you do not need a global `kanban`. |

There is no single bootstrap script yet. A fresh checkout needs the root and UI
install commands above.

## Fast lane

Run this before handing off a normal code change:

```bash
bun run check
```

This expands to lint, root TypeScript, and UI TypeScript checks.

## Full lane

Done means the full lane is green, or every skipped/blocked command is explained.

```bash
bun run check
bun test
bun run build
bun run ui:build
```

For Postgres provider coverage, run `bun test` with a reachable test database:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/kanban_test bun test
```

CI provides that database through the Postgres service in
`.github/workflows/ci.yml`.

## Health smokes

| Surface                  | Command                                                              | Expected proof                                                                  |
| ------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| CLI dispatch             | `bun src/index.ts --help`                                            | Usage text exits successfully.                                                  |
| Local board read         | `KANBAN_DB_PATH="$(mktemp -d)/board.db" bun src/index.ts board view` | JSON envelope for an empty/default local board or a known local-provider error. |
| Dashboard build artifact | `bun run ui:build`                                                   | `ui/dist/` is produced by Vite.                                                 |

## Development commands

| Task                      | Command          | Notes                                                        |
| ------------------------- | ---------------- | ------------------------------------------------------------ |
| CLI watch mode            | `bun run dev`    | Long-running watch mode; not a validation command.           |
| API plus dashboard dev    | `bun run dev:ui` | Long-running dev server pair; not a validation command.      |
| Dashboard dev server      | `bun run ui:dev` | Long-running Vite server.                                    |
| Serve built dashboard/API | `bun run serve`  | Requires `ui/dist/`; use for manual or browser verification. |

## Release commands

Do not run publish commands as validation. Release is owned by the Changesets
workflow.

| Task             | Command             | Notes                                                                    |
| ---------------- | ------------------- | ------------------------------------------------------------------------ |
| Add a changeset  | `bun run changeset` | For user-facing package changes.                                         |
| Version packages | `bun run version`   | Normally run by the Version Packages PR.                                 |
| Publish          | `bun run release`   | CI-owned release action. Do not run locally unless explicitly releasing. |
