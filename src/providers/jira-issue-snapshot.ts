import { providerUpstreamError } from './errors'

export interface JiraIssueSnapshot {
  id: string
  key: string
  summary: string
  descriptionText: string
  /** `sha256:<hex>` of the raw ADF description; null when there is none. */
  descriptionHash?: string | null
  statusId: string
  priorityName?: string | null
  issueTypeName?: string | null
  assigneeAccountId?: string | null
  assigneeName?: string | null
  labels?: string[] | null
  commentCount?: number | null
  projectKey: string
  url?: string | null
  createdAt: string
  updatedAt: string
}

export interface JiraIssueWriteOptions {
  /** Only GET /issue readback can resolve a conflicting equal-version snapshot. */
  authoritative?: boolean
}

/** The span of Jira `updated` stamps a full reconcile ran across, widened for clock skew. */
export interface JiraScanWindow {
  from: string
  to: string
}

/**
 * Whether a cached row changed while a full reconcile ran, so it may be missing from pages
 * fetched before the change and must not be pruned. An unreadable stamp, or one outside the
 * window, means no.
 */
export function changedDuringScan(updatedAt: string, scan: JiraScanWindow): boolean {
  const at = parseJiraStamp(updatedAt)
  return at >= Date.parse(scan.from) && at <= Date.parse(scan.to)
}

const JIRA_STAMP =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/

/** Epoch ms of a Jira `updated` stamp, or NaN unless it names a real calendar date and time. */
function parseJiraStamp(value: string): number {
  const match = JIRA_STAMP.exec(value)
  if (match === null) return Number.NaN
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  // Date.parse rolls an impossible day (Feb 30) into the next month; refuse it instead.
  const calendar = new Date(Date.UTC(year, month - 1, day))
  if (calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return Number.NaN
  return Date.parse(value)
}

export function prepareJiraIssueSnapshots(issues: JiraIssueSnapshot[]) {
  const newest = new Map<string, JiraIssueSnapshot>()
  const conflicts = new Set<string>()
  for (const issue of issues) {
    const time = Date.parse(issue.updatedAt)
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})$/.test(
        issue.updatedAt,
      ) ||
      !Number.isFinite(time)
    )
      providerUpstreamError('Jira task has an invalid updated timestamp.')
    const previous = newest.get(issue.id)
    if (!previous || time > Date.parse(previous.updatedAt)) {
      newest.set(issue.id, issue)
      conflicts.delete(issue.id)
    } else if (
      time === Date.parse(previous.updatedAt) &&
      snapshotContent(previous) !== snapshotContent(issue)
    ) {
      conflicts.add(issue.id)
    }
  }
  return {
    issues: [...newest.values()],
    conflicts: [...conflicts].map((id) => newest.get(id)!.key),
  }
}

function snapshotContent(issue: JiraIssueSnapshot): string {
  return JSON.stringify([
    issue.key,
    issue.summary,
    issue.descriptionText,
    issue.descriptionHash ?? null,
    issue.statusId,
    issue.priorityName ?? '',
    issue.issueTypeName ?? '',
    issue.assigneeAccountId ?? null,
    issue.assigneeName ?? '',
    issue.labels ?? [],
    issue.commentCount ?? 0,
    issue.projectKey,
    issue.url ?? null,
  ])
}
