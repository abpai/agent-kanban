---
'@andypai/agent-kanban': patch
---

Reduce repeated Jira changelog requests for unchanged tasks and honor Retry-After cooldowns across requests in one client. Failed activity reads remain retryable and periodic activity repair remains enabled.
