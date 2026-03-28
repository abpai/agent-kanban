# Common Workflow

This guide shows a typical workflow for using `agent-kanban` as a lightweight
project board from the terminal, with the dashboard available when you want a
visual pass.

## 1. Set up the board

For local mode, initialize the board once:

```bash
kanban board init
kanban config set-member Alex --role human
kanban config set-member BuildBot --role agent
kanban config add-project website-redesign
```

If you are using Linear instead, point the CLI at your team and skip local board
initialization:

```bash
export KANBAN_PROVIDER=linear
export LINEAR_API_KEY=lin_api_...
export LINEAR_TEAM_ID=<team-id>
kanban board view
```

## 2. Capture incoming work

Create tasks with enough structure that an agent or script can act on them
without guessing:

```bash
kanban task add "Ship landing page hero" \
  -d "Finalize layout, copy, and CTA behavior" \
  -c backlog \
  -p high \
  -a BuildBot \
  --project website-redesign \
  -m '{"area":"marketing","estimate":"medium"}'
```

For automation, capture the ID from the JSON envelope:

```bash
task_id=$(kanban task add "Audit signup funnel" --project website-redesign | jq -r '.data.id')
kanban task view "$task_id"
```

## 3. Plan the next slice

Review the board and narrow to the next tasks worth pulling:

```bash
kanban board view --pretty
kanban task list -c backlog --sort priority -l 10
kanban task list -a BuildBot --project website-redesign
```

A simple rhythm that works well:

1. Keep `backlog` for unscheduled work.
2. Move only a small number of tasks into `in-progress`.
3. Use `review` as the handoff point between implementation and verification.
4. Move tasks to `done` only when the change is merged or otherwise complete.

## 4. Move work through the board

As work advances, update the task instead of creating duplicate status notes:

```bash
kanban task move "$task_id" in-progress
kanban task update "$task_id" -a Alex -p urgent
kanban task move "$task_id" review
kanban task move "$task_id" done
```

Useful shortcuts:

```bash
kanban task assign "$task_id" Alex
kanban task prioritize "$task_id" high
```

## 5. Review and clean up

At the end of a work cycle, confirm what changed and clear finished work when it
makes sense for your provider:

```bash
kanban task list -c review
kanban task list -c done
kanban bulk clear-done
```

`bulk clear-done` is local-provider only. In Linear mode, keep the issue in
Linear and rely on workflow state there.

## 6. Open the dashboard when needed

The CLI is the primary interface, but the dashboard is handy for scanning board
state and watching updates:

```bash
kanban serve
```

Then open `http://localhost:3000`.

The server exposes:

- `/api/*` for the same board operations used by the CLI
- `/ws` for refresh notifications after mutations
- `/api/health` for a simple health check

## Practical tips

- Prefer default JSON output when another tool or agent will consume the result.
- Use `--pretty` only when a human is reading the terminal output directly.
- In Linear mode, task commands can use either the internal ID or the issue ref,
  such as `TEAM-123`.
- If you rely on the local provider, let the database live in a directory volume,
  not a single-file mount, because SQLite WAL mode creates sibling files.
