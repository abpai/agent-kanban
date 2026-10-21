---
'@andypai/agent-kanban': minor
---

Add attachment reads to the CLI and MCP. `kanban task attachments <id>` lists attachment metadata, and `kanban task attachment get <id> <name-or-attachment-id> [-o <path>] [--max-bytes <n>]` writes one attachment to a file (the attachment's filename in the current directory by default, never replacing an existing file) and prints the metadata and written path; `-o -` sends the bytes to stdout and the envelope to stderr. MCP gains `listAttachments` and `getAttachment` (base64 content, 10 MiB default limit). Providers without the `attachments` capability (local, Linear) return `UNSUPPORTED_OPERATION`. MCP now maps `INVALID_ARGUMENT`, `NOT_FOUND` and `ATTACHMENT_REFUSED` to `validation_failed` instead of `internal_error`.
