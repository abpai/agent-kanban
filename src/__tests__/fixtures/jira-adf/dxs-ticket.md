## Context

The **subscriber export** drops rows when `batch_size` exceeds the page limit. See <https://fusionmedia.atlassian.net/browse/DXS-401> and the [runbook](https://wiki.example.com/runbooks/export?section=limits).

[@Dana Lee](jira-mention:557058:1f2e3d4c) owns the fix [:rocket:](jira-emoji:1f680) Status: [IN REVIEW](jira-status:blue)

### Acceptance criteria

- Export paginates every request
  - Page size comes from `EXPORT_PAGE_SIZE`
    1. Default **500**
    2. Hard cap **_2000_**
  - Retries are *idempotent*

    A second paragraph inside the item.
- - Item whose first child is a list
- Run the migration:
  ```bash
  bun run migrate --dry-run
  bun run migrate
  ```
- Legacy ~~CSV~~ export is <u>removed</u>

### Limits

| **Plan**   | **Rows per page**  |
| ---------- | ------------------ |
| Free       | `100 \| burst 150` |
| Enterprise |                    |

> Customer quote: *the export is missing half of March*

---

::: expand title="Reproduction \"steps\""
1. Create 2,001 subscribers
2. Export with the default settings

```json
{
  "rows": 2000,
  "expected": 2001
}
```
:::

- [x] Reproduce locally
- [ ] Ship the fix

Plain URL stays text: https://status.example.com\
Second line after a break, due [2025-11-16](jira-date:1763251200000)
