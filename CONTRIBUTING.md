# Contributing

Thanks for helping improve `agent-kanban`.

## Before You Start

- Search existing issues and pull requests before opening a new one.
- Prefer small, focused changes over large mixed refactors.
- If your change affects behavior, update tests and the relevant docs in the same PR.

## Local Setup

```bash
git clone https://github.com/abpai/agent-kanban.git
cd agent-kanban
bun install
cd ui && bun install && cd ..
bun link
```

## Common Commands

```bash
bun run check
bun test
bun run build
bun run ui:build
bun run serve
```

The web dashboard expects `ui/dist` to exist for packaged and local server runs.

## Development Guidelines

- Keep the default CLI output stable and machine-readable.
- Preserve Bun-first workflows unless there is a strong reason to expand runtime support.
- Avoid committing secrets or local env files. Only `.env.example` should be tracked.
- If you add a new config variable, update `.env.example` and the README in the same change.
- If you touch provider behavior, call out any local-vs-Linear differences in docs or tests.

## Pull Requests

- Explain the user-facing change and why it is needed.
- Include verification notes with the commands you ran.
- Add screenshots or terminal output when UI/UX changes are relevant.
- Keep generated noise out of the diff.

## Reporting Bugs

When filing a bug, include:

- The command you ran
- Expected behavior
- Actual behavior
- Relevant stdout/stderr output
- Provider mode (`local` or `linear`)
- Bun version and OS when relevant
