# Move inline SQLite Jira cache lookup SQL into `jira-cache.ts`

Status: open — carried over from the 2026-06-10 provider-architecture triage
(item 14, the one item not yet shipped).

## Why this exists

The SQLite Jira adapter (`src/providers/jira.ts`) still issues cache lookup
queries inline as raw SQL strings, even though the rest of the Jira cache row
mapping and column resolution already live behind `src/providers/jira-cache.ts`.
Inline SQL in the adapter keeps a second place where the `jira_*` table shape is
encoded, which is exactly the duplication the triage set out to remove: a schema
change now has to be chased through both files, and the adapter's tests cannot
exercise the lookups without standing up the whole provider.

## Scope

In scope: the inline `SELECT` lookups in `src/providers/jira.ts` against the
SQLite Jira cache tables (`jira_issues`, `jira_priorities`, `jira_users`,
`jira_issue_types`) — currently around lines 143–191:

- distinct assignee names
- priority exact-match + priority list
- active user account-id by display name
- issue-type id by name + issue-type list
- issue id by id-or-key

Out of scope: the Postgres Jira cache (`postgres-jira*`), any behavior change to
what the lookups return, and the broader dialect-adapter question (still "later
design", not this spec).

## Start here

| Task                                                     | File                          |
| -------------------------------------------------------- | ----------------------------- |
| Read the inline lookups to relocate                      | `src/providers/jira.ts`       |
| Add the lookup helpers beside the existing cache mappers | `src/providers/jira-cache.ts` |
| Confirm the SQLite cache table shape the SQL assumes     | `src/providers/jira-cache.ts` |
| Update adapter call sites to use the new helpers         | `src/providers/jira.ts`       |

## Invariants

- Lookups return the same rows/shape they do today (behavior-preserving refactor;
  no query semantics change).
- All `jira_*` table names and column references live in `jira-cache.ts`, not in
  the adapter, after this lands.
- The Postgres Jira path is untouched.

## Validation

| Change type                              | Lane | Command   | Proof                                      |
| ---------------------------------------- | ---- | --------- | ------------------------------------------ |
| Provider/cache behavior (SQLite lookups) | full | `test`    | passing Jira provider/cache suites         |
| Cross-cutting types/lint                 | fast | `check`   | passing lint + root/UI typecheck           |
| Postgres-sensitive regression guard      | full | `test:pg` | passing full suite with `DATABASE_URL` set |

## Close condition

Closed when no raw `jira_*` `SELECT` remains in `src/providers/jira.ts`, the
lookups are exercised through `jira-cache.ts`, and `check` + `test` (plus a
`test:pg` run) are green. Remove this file on close.
