# Validate HTTP input shapes before provider calls

`src/api.ts` currently checks JSON syntax, then treats the body as the route's
provider input type. Required-field checks and provider validation cover only
part of that contract. For example, a numeric task title or comment body reaches
SQLite and is coerced to text. The type assertion is an explicit local lint
exception until this boundary is decoded fully.

Add request schemas or decoders for task create/update/move, comment
create/update, and config patches. Preserve documented normalization and error
codes for valid requests and already-covered invalid inputs. Reject malformed
field types with the normal API error envelope before any provider mutation.
Cover numeric/null/object fields, arrays, missing required fields, labels and
config members/projects in API tests; finish with the full validation lane and
Postgres parity proof from `docs/engineering/commands.md`.
