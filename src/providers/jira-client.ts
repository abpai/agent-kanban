import { Buffer } from 'node:buffer'
import { ErrorCode } from '../errors'
import { providerUpstreamError } from './errors'

export interface JiraProject {
  id: string
  key: string
  name: string
}

export interface JiraBoardConfiguration {
  id: number
  name: string
  columnConfig: {
    columns: Array<{ name: string; statuses: Array<{ id: string }> }>
  }
}

export interface JiraProjectStatusCategory {
  id: string
  name: string
  statuses: Array<{
    id: string
    name: string
    statusCategory?: { key?: string }
  }>
}

export interface JiraIssue {
  id: string
  key: string
  fields: {
    summary: string
    description?: unknown
    status: { id: string; name: string }
    issuetype: { id: string; name: string }
    priority?: { id: string; name: string } | null
    assignee?: { accountId: string; displayName?: string | null } | null
    labels?: string[]
    comment?: { total?: number } | null
    created: string
    updated: string
    project?: { id: string; key: string }
  }
}

export interface JiraSearchPage {
  // The legacy /rest/api/3/search endpoint returned startAt/maxResults/total.
  // The current /rest/api/3/search/jql endpoint omits `total` and paginates by
  // an opaque `nextPageToken` (with `isLast`), so these are optional now.
  startAt?: number
  maxResults?: number
  total?: number
  nextPageToken?: string
  isLast?: boolean
  issues: JiraIssue[]
}

export interface JiraPaginationDecision {
  // When set, advance the scan to this cursor. When absent, the scan is over and
  // `complete` says whether it ended definitively (safe to prune against the
  // accumulated issue set) or was cut short (must NOT prune — issues on unfetched
  // pages would be wrongly deleted).
  nextToken?: string
  complete: boolean
}

// Decide how a `/rest/api/3/search/jql` cursor scan should proceed after a page.
// The endpoint signals continuation with `isLast`/`nextPageToken`, but real and
// degraded servers vary, so termination must be conservative: a scan is reported
// `complete` (safe to prune against the accumulated issue set) ONLY when the
// server proves the end, never from a page-size guess.
//   - usable cursor (fresh `nextPageToken`, isLast !== true) → advance.
//   - isLast === true                                        → definitive end (complete).
//   - isLast === false                                       → more pages exist; if the
//                                                              cursor is missing/stale we
//                                                              cannot fetch them, so the
//                                                              scan is incomplete.
//   - isLast absent, `total` present                         → legacy total/startAt proof:
//                                                              complete once startAt+count
//                                                              reaches `total`.
//   - isLast absent, no `total`, no usable cursor            → NO completeness proof. A
//                                                              short/empty page must NOT be
//                                                              read as "the end": a degraded
//                                                              `{ issues: [] }` would then
//                                                              prune the entire cache on a
//                                                              full reconcile. Treat as
//                                                              incomplete and retry instead.
// A cursor already in `seenPageTokens` counts as not usable (a stalled cursor
// that would otherwise loop forever).
export function decideJiraPagination(
  page: Pick<JiraSearchPage, 'isLast' | 'nextPageToken' | 'issues' | 'total' | 'startAt'>,
  seenPageTokens: ReadonlySet<string>,
): JiraPaginationDecision {
  const token = page.nextPageToken
  const canAdvance = !!token && page.isLast !== true && !seenPageTokens.has(token)
  if (canAdvance) return { nextToken: token, complete: false }
  if (page.isLast === true) return { complete: true }
  if (page.isLast === false) return { complete: false }
  // isLast absent below. Prefer the legacy total/startAt signal when a
  // (non-standard) server supplies it: complete once we have fetched everything
  // `total` promises. The live /search/jql endpoint omits `total` and ignores
  // `startAt`, so the loop never advances by offset — a `total` promising more
  // than this page is reported incomplete rather than fetched.
  if (typeof page.total === 'number') {
    const issueCount = page.issues?.length ?? 0
    return { complete: (page.startAt ?? 0) + issueCount >= page.total }
  }
  // No completeness signal at all (no isLast, no total, no usable cursor). We
  // cannot prove the scan reached the end, so never guess `complete` from page
  // size — that would prune the whole cache on a degraded short/empty response.
  return { complete: false }
}

export interface JiraCreatePayload {
  fields: Record<string, unknown>
}

export interface JiraUpdatePayload {
  fields?: Record<string, unknown>
  update?: Record<string, unknown>
}

export interface JiraCommentPayload {
  body: unknown
}

export interface JiraComment {
  id: string
  body?: unknown
  created?: string
  updated?: string
  author?: { accountId?: string; displayName?: string }
}

