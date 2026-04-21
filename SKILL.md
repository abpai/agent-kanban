---
name: agent-kanban
description: Operate the agent-kanban board via its stdio MCP server (preferred) or the `kanban` CLI — supports local (SQLite), Linear, and Jira providers.
---

# agent-kanban Usage Skill

Use this skill when working inside the `agent-kanban` repository and you need to manage board data. Two interfaces are available:

1. **MCP (preferred).** `bun src/index.ts mcp` starts a stdio MCP server that exposes `getBoard`, `getTicket`, `listComments`, `postComment`, `updateComment`, `moveTicket`. This is the right surface for Claude Code, Claude Desktop, and any MCP-aware agent — no spawning per command, no JSON parsing boilerplate, and inputs are schema-validated.
2. **CLI (fallback).** `kanban <command>` (or `bun src/index.ts <command>`). Useful for shell scripts, cron jobs, or anything not MCP-aware. All commands return structured JSON — parse to chain.

## Prerequisites

- Bun is installed (`>=1.1.0`).
- For CLI use: run `bun link` once from repo root so `kanban` resolves globally. Fallback: `bun src/index.ts <command>`.
- For MCP use: no separate install — the server ships as the `mcp` subcommand.

## MCP server (preferred)

Start the server over stdio:

```bash
cd /path/to/agent-kanban && bun src/index.ts mcp
```

Register it with a client. For Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`) or Claude Code (`~/.claude.json` under `mcpServers`):

```json
{
  "mcpServers": {
    "agent-kanban": {
      "command": "bun",
      "args": ["/path/to/agent-kanban/src/index.ts", "mcp"],
      "env": {
        "KANBAN_PROVIDER": "local"
      }
    }
  }
}
```

Available tools:

| Tool            | Input                           | Returns                            |
| --------------- | ------------------------------- | ---------------------------------- |
| `getBoard`      | `{}`                            | Full board state (columns + tasks) |
| `getTicket`     | `{ ticketId }`                  | Single task by id or external ref  |
| `listComments`  | `{ ticketId }`                  | Comments in creation order         |
| `postComment`   | `{ ticketId, body }`            | Created comment                    |
| `updateComment` | `{ ticketId, commentId, body }` | Updated comment                    |
| `moveTicket`    | `{ ticketId, column }`          | `{ ok: true }`                     |

The stdio server runs with an allow-all policy — suitable for local/single-user contexts. For multi-tenant HTTP deployments use `createTrackerMcpServer` from `src/mcp/` and supply your own auth + policy.

## Provider configuration

| Variable           | Default       | Description                                                              |
| ------------------ | ------------- | ------------------------------------------------------------------------ |
| `KANBAN_PROVIDER`  | `local`       | `local`, `linear`, or `jira`                                             |
| `KANBAN_DB_PATH`   | auto-resolved | SQLite database path                                                     |
| `LINEAR_API_KEY`   | —             | Required when `KANBAN_PROVIDER=linear`                                   |
| `LINEAR_TEAM_ID`   | —             | Required when `KANBAN_PROVIDER=linear`                                   |
| `JIRA_BASE_URL`    | —             | Required when `KANBAN_PROVIDER=jira` (e.g. `https://acme.atlassian.net`) |
| `JIRA_EMAIL`       | —             | Required when `KANBAN_PROVIDER=jira` (Atlassian account email)           |
| `JIRA_API_TOKEN`   | —             | Required when `KANBAN_PROVIDER=jira` (Atlassian API token)               |
| `JIRA_PROJECT_KEY` | —             | Required when `KANBAN_PROVIDER=jira` (e.g. `ENG`)                        |
| `JIRA_BOARD_ID`    | —             | Optional when `KANBAN_PROVIDER=jira` (Agile board id)                    |
| `JIRA_ISSUE_TYPE`  | `Task`        | Optional when `KANBAN_PROVIDER=jira` (default issue type)                |

Without `KANBAN_DB_PATH`, the local provider resolves the database in this order:

1. `./.kanban/board.db` if it already exists
2. `~/.kanban/board.db` if it already exists
3. create and use `./.kanban/board.db`

In Linear mode, tasks have an `externalRef` (e.g. `TEAM-123`). Use it interchangeably with UUIDs:

```bash
kanban task view TEAM-123
```

## Non-local mode limits

These commands return `UNSUPPORTED_OPERATION` in both Linear mode and Jira mode:

- `task delete`
- `column add/rename/reorder/delete`
- `bulk move-all`, `bulk clear-done`
- `config set-member/remove-member/add-project/remove-project`

Works in all three modes (local, Linear, Jira): `task add/list/view/update/move`, `board view`, `column list`, `config show`, `serve`.

## CLI reference

Use the CLI when MCP is not an option (shell scripts, cron, non-MCP clients) or when you need a capability MCP doesn't expose (column CRUD, bulk ops, config edits, board init/reset). MCP covers the common read/write path; the CLI is the escape hatch.

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

### Jira mode — no board init needed

```bash
export KANBAN_PROVIDER=jira
export JIRA_BASE_URL=https://your-domain.atlassian.net
export JIRA_EMAIL=you@example.com
export JIRA_API_TOKEN=...
export JIRA_PROJECT_KEY=ENG
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
