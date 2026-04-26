# Ubiquitous Language

Agent Kanban should use these terms in providers, APIs, tests, docs, and CLI output. Add to
this file before introducing a new public term.

| Term               | Definition                                                                                                                | Aliases to avoid                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Agent Kanban**   | Tracker provider and board cache used by agents and Garage Band.                                                          | garage-band, dispatch                                 |
| **Provider**       | Concrete tracker implementation: local, Linear, or Jira.                                                                  | adapter, backend                                      |
| **Task**           | Provider-normalized work item returned through the public API.                                                            | issue, ticket, card, unless translating provider APIs |
| **Column**         | Provider-normalized workflow state a task can move to.                                                                    | status, state, lane, unless translating provider APIs |
| **Cache**          | Local SQLite projection of provider data used for reads, dashboard, and reconciliation.                                   | source of truth                                       |
| **Webhook**        | Provider push event used as the fast path for cache updates.                                                              | sync, poll                                            |
| **Polling sync**   | Scheduled provider pull used to refresh normal task data.                                                                 | webhook repair                                        |
| **Full reconcile** | Periodic provider pull that repairs stale cache rows, deletions, and derived activity/history.                            | poll, webhook                                         |
| **Capability**     | Public feature bit exposed to callers and dashboards.                                                                     | implementation detail                                 |
| **Activity**       | User-visible activity surface exposed by the provider API. Internal provider history caches do not imply this capability. | history cache                                         |

## Relationships

- A **webhook** updates the **cache** quickly; **polling sync** keeps it fresh.
- **Full reconcile** is the repair path for stale rows, deletions, and derived history.
- Provider-specific API quirks stay inside **providers**; the normalized API returns **tasks**,
  **columns**, comments, metrics, and capabilities.
