---
name: agent-kanban
description: Operate the local agent-kanban board through the `kanban` CLI — init, task lifecycle, column/config management, and the web dashboard.
---

# agent-kanban Usage Skill

Use this skill when working inside the `agent-kanban` repository and you need to manage board data from the terminal. All commands return structured JSON by default — parse the output to chain operations.

## Prerequisites

- Bun is installed (`>=1.1.0`).
- The CLI is globally available as `kanban` (run `bun link` once from repo root).
- Fallback: `bun src/index.ts <command>`.

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
result=$(kanban task add "Implement auth" -p high -a Claude --project myapp)
task_id=$(echo "$result" | jq -r '.data.id')

# Use the ID in follow-up commands
kanban task move "$task_id" in-progress
kanban task assign "$task_id" Alice
kanban task view "$task_id"
```

## Setup workflow

```bash
# 1. Initialize board (creates default columns: recurring, backlog, in-progress, review, done)
kanban board init

# 2. Configure team
kanban config set-member Andy --role human
kanban config set-member Claude --role agent
kanban config add-project myapp

# 3. Verify
kanban config show
```

## Task lifecycle

```bash
# Create
kanban task add "Build auth module" -d "JWT + refresh tokens" -c backlog -p high -a Claude --project myapp -m '{"effort":"large"}'

# List with filters
kanban task list -c backlog
kanban task list -a Claude -p high
kanban task list --project myapp --sort priority -l 10

# Read details
kanban task view <id>

# Update fields
kanban task update <id> --title "Build OAuth module" -d "Switch to OAuth2" -p urgent
kanban task update <id> -a Andy --project other-project -m '{"effort":"small"}'

# Move through columns
kanban task move <id> in-progress
kanban task move <id> review
kanban task move <id> done

# Reassign and reprioritize (shortcuts)
kanban task assign <id> Alice
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
