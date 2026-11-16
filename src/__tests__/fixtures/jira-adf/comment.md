[@Garage Planner](jira-mention:712020:9a8b7c) plan for this cycle:

1. Read `src/export/paginate.ts`
   - check the cursor math
     - off-by-one at `page * size`
2. Patch and add a regression test ([PR #812](https://github.com/acme/widget/pull/812))

```ts
const next = cursor + pageSize // was: cursor + pageSize + 1
```

**Risk:** low; *rollback* is a revert.
