# agent-kanban

[![CI](https://github.com/abpai/agent-kanban/actions/workflows/ci.yml/badge.svg)](https://github.com/abpai/agent-kanban/actions/workflows/ci.yml)

`agent-kanban` exists because browser-first project tools are a bad control
plane for agents, shell scripts, and CI jobs. If automation has to click
through a web app, scrape HTML, or learn a different integration for every
tracker, the setup gets brittle fast.

This repo gives you one small contract across three modes: a local SQLite board,
Linear, and Jira Cloud. The CLI stays the same. The JSON envelope stays the
same. Humans still get an optional dashboard when they want a visual pass.

That buys you a few things that are easy to miss at first:

- You can prototype an agent against a local board, then point the same workflow at Linear or Jira later.
- Remote modes use webhooks plus polling fallback, so missed events are less painful than with one-shot scripts or browser automation.
- Local mode needs no external database or service, which makes scratch boards, demos, and CI setups much easier to spin up.
- The repo also includes a reusable MCP layer, so sibling tools can reuse the same tracker semantics instead of growing their own tracker adapter.

## Documentation

- [`docs/readme.md`](docs/readme.md) for the documentation index
- [`docs/workflow.md`](docs/workflow.md) for a common day-to-day workflow
- [`docs/mcp.md`](docs/mcp.md) for the reusable tracker MCP module
- [`docs/providers/linear.md`](docs/providers/linear.md) for Linear provider details
- [`docs/providers/jira.md`](docs/providers/jira.md) for Jira provider details
- [`SKILL.md`](SKILL.md) for agent-specific repo usage instructions

## Install

```bash
bun install -g @andypai/agent-kanban
```

`agent-kanban` targets the Bun runtime. Install Bun first if it is not already available on your machine.

### Local development

```bash
git clone https://github.com/abpai/agent-kanban.git
cd agent-kanban
bun install
cd ui && bun install && cd ..
bun link
```

`bun link` makes `kanban` available globally while you work on the source checkout.

## Getting started

```bash
kanban board init
kanban task add "Set up CI pipeline" -p high -a alice
kanban task add "Write integration tests" -c backlog
kanban board view --pretty
```

Running `kanban` with no arguments is equivalent to `kanban board view`.

## Providers

All operations route through a provider backend. Set `KANBAN_PROVIDER` to choose one.

| Variable                  | Default       | Description                                                              |
| ------------------------- | ------------- | ------------------------------------------------------------------------ |
| `KANBAN_PROVIDER`         | `local`       | `local`, `linear`, or `jira`                                             |
| `KANBAN_DB_PATH`          | auto-resolved | SQLite database path                                                     |
| `KANBAN_SYNC_INTERVAL_MS` | `30000`       | Polling sync interval for remote providers; integer milliseconds >= 1000 |
| `LINEAR_API_KEY`          | —             | Required when `KANBAN_PROVIDER=linear`                                   |
| `LINEAR_TEAM_ID`          | —             | Required when `KANBAN_PROVIDER=linear`                                   |
| `JIRA_BASE_URL`           | —             | Required when `KANBAN_PROVIDER=jira` (e.g. `https://acme.atlassian.net`) |
| `JIRA_EMAIL`              | —             | Required when `KANBAN_PROVIDER=jira` (Atlassian account email)           |
| `JIRA_API_TOKEN`          | —             | Required when `KANBAN_PROVIDER=jira` (Atlassian API token)               |
| `JIRA_PROJECT_KEY`        | —             | Required when `KANBAN_PROVIDER=jira` (e.g. `ENG`)                        |
| `JIRA_BOARD_ID`           | —             | Optional when `KANBAN_PROVIDER=jira` (Agile board id for column order)   |
| `JIRA_ISSUE_TYPE`         | `Task`        | Optional when `KANBAN_PROVIDER=jira` (default issue type for new tasks)  |

Without `KANBAN_DB_PATH`, the local provider resolves the database in this order:

1. `./.kanban/board.db` if it exists in the current working directory
2. `~/.kanban/board.db` if it exists
3. `./.kanban/board.db` as the path to create

### Linear quick start

```bash
export KANBAN_PROVIDER=linear
export LINEAR_API_KEY=lin_api_...
export LINEAR_TEAM_ID=<team-id>
kanban board view
```

### Jira quick start

```bash
export KANBAN_PROVIDER=jira
export JIRA_BASE_URL=https://your-domain.atlassian.net
export JIRA_EMAIL=you@example.com
export JIRA_API_TOKEN=...
export JIRA_PROJECT_KEY=ENG
export JIRA_BOARD_ID=123  # optional
kanban board view
```

### Capability matrix

| Capability                 | Local | Linear | Jira |
| -------------------------- | ----- | ------ | ---- |
| task create/update/move    | yes   | yes    | yes  |
| task delete                | yes   | no     | no   |
| comment read/create/update | yes   | yes    | yes  |
| activity log               | yes   | no     | no   |
| metrics                    | yes   | no     | no   |
| column CRUD                | yes   | no     | no   |
| bulk operations            | yes   | no     | no   |
| config edit                | yes   | no     | no   |
| webhooks                   | no    | yes    | yes  |

Linear tasks carry an `externalRef` (e.g. `TEAM-123`) and a `url`. Commands accept either the internal ID or the external ref.
Jira tasks can also be addressed by issue key (for example `ENG-123`).

Local mode is still the only mode with built-in metrics, config mutation, bulk
cleanup, and the dashboard/bootstrap activity feed. Linear and Jira do keep
remote issue history and comment counts in their cache tables for sync and
provider-backed flows, but those modes do not expose the same local analytics
surface.

Unsupported operations return error code `UNSUPPORTED_OPERATION` with exit code 1.

Task comments are exposed through the CLI, REST API, MCP, and dashboard task
detail flows.

In Linear and Jira modes, webhooks update the cache immediately when configured,
and the normal poll loop still runs as a fallback so missed deliveries and
remote deletions are eventually reconciled.

## Commands

### board

| Command              | Description                                        |
| -------------------- | -------------------------------------------------- |
| `kanban board init`  | Initialize a new board with default columns        |
| `kanban board view`  | View the full board (default command)              |
| `kanban board reset` | Reset board — drops all data and restores defaults |

Default columns: `recurring`, `backlog`, `in-progress`, `review`, `done`.

### task

| Command                               | Description                                      |
| ------------------------------------- | ------------------------------------------------ |
| `kanban task add <title>`             | Add a task                                       |
| `kanban task list`                    | List tasks                                       |
| `kanban task view <id>`               | View task details                                |
| `kanban task update <id>`             | Update task fields                               |
| `kanban task delete <id>`             | Delete a task                                    |
| `kanban task move <id> <column>`      | Move task to a column                            |
| `kanban task assign <id> <user>`      | Assign task to a user                            |
| `kanban task prioritize <id> <level>` | Set priority (`low`, `medium`, `high`, `urgent`) |

**Flags for `task add`:**

| Flag               | Description                                                     |
| ------------------ | --------------------------------------------------------------- |
| `-d <text>`        | Description                                                     |
| `-c <column>`      | Target column (default: `backlog`)                              |
| `-p <level>`       | Priority: `low`, `medium`, `high`, `urgent` (default: `medium`) |
| `-a <user>`        | Assignee                                                        |
| `--project <name>` | Project tag                                                     |
| `-m <json>`        | Arbitrary metadata (must be valid JSON)                         |

**Flags for `task list`:**

| Flag               | Description                                                    |
| ------------------ | -------------------------------------------------------------- |
| `-c <column>`      | Filter by column                                               |
| `-p <level>`       | Filter by priority                                             |
| `-a <user>`        | Filter by assignee                                             |
| `--project <name>` | Filter by project                                              |
| `-l <n>`           | Limit results                                                  |
| `--sort <field>`   | Sort by: `priority`, `created`, `updated`, `position`, `title` |

**Flags for `task update`:**

| Flag               | Description     |
| ------------------ | --------------- |
| `--title <text>`   | New title       |
| `-d <text>`        | New description |
| `-p <level>`       | New priority    |
| `-a <user>`        | New assignee    |
| `--project <name>` | New project     |
| `-m <json>`        | New metadata    |

### comment

| Command                                               | Description           |
| ----------------------------------------------------- | --------------------- |
| `kanban comment list <task-id>`                       | List task comments    |
| `kanban comment add <task-id> <body>`                 | Create a task comment |
| `kanban comment update <task-id> <comment-id> <body>` | Update a task comment |

### column

| Command                                       | Description             |
| --------------------------------------------- | ----------------------- |
| `kanban column add <name>`                    | Add a column            |
| `kanban column list`                          | List all columns        |
| `kanban column rename <id\|name> <new-name>`  | Rename a column         |
| `kanban column reorder <id\|name> <position>` | Move column to position |
| `kanban column delete <id\|name>`             | Delete an empty column  |

**Flags for `column add`:**

| Flag             | Description                    |
| ---------------- | ------------------------------ |
| `--position <n>` | Insert at position (0-indexed) |
| `--color <hex>`  | Column color                   |

### bulk

| Command                            | Description                               |
| ---------------------------------- | ----------------------------------------- |
| `kanban bulk move-all <from> <to>` | Move all tasks from one column to another |
| `kanban bulk clear-done`           | Delete all tasks in the `done` column     |

### config

| Command                               | Description                 |
| ------------------------------------- | --------------------------- |
| `kanban config show`                  | Show board config (default) |
| `kanban config set-member <name>`     | Add or update a team member |
| `kanban config remove-member <name>`  | Remove a team member        |
| `kanban config add-project <name>`    | Register a project          |
| `kanban config remove-project <name>` | Remove a project            |

**Flags for `config set-member`:**

| Flag                    | Description                    |
| ----------------------- | ------------------------------ |
| `--role <human\|agent>` | Member role (default: `human`) |

### serve

```bash
kanban serve            # default port 3000
kanban serve --port 8080
kanban serve --tunnel   # optional public URL for webhook testing
```

### mcp

```bash
kanban mcp
kanban mcp --db /path/to/board.db
```

Runs the bundled MCP server over stdio for local MCP clients such as Claude
Desktop. See [`docs/mcp.md`](docs/mcp.md) for the tool surface and caveats.

## Global flags

| Flag               | Description                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `--pretty`         | Human-readable output instead of JSON                                                            |
| `--db <path>`      | Database path (default: local first, then `~/.kanban`, else create local; env: `KANBAN_DB_PATH`) |
| `--project <name>` | Filter or set project context                                                                    |
| `-h`, `--help`     | Show help text                                                                                   |

## Output format

Every command returns a JSON envelope on stdout:

```json
{ "ok": true, "data": { ... } }
```

```json
{ "ok": false, "error": { "code": "TASK_NOT_FOUND", "message": "No task with id 't_abc123'" } }
```

Exit codes: `0` success, `1` known error, `2` internal error.

Pass `--pretty` for human-readable output — board view, task lists, and details are formatted for the terminal.

## Web dashboard

```bash
kanban serve
```

In Linear mode the dashboard hides unsupported actions and shows Linear issue identifiers and links on task cards.

Starts a Bun HTTP server with:

- **REST API** at `/api/*` — board, tasks, task comments, bootstrap/provider metadata, activity, metrics, config, and webhook endpoints
- **WebSocket** at `/ws` — push notifications on board mutations (clients receive `task:upsert`, `task:delete`, or a fallback `refresh` event)
- **Static UI** served from `ui/dist/` (build with `bun run build:ui` or `bun run ui:build`)
- **Health check** at `/api/health` — cheap process liveness only
- **Readiness check** at `/api/ready` — reports whether the cache has warmed at least once
- **Sync status** at `/api/sync-status` — reports background sync state plus provider sync metadata

In `serve` mode, remote providers now warm once on startup and continue syncing
in the background every `KANBAN_SYNC_INTERVAL_MS` milliseconds. Full
reconciliation is still handled by the provider-specific logic on top of that
steady cadence.

Comment routes:

- `GET /api/tasks/:id/comments`
- `POST /api/tasks/:id/comments`
- `PATCH /api/tasks/:id/comments/:commentId`

## Reusable MCP core

The repo also includes a reusable tracker MCP implementation under `src/mcp/`.
There are two ways to use it today:

- run `kanban mcp` for a bundled stdio MCP server
- import the helpers in `src/mcp/` from a sibling workspace or in-repo consumer

See [`docs/mcp.md`](docs/mcp.md) for the current default tool set, the auth and
policy model, and the caveats around source-level imports and `kanban serve`.

## Scripts

| Script               | Description            |
| -------------------- | ---------------------- |
| `bun run dev`        | Run with watch mode    |
| `bun run start`      | Run once               |
| `bun run build`      | Bundle to `dist/`      |
| `bun run lint`       | ESLint                 |
| `bun run format`     | Prettier write         |
| `bun run typecheck`  | `tsc --noEmit`         |
| `bun run check`      | Lint + typecheck       |
| `bun run test`       | Bun test runner        |
| `bun run test:watch` | Tests in watch mode    |
| `bun run serve`      | Start web dashboard    |
| `bun run ui:dev`     | UI dev server          |
| `bun run dev:ui`     | API + UI dev servers   |
| `bun run ui:build`   | Build UI to `ui/dist/` |
| `bun run build:ui`   | Alias for `ui:build`   |

## Deployment

Build the Docker image:

```bash
docker build -t agent-kanban .
```

The same image works for both provider modes — only runtime env/volume config differs.

### Local mode (SQLite)

Mount a volume for the database directory. WAL mode creates `-wal` and `-shm` sibling files, so the volume must cover the directory, not just the `.db` file.

```bash
docker run -d \
  -p 3000:3000 \
  -v kanban-data:/data \
  -e KANBAN_DB_PATH=/data/board.db \
  agent-kanban
```

### Linear mode

No volume needed — all state lives in Linear.

```bash
docker run -d \
  -p 3000:3000 \
  -e KANBAN_PROVIDER=linear \
  -e LINEAR_API_KEY=lin_api_... \
  -e LINEAR_TEAM_ID=team-id \
  agent-kanban
```

### Jira mode

No volume needed — all state lives in Jira Cloud.

```bash
docker run -d \
  -p 3000:3000 \
  -e KANBAN_PROVIDER=jira \
  -e JIRA_BASE_URL=https://your-domain.atlassian.net \
  -e JIRA_EMAIL=you@example.com \
  -e JIRA_API_TOKEN=... \
  -e JIRA_PROJECT_KEY=ENG \
  -e JIRA_BOARD_ID=123 \
  agent-kanban
```

### Dokploy

Set the port via `PORT` env var (defaults to `3000`). Port resolution order: `--port` flag → `PORT` env → `3000`. Add provider env vars through Dokploy's environment configuration.

## Community

If you want to contribute or report an issue, start with these guides:

- [CONTRIBUTING.md](CONTRIBUTING.md)
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- [SECURITY.md](SECURITY.md)

Longer product and workflow docs live under [`docs/`](docs/readme.md).

## License

MIT
