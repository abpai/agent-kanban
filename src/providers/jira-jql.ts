import { ErrorCode, KanbanError } from '../errors'

// Jira project keys are alphanumeric with underscores (the API-canonical key,
// e.g. `ENG`). Anything else would be malformed and, interpolated into JQL,
// could break out of the query.
const PROJECT_KEY_RE = /^[A-Za-z0-9_]+$/

// JQL datetime literals contain only digits and date/time separators. This
// covers both the space form (`1970-01-01 00:00`) and the ISO forms Jira
// returns in `issue.fields.updated` (`2026-01-05T00:00:00Z`, `...+0000`). A
// double quote, backslash, or any JQL operator/keyword cannot match, so a
// tampered `updated` value (e.g. delivered via webhook) cannot escape the
// quoted literal.
const JQL_TIMESTAMP_RE = /^[0-9 :.\-TZ+]+$/

const DEFAULT_SINCE = '1970-01-01 00:00'

export function assertSafeProjectKey(key: string): string {
  if (!PROJECT_KEY_RE.test(key)) {
    throw new KanbanError(
      ErrorCode.PROVIDER_NOT_CONFIGURED,
      `Invalid Jira project key ${JSON.stringify(key)}: expected alphanumeric characters only`,
    )
  }
  return key
}

/**
 * Return the cursor only if it's a safe JQL datetime literal, else null. Callers
 * use this both to build the JQL and to seed `newestUpdatedAt`, so a rejected
 * cursor is never carried forward and re-persisted (which would otherwise trap
 * every future sync into a full scan).
 */
export function safeDeltaSince(since: string | null): string | null {
  if (since === null) return null
  return JQL_TIMESTAMP_RE.test(since) ? since : null
}

/**
 * Build the delta-sync JQL with both interpolated values validated. An invalid
 * `since` (only possible if a persisted/upstream timestamp was tampered with)
 * falls back to a full scan rather than risking injection.
 */
export function buildDeltaJql(projectKey: string, since: string | null): string {
  assertSafeProjectKey(projectKey)
  const sinceClause = safeDeltaSince(since) ?? DEFAULT_SINCE
  return `project = ${projectKey} AND updated >= "${sinceClause}" ORDER BY updated ASC`
}
