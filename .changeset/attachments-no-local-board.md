---
'@andypai/agent-kanban': patch
---

Refuse `kanban task attachments` and `kanban task attachment get` before opening the board when the provider has no attachments (local, Linear). The refusal is unchanged (`UNSUPPORTED_OPERATION`), but it no longer creates `./.kanban/board.db` as a side effect.
