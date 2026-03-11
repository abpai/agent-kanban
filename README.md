# agent-kanban

Agent-friendly kanban board CLI. Manage tasks via bash commands, parse structured JSON output.

## Why

Most project-management tools are built for humans clicking through UIs. `agent-kanban` is built for **CLI-first workflows** — AI agents and scripts get deterministic JSON they can parse, humans get a pretty-printed view and a web dashboard. Runs against a local SQLite file or a Linear backend.

## Install

```bash
bun install -g agent-kanban
```

### Local development

```bash
git clone <repo-url> && cd agent-kanban
bun install
chmod +x src/index.ts
ln -sf "$(pwd)/src/index.ts" ~/.bun/bin/kanban
```

The symlink makes `kanban` available globally while you hack on the source.

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

| Variable          | Default            | Description                            |
| ----------------- | ------------------ | -------------------------------------- |
| `KANBAN_PROVIDER` | `local`            | `local` or `linear`                    |
| `KANBAN_DB_PATH`  | `.kanban/board.db` | SQLite database path                   |
| `LINEAR_API_KEY`  | —                  | Required when `KANBAN_PROVIDER=linear` |
| `LINEAR_TEAM_ID`  | —                  | Required when `KANBAN_PROVIDER=linear` |

### Linear quick start

```bash
export KANBAN_PROVIDER=linear
export LINEAR_API_KEY=lin_api_...
export LINEAR_TEAM_ID=<your-team-id>
kanban board view
```

### Capability matrix

| Capability              | Local | Linear |
| ----------------------- | ----- | ------ |
| task create/update/move | yes   | yes    |
| task delete             | yes   | no     |
| activity log            | yes   | no     |
| metrics                 | yes   | no     |
| column CRUD             | yes   | no     |
| bulk operations         | yes   | no     |
| config edit             | yes   | no     |

Linear tasks carry an `externalRef` (e.g. `R2P-123`) and a `url`. Commands accept either the internal ID or the external ref.

Unsupported operations return error code `UNSUPPORTED_OPERATION` with exit code 1.

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
```

## Global flags

| Flag               | Description                                                        |
| ------------------ | ------------------------------------------------------------------ |
| `--pretty`         | Human-readable output instead of JSON                              |
| `--db <path>`      | Database path (default: `.kanban/board.db`, env: `KANBAN_DB_PATH`) |
| `--project <name>` | Filter or set project context                                      |
| `-h`, `--help`     | Show help text                                                     |

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

- **REST API** at `/api/*` — same operations as the CLI (board, tasks, columns, activity, metrics, config)
- **WebSocket** at `/ws` — push notifications on board mutations (clients receive `{"type":"refresh"}`)
- **Static UI** served from `ui/dist/` (build with `bun run ui:build`)
- **Health check** at `/api/health`

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
| `bun run ui:build`   | Build UI to `ui/dist/` |

## Agent skill

This repo includes an agent usage skill at `SKILL.md` — a practical workflow for operating the board entirely via `kanban` commands.

## License

MIT
