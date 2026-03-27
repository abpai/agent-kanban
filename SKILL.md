---
name: agent-kanban
description: Operate the agent-kanban board through the `kanban` CLI — supports local (SQLite) and Linear providers.
---

# agent-kanban Usage Skill

Use this skill when working inside the `agent-kanban` repository and you need to manage board data from the terminal. All commands return structured JSON by default — parse the output to chain operations.

## Prerequisites

- Bun is installed (`>=1.1.0`).
- The CLI is globally available as `kanban` (run `bun link` once from repo root).
- Fallback: `bun src/index.ts <command>`.

## Provider configuration

| Variable          | Default            | Description                            |
| ----------------- | ------------------ | -------------------------------------- |
| `KANBAN_PROVIDER` | `local`            | `local` or `linear`                    |
| `KANBAN_DB_PATH`  | `.kanban/board.db` | SQLite database path                   |
| `LINEAR_API_KEY`  | —                  | Required when `KANBAN_PROVIDER=linear` |
| `LINEAR_TEAM_ID`  | —                  | Required when `KANBAN_PROVIDER=linear` |

In Linear mode, tasks have an `externalRef` (e.g. `TEAM-123`). Use it interchangeably with UUIDs:

```bash
kanban task view TEAM-123
```

## Linear mode limits

These commands return `UNSUPPORTED_OPERATION` in Linear mode:

- `task delete`
- `column add/rename/reorder/delete`
- `bulk move-all`, `bulk clear-done`
- `config set-member/remove-member/add-project/remove-project`

Works in both modes: `task add/list/view/update/move`, `board view`, `column list`, `config show`, `serve`.

## Output format

Every command writes a JSON envelope to stdout:

```
Success: {"ok":true,"data":{...}}
Error:   {"ok":false,"error":{"code":"TASK_NOT_FOUND","message":"No task with id 't_abc123'"}}
```

Exit codes: `0` = success, `1` = known error (bad input, not found), `2` = internal error.

Use `--pretty` only for human-readable debugging — agents should parse the default JSON.

## Extracting IDs from output

Task and column IDs are returned in `data.id`. To chain commands, capture the ID:

```bash
# Add a task and capture its ID
result=$(kanban task add "Implement auth" -p high -a BuildBot --project myapp)
task_id=$(echo "$result" | jq -r '.data.id')

# Use the ID in follow-up commands
kanban task move "$task_id" in-progress
kanban task assign "$task_id" Alex
kanban task view "$task_id"
```

## Setup workflow

```bash
# 1. Initialize board (creates default columns: recurring, backlog, in-progress, review, done)
kanban board init

# 2. Configure team
kanban config set-member Alex --role human
kanban config set-member BuildBot --role agent
kanban config add-project myapp

# 3. Verify
kanban config show
```

### Linear mode — no board init needed

```bash
export KANBAN_PROVIDER=linear
export LINEAR_API_KEY=lin_api_...
export LINEAR_TEAM_ID=<team-id>
kanban board view
```

## Task lifecycle

In Linear mode, omit `delete`. Use external refs (`TEAM-123`) interchangeably with IDs.

```bash
# Create
kanban task add "Build auth module" -d "JWT + refresh tokens" -c backlog -p high -a BuildBot --project myapp -m '{"effort":"large"}'

# List with filters
kanban task list -c backlog
kanban task list -a BuildBot -p high
kanban task list --project myapp --sort priority -l 10

# Read details
kanban task view <id>

# Update fields
kanban task update <id> --title "Build OAuth module" -d "Switch to OAuth2" -p urgent
kanban task update <id> -a Alex --project other-project -m '{"effort":"small"}'

# Move through columns
kanban task move <id> in-progress
kanban task move <id> review
kanban task move <id> done

# Reassign and reprioritize (shortcuts)
kanban task assign <id> Alex
kanban task prioritize <id> urgent

# Delete
kanban task delete <id>
```

### Sort fields for `task list`

`priority` | `created` | `updated` | `position` | `title`

### Priority levels

`low` | `medium` (default) | `high` | `urgent`

## Column management

```bash
kanban column list
kanban column add "blocked" --position 3 --color "#ff4444"
kanban column rename blocked stalled
kanban column reorder stalled 1
kanban column delete stalled          # only works if column is empty
```

Columns are resolved by ID or name (case-insensitive).

## Bulk operations

```bash
kanban bulk move-all review done      # move all tasks from review to done
kanban bulk clear-done                # delete all tasks in the done column
```

## Config management

```bash
kanban config show
kanban config set-member <name> --role human|agent
kanban config remove-member <name>
kanban config add-project <name>
kanban config remove-project <name>
```

Config is stored in `.kanban/config.json` alongside the database.

## Board inspection

```bash
kanban                    # shortcut for board view
kanban board view         # full board with all columns and tasks
kanban board view --pretty  # human-readable board
kanban board reset        # WARNING: drops all data, restores defaults
```

## Global flags

| Flag               | Description                                                               |
| ------------------ | ------------------------------------------------------------------------- |
| `--pretty`         | Human-readable output (skip for agent use)                                |
| `--db <path>`      | Custom database path (default: `.kanban/board.db`, env: `KANBAN_DB_PATH`) |
| `--project <name>` | Filter or set project context                                             |
| `-h`, `--help`     | Show help text                                                            |

## Web dashboard

```bash
kanban serve              # starts on port 3000
kanban serve --port 8080  # custom port
```

REST API is at `/api/*`, WebSocket at `/ws` (receives `{"type":"refresh"}` on mutations), health check at `/api/health`.