export interface JiraCommentPage {
  startAt: number
  maxResults: number
  total: number
  comments: JiraComment[]
}

export interface JiraCreatedIssueRef {
  id: string
  key: string
  self: string
}

export interface JiraTransition {
  id: string
  name: string
  to: { id: string; name: string }
}

export interface JiraUser {
  accountId: string
  displayName: string
  active?: boolean
}

export interface JiraPriority {
  id: string
  name: string
}

export interface JiraIssueType {
  id: string
  name: string
}

export interface JiraChangelogItem {
  field: string
  fieldtype?: string
  fromString?: string | null
  toString?: string | null
  from?: string | null
  to?: string | null
}

export interface JiraChangelogEntry {
  id: string
  author?: { accountId?: string; displayName?: string }
  created: string
  items: JiraChangelogItem[]
}

export interface JiraChangelogPage {
  startAt: number
  maxResults: number
  total: number
  isLast?: boolean
  values: JiraChangelogEntry[]
}

interface JiraErrorBody {
  errorMessages?: string[]
  errors?: Record<string, string>
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'
type QueryParams = Record<string, string | number | undefined>

export interface JiraClientOptions {
  baseUrl: string
  email: string
  apiToken: string
}

export class JiraClient {
  private readonly baseUrl: string
  private readonly authHeader: string

  constructor(opts: JiraClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    const encoded = Buffer.from(`${opts.email}:${opts.apiToken}`).toString('base64')
    this.authHeader = `Basic ${encoded}`
  }

