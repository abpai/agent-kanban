# Spec contract

Specs executed against this repo must meet this bar. A spec that promises a
proof not listed in the proof menu is invalid; extend the menu and the
validation surface behind it first.

## Quality bar

A spec is ready when it:

- Is self-contained: an agent with no prior context can execute it.
- Names the goal as user-visible behavior, not an implementation.
- Lists acceptance criteria that each map to a proof in the menu below.
- Names the files, commands, public interfaces, or providers it expects to
  touch, when known.
- States what is out of scope.
- States risk and taste constraints the agent must not trade away.
- Ends with an end-to-end verification step drawn from the proof menu.

## Proof menu

Each command belongs to a lane: the fast lane is the inner loop an agent runs
after normal edits, and the full lane is the gate for done. Done means the full
lane is green; a green fast lane never certifies done. `Sufficiency` marks
whether a passing run is enough evidence (`auto`) or the change still needs
human sign-off (`human-gate`).

Keep this table in the constrained proof-row format: fixed columns in the order
below; `Lane` is only `fast` or `full`; `Validation command` contains only
backtick-wrapped command IDs from `package.json` scripts. Run them through Bun as
shown in [`engineering/commands.md`](./engineering/commands.md).

| Change type                                             | Lane | Validation command                | Proof artifact                                                                                   | Sufficiency |
| ------------------------------------------------------- | ---- | --------------------------------- | ------------------------------------------------------------------------------------------------ | ----------- |
| Cross-cutting lint, TypeScript, or public type changes  | fast | `check`                           | passing lint, root typecheck, and UI typecheck output                                            | auto        |
| CLI command behavior                                    | full | `test` `build`                    | passing command tests plus CLI bundle build                                                      | auto        |
| Provider, storage, sync, or cache behavior              | full | `test`                            | passing provider/storage tests; Postgres-sensitive changes include a run with `DATABASE_URL` set | auto        |
| HTTP API, server lifecycle, tunnel, or webhook behavior | full | `test`                            | passing API/server/webhook/tunnel tests with relevant test names                                 | auto        |
| MCP behavior                                            | full | `test`                            | passing MCP core/server tests                                                                    | auto        |
| Dashboard UI behavior                                   | full | `check` `ui:build`                | passing UI typecheck/build plus human review for visual or interaction claims                    | human-gate  |
| Package build or release-surface behavior               | full | `build` `ui:build`                | CLI bundle and dashboard artifact build; publishing remains CI-owned                             | auto        |
| Whole-repo handoff                                      | full | `check` `test` `build` `ui:build` | local CI-equivalent lane, with Postgres caveat called out when relevant                          | auto        |

## Escalation boundaries

Agents stop and surface instead of guessing when:

- An acceptance criterion cannot be proven with the proof menu above.
- The change requires an irreversible action: publish, release, deploy, data
  deletion, migration apply, or a shared remote tracker mutation outside the
  requested task.
- The spec requires real Linear, Jira, npm, GitHub Pages, or tunnel credentials
  that are not already available in the task environment.
- The spec's scope and the code's reality conflict.
- Dashboard visual correctness is part of done and no human review or browser
  e2e proof is available.

Prefer reversibility by construction: use local SQLite temp paths, test
databases, provider mocks/fakes, CI-owned release automation, and small
reviewable changes. A documented rollback path is the fallback, not the first
choice.
