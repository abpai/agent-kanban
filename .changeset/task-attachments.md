---
'@andypai/agent-kanban': minor
---

Add task attachments to the provider contract: `listAttachments` and `readAttachment` on every provider, a `TaskAttachment` type, and an `attachments` capability. Jira lists an issue's attachments live and downloads one from the Jira origin only, with a caller-named byte limit and a deadline that grows one second per MiB; a redirect, an oversized body, or a size mismatch is the new `ATTACHMENT_REFUSED` error, and an id outside the issue is `NOT_FOUND`. Local and Linear advertise `attachments: false` and throw `UNSUPPORTED_OPERATION`.
