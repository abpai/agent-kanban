# Engineering commands

Agent Kanban uses Bun as its runtime and package manager. CI and the
`packageManager` field both pin Bun 1.4.2; the CLI requires Bun >=1.4.2, and both
Docker stages use the same version. `@types/bun` matches the runtime.
`@types/node` is pinned to 22.20.2 for Bun's Node-compatible APIs: Bun 1.4.2's
`memoryPressure` declarations otherwise hide the signal-event overloads in
Node 25 types. Recheck `process.on`/`off` typing before changing that pin.

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

This expands to lint, root TypeScript (including `scripts/`), and UI TypeScript
checks. TypeScript and Prettier cache successful work under the ignored
`.cache/` directory.

### Lint and formatting

`bun run lint:oxlint` checks JavaScript and TypeScript, including the existing
type-aware `no-floating-promises` rule. `.oxlintrc.json` spells out the migrated
ESLint rules so the migration preserves the quality gate. TypeScript catches
undefined names in TypeScript; Oxlint retains `no-undef` for JavaScript.

`bun run lint:format` checks the same JavaScript/TypeScript formatting surface
as the previous ESLint setup, with a content-based Prettier cache. Run
`bun run format` to format the full repository, or pass changed paths directly
to `bun x --no-install prettier --write` for a focused fix.

This adopts the separate Oxlint/Prettier checks, incremental TypeScript, and
15 generic deslop rules from [templates.bun](https://github.com/abpai/templates.bun).
The vendored plugin's pinned source, license, and local changes are recorded in
[`tools/oxlint/anti-slop/UPSTREAM.md`](../../tools/oxlint/anti-slop/UPSTREAM.md).
Effect-specific rules are excluded because this repository does not use Effect.

The template's eleven hard rules are errors: they reject chained assertions,
unexplained casts, type widening, unparsed unknown contracts, unsafe dictionary
contracts, and reflective property access/calls. Its four advisory rules remain
warnings (conditional empty-object spreads, module mocks, runtime `typeof`, and
shape-based symbol names). Modified cyclomatic complexity warns above **22**.
Unused disable directives are errors, so a stale exception cannot silently linger.

Prefer query generics, inferred types or `satisfies`, and decoding at external
boundaries. A retained assertion needs an adjacent `SAFETY:` comment explaining
the invariant. A required unknown input or extensible public contract needs a
local rule exception with a concrete reason; do not replace `unknown` with an
unchecked generic or weaker type just to make lint pass. `src/json.ts` describes
actual JSON values used by provider APIs, separately from arbitrary MCP values.

Native type-aware linting is provided by the paired `oxlint-tsgolint` dependency;
custom rules use the matching `@oxlint/plugins` version. Keep these dependencies
aligned when updating Oxlint. Plugin fixtures run with `bun test` and can be run
alone with `bun test tools/oxlint/anti-slop/rules.test.ts`.

## Dead-code / unused-export scan

```bash
bun run knip
```

`knip` (config in `knip.json`) reports unused files, dependencies, and exports
across both the root package and the `ui` workspace. It treats the published
`exports`-map subpaths and `bin` as the public API surface, plus the documented
`src/mcp/index.ts` entry used by embedding hosts. It flags internal dead code —
prefer un-exporting a flagged symbol (making it
module-private) over deleting it when it is still used within its own file. CI
runs this as a gate, so keep it green.

## Full lane

Done means the full lane is green, or every skipped/blocked command is explained.

```bash
bun run check
bun run knip
bun test
bun run build
bun run ui:build
bun run test:ui
```

### Dashboard browser proof

`bun run test:ui` starts the built dashboard against a temporary SQLite database
and drives it in headless Chrome. It checks the main task workflow at desktop
and mobile sizes and exits after cleaning up the server and temporary data.
Build `ui/dist/` first. The smoke uses an existing Chrome/Chromium installation;
set `CHROME_PATH` if its executable is outside the standard locations. CI uses
the runner's `/usr/bin/google-chrome`.

To retain screenshots for visual review:

```bash
bun run test:ui --screenshots=/tmp/kanban-ui-proof
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
already taken, set `KANBAN_PG_PORT` (e.g. `5433`) — `pg:up`, `pg:down`, and
`test:pg` all honor it, so `KANBAN_PG_PORT=5433 bun run pg:up && KANBAN_PG_PORT=5433 bun run test:pg`
stays consistent (an explicit `DATABASE_URL` still overrides the port entirely).
CI runs the equivalent `bun test` with `DATABASE_URL` set through its Postgres
service; publishing that database is CI-owned.

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
