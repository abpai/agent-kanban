# Linear Integration

**Status: shipped**

## Summary

agent-kanban runs against either a local SQLite backend or Linear's GraphQL API. A `KanbanProvider` interface sits between the CLI/API/UI and the storage layer, so the rest of the codebase doesn't know which backend is active.

## Architecture

```text
Agents / CLI / UI
      |
      v
REST API (existing routes, thin adapter)
      |
      v
KanbanProvider
  |- LocalProvider  -> wraps db.ts/activity.ts/metrics.ts
  |- LinearProvider -> calls Linear GraphQL API
```

`KANBAN_PROVIDER` env var selects the backend at startup. Linear mode requires `LINEAR_API_KEY` and `LINEAR_TEAM_ID`.

## What shipped

Eight provider files in `src/providers/`:

| File               | Purpose                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `types.ts`         | `KanbanProvider` interface and shared DTOs                                                                      |
| `errors.ts`        | Provider-specific error constructors (`UNSUPPORTED_OPERATION`, `PROVIDER_AUTH_FAILED`, `PROVIDER_RATE_LIMITED`) |
| `capabilities.ts`  | Capability flags per provider                                                                                   |
| `index.ts`         | Factory — reads env vars, returns the right provider                                                            |
| `local.ts`         | `LocalProvider` — wraps existing SQLite logic                                                                   |
| `linear.ts`        | `LinearProvider` — implements the interface against Linear's API                                                |
| `linear-client.ts` | GraphQL client, query builders, response parsing                                                                |
| `linear-cache.ts`  | In-memory cache for workflow states and team metadata                                                           |

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

The CLI, API server, and web UI check capabilities before calling the provider. Unsupported operations return `UNSUPPORTED_OPERATION` (exit code 1). The UI hides actions the active provider can't do.

## API/Interface changes

Endpoint paths stayed the same. Internals switched from direct `db.ts` calls to `provider.methodName()`. Three error codes were added:

- `UNSUPPORTED_OPERATION` — capability not available in the active provider
- `PROVIDER_AUTH_FAILED` — bad or missing API key
- `PROVIDER_RATE_LIMITED` — Linear API rate limit hit

Linear tasks include `externalRef` (e.g. `TEAM-123`) and `url` in their response payloads. Commands accept either ID form.

## Test coverage

93 tests pass across 11 test files. Coverage includes:

- Provider contract tests against `LocalProvider`
- API integration tests in local mode (existing behavior parity)
- Live Linear testing performed manually (board view, task create/update/move, error paths)

## Current limitations

1. Single Linear team per instance
2. API key auth only (no OAuth)
3. No webhook sync — poll or manual refresh
4. Endpoint paths unchanged

## Future work

- Labels and comments sync across both providers
- Delete-as-archive in Linear mode
- Webhook-based real-time sync
- Multi-team support
