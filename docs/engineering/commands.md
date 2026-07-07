# Engineering commands

Agent Kanban uses Bun as its runtime and package manager. CI pins Bun 1.3.11;
the local package manager field currently names Bun 1.3.3.

## Bootstrap

One command brings a fresh checkout up — it installs the root and UI packages:

```bash
bun run bootstrap
```

Then confirm the CLI dispatches:

```bash
bun run smoke   # prints usage and exits 0
```

The individual steps `bun run bootstrap` wraps, if you need to run them on their
own:

| Task                           | Command                | Notes                                                                        |
| ------------------------------ | ---------------------- | ---------------------------------------------------------------------------- |
| Install root dependencies      | `bun install`          | Run from the repo root.                                                      |
| Install dashboard dependencies | `cd ui && bun install` | The UI is an independent Vite package.                                       |
| Link the local CLI             | `bun link`             | Optional; use `bun src/index.ts ...` when you do not need a global `kanban`. |

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

### Postgres parity proof

The `postgres-*` provider suites `test.skip` themselves unless a reachable test
database is supplied via `DATABASE_URL` (or `KANBAN_PG_TEST_URL`). Run them
against a real Postgres to prove parity for provider, storage, sync, or cache
changes:

```bash
bun run pg:up      # start disposable Postgres 17 (docker-compose.postgres.yml)
bun run test:pg    # run the suite with DATABASE_URL pointed at it
bun run pg:down    # tear down the container and drop its volume
```

`docker-compose.postgres.yml` mirrors the `postgres` service in
`.github/workflows/ci.yml` (image, credentials, database, port), so a green
`bun run test:pg` reproduces exactly what CI proves. If host port `5432` is
already taken, set `KANBAN_PG_PORT` (e.g. `5433`) for `pg:up`/`pg:down` and point
`DATABASE_URL` at the same port. CI runs the equivalent `bun test` with
`DATABASE_URL` set through its Postgres service; publishing that database is
CI-owned.

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
