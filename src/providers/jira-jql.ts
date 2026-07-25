import { ErrorCode, KanbanError } from '../errors'

// Jira project keys are alphanumeric with underscores (the API-canonical key,
// e.g. `ENG`). Anything else would be malformed and, interpolated into JQL,
// could break out of the query.
const PROJECT_KEY_RE = /^[A-Za-z0-9_]+$/

// Jira returns `issue.fields.updated` as ISO-8601, but JQL's accepted datetime
// literal is the minute-precision `yyyy-MM-dd HH:mm` form. Passing the returned
// ISO value through unchanged is syntactically accepted by `/search/jql` but
// can silently match zero issues. Capture the returned wall-clock components
// so the JQL query uses the same account/site timezone Jira used in its
// response. Keeping minute precision also gives the delta an intentional
// overlap; the cache upsert and activity dedupe make repeated rows harmless.
const DELTA_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:T| )(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/

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
  return DELTA_TIMESTAMP_RE.test(since) ? since : null
}

/**
 * Build the delta-sync JQL with both interpolated values validated. An invalid
 * `since` (only possible if a persisted/upstream timestamp was tampered with)
 * falls back to a full scan rather than risking injection.
 */
export function buildDeltaJql(projectKey: string, since: string | null): string {
  assertSafeProjectKey(projectKey)
  const sinceClause = jiraJqlSince(safeDeltaSince(since)) ?? DEFAULT_SINCE
  return `project = ${projectKey} AND updated >= "${sinceClause}" ORDER BY updated ASC`
}

function jiraJqlSince(since: string | null): string | null {
  if (since === null) return null
  const match = DELTA_TIMESTAMP_RE.exec(since)
  if (match === null) return null
  return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}`
}
