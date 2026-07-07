# Testing and proof map

Use this page to choose the smallest useful proof before editing and the full
proof before handoff. The machine-readable source for factory intake is
[`../SPEC_CONTRACT.md`](../SPEC_CONTRACT.md).

| Change type                                                         | Required validation                    | Proof to attach                                                                                                   |
| ------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Cross-cutting TypeScript, lint, or public type changes              | `bun run check`                        | Passing lint and typecheck output.                                                                                |
| CLI command behavior                                                | `bun test` and `bun run build`         | Passing tests plus CLI bundle build.                                                                              |
| Local provider, SQLite, Postgres, Linear, or Jira provider behavior | `bun test`                             | Passing provider/storage tests; include `DATABASE_URL=... bun test` when the change depends on Postgres behavior. |
| HTTP API, server lifecycle, tunnel, or webhook behavior             | `bun test`                             | Passing API/server/webhook/tunnel tests with the relevant test names in the handoff.                              |
| MCP behavior                                                        | `bun test`                             | Passing MCP core/server tests.                                                                                    |
| Dashboard UI behavior                                               | `bun run check` and `bun run ui:build` | Passing UI typecheck/build; visual or interaction claims still need human review until browser e2e exists.        |
| Package or release surface                                          | `bun run build` and `bun run ui:build` | CLI bundle and dashboard artifact build. Release publishing stays CI-owned.                                       |

## Postgres tests

CI starts Postgres 17 and sets:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/kanban_test
```

Without `DATABASE_URL`, Postgres-specific suites may not exercise the same
coverage as CI. Treat a local no-database run as useful but not a substitute for
CI when the change touches Postgres storage or cache behavior.

## Human-gated proof

Dashboard layout, interaction feel, and visual regressions are human-gated until
the repo has a browser e2e or screenshot-diff command. A green build proves the
assets compile; it does not prove the UI is correct.
