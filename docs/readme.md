# Documentation

This directory holds the longer-form project guides that support the main
[`README.md`](../README.md).

## Start here

- [`workflow.md`](./workflow.md): a common day-to-day workflow for running the
  board locally or against Linear/Jira and moving work through it
- [`mcp.md`](./mcp.md): the reusable tracker MCP module, the bundled
  `kanban mcp` entrypoint, and the current integration caveats
- [`providers/jira.md`](./providers/jira.md): how the Jira provider works,
  including comments, webhooks, transitions, and current limits
- [`providers/linear.md`](./providers/linear.md): how the Linear provider works,
  including comments, webhooks, and intentionally unsupported behavior

## Doc layout

- Keep the root [`README.md`](../README.md) focused on install, core commands,
  and quick navigation.
- Keep contributor policy docs at the repo root:
  [`CONTRIBUTING.md`](../CONTRIBUTING.md),
  [`CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md), and
  [`SECURITY.md`](../SECURITY.md).
- Keep agent-specific repo instructions in [`SKILL.md`](../SKILL.md), since
  tooling expects that file at the root.
