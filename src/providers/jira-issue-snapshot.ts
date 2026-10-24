import { providerUpstreamError } from './errors'

export interface JiraIssueSnapshot {
  id: string
  key: string
  summary: string
  descriptionText: string
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
