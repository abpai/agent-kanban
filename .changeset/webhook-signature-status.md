---
'@andypai/agent-kanban': minor
---

Persist the Jira webhook signature verdict on receipts. `WebhookResult` gains
an optional `signatureStatus` (`valid | invalid | missing | not_configured`),
the Jira provider attaches it to every webhook outcome (verification itself is
unchanged), and `withWebhookRecording` persists it into the `webhook_events`
`detail` JSON — so audit consumers can render a true verdict instead of
guessing from configuration.
