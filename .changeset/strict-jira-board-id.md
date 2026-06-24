---
'@andypai/agent-kanban': minor
---

Strict `JIRA_BOARD_ID` parsing (#79). A non-empty malformed `JIRA_BOARD_ID` now fails config loading with `INVALID_CONFIG` instead of being silently coerced into a plausible-but-wrong board id (`'12abc'` → 12, `'-5'` → -5, `'1e3'` → 1) or dropped. An unset or blank value still means "no board pinned", and a valid positive integer is used as before. This matches how a malformed `KANBAN_SYNC_INTERVAL_MS` is already rejected.

**Behavior change:** if `JIRA_BOARD_ID` is set to a non-numeric or non-positive value, config loading now errors instead of silently ignoring it. Set a valid board id or unset the variable.