  private async request<TBody, TResponse>(
    method: HttpMethod,
    path: string,
    body?: TBody,
    query?: QueryParams,
  ): Promise<TResponse> {
    let url = `${this.baseUrl}${path}`
    if (query) {
      const params = new URLSearchParams()
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined) continue
        params.append(k, String(v))
      }
      const qs = params.toString()
      if (qs.length > 0) url += `?${qs}`
    }

    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    }

    const init: RequestInit = { method, headers }
    if (body !== undefined) {
      init.body = JSON.stringify(body)
    }

    const response = await fetch(url, init)

    if (response.status === 401 || response.status === 403) {
      providerUpstreamError('Jira authentication failed', ErrorCode.PROVIDER_AUTH_FAILED)
    }
    if (response.status === 429) {
      providerUpstreamError('Jira API rate limit exceeded', ErrorCode.PROVIDER_RATE_LIMITED)
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      let parsed: JiraErrorBody = {}
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text) as JiraErrorBody
        } catch {
          parsed = {}
        }
      }
      const parts: string[] = []
      if (parsed.errorMessages && parsed.errorMessages.length > 0) {
        parts.push(parsed.errorMessages.join('; '))
      }
      if (parsed.errors && Object.keys(parsed.errors).length > 0) {
        const entries = Object.entries(parsed.errors)
          .map(([k, v]) => `${k}: ${v}`)
          .join('; ')
        parts.push(entries)
      }
      const message =
        parts.length > 0 ? parts.join(' | ') : `Jira API request failed with ${response.status}`
      providerUpstreamError(message)
    }

    if (response.status === 204) {
      return undefined as TResponse
    }
    const contentLength = response.headers.get('content-length')
    if (contentLength === '0') {
      return undefined as TResponse
    }
    const text = await response.text()
    if (text.length === 0) {
      return undefined as TResponse
    }
    return JSON.parse(text) as TResponse
  }

  getProject(key: string): Promise<JiraProject> {
    return this.request<never, JiraProject>('GET', `/rest/api/3/project/${encodeURIComponent(key)}`)
  }

  getBoardColumns(boardId: number): Promise<JiraBoardConfiguration> {
    return this.request<never, JiraBoardConfiguration>(
      'GET',
      `/rest/agile/1.0/board/${boardId}/configuration`,
    )
  }

  getProjectStatuses(projectKey: string): Promise<JiraProjectStatusCategory[]> {
    return this.request<never, JiraProjectStatusCategory[]>(
      'GET',
      `/rest/api/3/project/${encodeURIComponent(projectKey)}/statuses`,
    )
  }

  listIssues(params: {
    jql: string
    startAt: number
    maxResults: number
    fields?: string[]
    nextPageToken?: string
  }): Promise<JiraSearchPage> {
    const query: QueryParams = {
      jql: params.jql,
      maxResults: params.maxResults,
    }
    // /rest/api/3/search/jql ignores startAt and paginates by nextPageToken.
    // Send the cursor when we have one; only send startAt on the first page for
    // back-compat with the legacy endpoint.
    if (params.nextPageToken) query.nextPageToken = params.nextPageToken
    else query.startAt = params.startAt
    if (params.fields && params.fields.length > 0) {
      query.fields = params.fields.join(',')
    }
    return this.request<never, JiraSearchPage>('GET', '/rest/api/3/search/jql', undefined, query)
  }

  getIssue(idOrKey: string): Promise<JiraIssue> {
    return this.request<never, JiraIssue>('GET', `/rest/api/3/issue/${encodeURIComponent(idOrKey)}`)
  }

  createIssue(payload: JiraCreatePayload): Promise<JiraCreatedIssueRef> {
    return this.request<JiraCreatePayload, JiraCreatedIssueRef>(
      'POST',
      '/rest/api/3/issue',
      payload,
    )
  }

  updateIssue(idOrKey: string, payload: JiraUpdatePayload): Promise<void> {
    return this.request<JiraUpdatePayload, void>(
      'PUT',
      `/rest/api/3/issue/${encodeURIComponent(idOrKey)}`,
      payload,
    )
  }

  addComment(idOrKey: string, payload: JiraCommentPayload): Promise<JiraComment> {
    return this.request<JiraCommentPayload, JiraComment>(
      'POST',
      `/rest/api/3/issue/${encodeURIComponent(idOrKey)}/comment`,
      payload,
    )
  }

  getComments(
    idOrKey: string,
    params: { startAt?: number; maxResults?: number } = {},
  ): Promise<JiraCommentPage> {
    const query: QueryParams = {}
    if (params.startAt !== undefined) query.startAt = params.startAt
    if (params.maxResults !== undefined) query.maxResults = params.maxResults
    return this.request<never, JiraCommentPage>(
      'GET',
      `/rest/api/3/issue/${encodeURIComponent(idOrKey)}/comment`,
      undefined,
      query,
    )
  }

  getComment(idOrKey: string, commentId: string): Promise<JiraComment> {
    return this.request<never, JiraComment>(
      'GET',
      `/rest/api/3/issue/${encodeURIComponent(idOrKey)}/comment/${encodeURIComponent(commentId)}`,
    )
  }

  updateComment(
    idOrKey: string,
    commentId: string,
    payload: JiraCommentPayload,
  ): Promise<JiraComment> {
    return this.request<JiraCommentPayload, JiraComment>(
      'PUT',
      `/rest/api/3/issue/${encodeURIComponent(idOrKey)}/comment/${encodeURIComponent(commentId)}`,
      payload,
    )
  }

  getChangelog(
    idOrKey: string,
    params: { startAt?: number; maxResults?: number } = {},
  ): Promise<JiraChangelogPage> {
    const query: QueryParams = {}
    if (params.startAt !== undefined) query.startAt = params.startAt
    if (params.maxResults !== undefined) query.maxResults = params.maxResults
    return this.request<never, JiraChangelogPage>(
      'GET',
      `/rest/api/3/issue/${encodeURIComponent(idOrKey)}/changelog`,
      undefined,
      query,
    )
  }

  getTransitions(idOrKey: string): Promise<{ transitions: JiraTransition[] }> {
    return this.request<never, { transitions: JiraTransition[] }>(
      'GET',
      `/rest/api/3/issue/${encodeURIComponent(idOrKey)}/transitions`,
    )
  }

  transitionIssue(
    idOrKey: string,
    transitionId: string,
    fields?: Record<string, unknown>,
  ): Promise<void> {
    const body: { transition: { id: string }; fields?: Record<string, unknown> } = {
      transition: { id: transitionId },
    }
    if (fields !== undefined) body.fields = fields
    return this.request<typeof body, void>(
      'POST',
      `/rest/api/3/issue/${encodeURIComponent(idOrKey)}/transitions`,
      body,
    )
  }

  listAssignableUsers(params: {
    projectKey: string
    startAt: number
    maxResults: number
  }): Promise<JiraUser[]> {
    return this.request<never, JiraUser[]>('GET', '/rest/api/3/user/assignable/search', undefined, {
      project: params.projectKey,
      startAt: params.startAt,
      maxResults: params.maxResults,
    })
  }

  listPriorities(): Promise<JiraPriority[]> {
    return this.request<never, JiraPriority[]>('GET', '/rest/api/3/priority')
  }

  listIssueTypes(params: { projectId: string }): Promise<JiraIssueType[]> {
    return this.request<never, JiraIssueType[]>('GET', '/rest/api/3/issuetype/project', undefined, {
      projectId: params.projectId,
    })
  }
}

export function normalizeJiraLabels(labels: string[] | undefined): string[] {
  return (labels ?? []).map((label) => label.trim()).filter(Boolean)
}
