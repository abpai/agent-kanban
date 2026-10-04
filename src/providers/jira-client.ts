import { Buffer } from 'node:buffer'
import { ErrorCode, type ErrorCodeValue } from '../errors'
import type { JsonObject } from '../json'
import { providerUpstreamError } from './errors'
import { providerRequest, resolveProviderRequestTimeoutMs } from './request'
import type { AdfDocument } from './jira-adf'

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
    description?: AdfDocument | string | null
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
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- A malformed upstream total must never authorize deleting cached issues.
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
  fields: JsonObject
}

export interface JiraUpdatePayload {
  fields?: JsonObject
  update?: JsonObject
}

export interface JiraCommentPayload {
  body: AdfDocument
}

export interface JiraComment {
  id: string
  body?: AdfDocument | string | null
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

/** One entry of an issue's `attachment` field. */
export interface JiraAttachment {
  id: string
  filename: string
  mimeType?: string | null
  size: number
  created?: string
  author?: { accountId?: string; displayName?: string }
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

interface JiraChangelogItem {
  field: string
  fieldtype?: string
  fromString?: string | null
  toString?: string | null
  from?: string | null
  to?: string | null
}

interface JiraChangelogEntry {
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
  requestTimeoutMs?: number
}

const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000

/** Resolves a Retry-After header (delta-seconds or HTTP date) to an epoch-ms deadline. */
export function retryAfterDeadline(header: string | null, now: number): number {
  const value = header?.trim()
  if (value) {
    if (/^\d+$/.test(value)) return now + Number(value) * 1000
    // HTTP dates start with a day name; this keeps Date.parse away from inputs like '-5'.
    const date = /^[a-z]/i.test(value) ? Date.parse(value) : NaN
    if (Number.isFinite(date)) return date
  }
  return now + DEFAULT_RATE_LIMIT_COOLDOWN_MS
}

const MIB = 1024 * 1024
// An error body only feeds the message; anything past this is dropped unread.
const MAX_ERROR_BODY_BYTES = 64 * 1024

/** One deadline covers headers and body, so a download gets 1 s per MiB on top of the request deadline. */
export function attachmentDownloadTimeoutMs(requestTimeoutMs: number, maxBytes: number): number {
  return requestTimeoutMs + Math.ceil(maxBytes / MIB) * 1000
}

function isRedirect(response: Response): boolean {
  return response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** Reads the whole body, or cancels it and calls `overflow` the moment it passes `maxBytes`. */
async function readBoundedBody(
  response: Response,
  maxBytes: number,
  overflow: () => never,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      overflow()
    }
    chunks.push(value)
  }
  return concatChunks(chunks, total)
}

/** Reads at most `maxBytes` of text and cancels the rest; the result may be cut mid-character. */
async function readTextUpTo(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (total < maxBytes) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.byteLength
  }
  if (total >= maxBytes) await reader.cancel().catch(() => undefined)
  return new TextDecoder().decode(concatChunks(chunks, total).subarray(0, maxBytes))
}

export class JiraClient {
  private readonly baseUrl: string
  private readonly authHeader: string
  private readonly requestTimeoutMs: number
  private retryAt = 0

  constructor(opts: JiraClientOptions) {
    this.requestTimeoutMs = resolveProviderRequestTimeoutMs(opts.requestTimeoutMs)
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    const encoded = Buffer.from(`${opts.email}:${opts.apiToken}`).toString('base64')
    this.authHeader = `Basic ${encoded}`
  }

  private assertNotCoolingDown(): void {
    if (Date.now() < this.retryAt) {
      providerUpstreamError(
        'Jira API rate limit cooldown is active',
        ErrorCode.PROVIDER_RATE_LIMITED,
      )
    }
  }

  /** Shared 401/403/429 handling; a 429 starts the client-wide cooldown. */
  private rejectAuthOrRateLimit(response: Response): void {
    if (response.status === 401 || response.status === 403) {
      providerUpstreamError('Jira authentication failed', ErrorCode.PROVIDER_AUTH_FAILED)
    }
    if (response.status === 429) {
      // Later calls on this client fail fast until the deadline; nothing is replayed.
      this.retryAt = Math.max(
        this.retryAt,
        retryAfterDeadline(response.headers.get('retry-after'), Date.now()),
      )
      providerUpstreamError('Jira API rate limit exceeded', ErrorCode.PROVIDER_RATE_LIMITED)
    }
  }

  private async rejectFailure(response: Response): Promise<never> {
    const text = await readTextUpTo(response, MAX_ERROR_BODY_BYTES).catch(() => '')
    let parsed: JiraErrorBody = {}
    if (text.length > 0) {
      try {
        // SAFETY: Jira's error response contract supplies message strings and field errors;
        // malformed JSON falls back to the HTTP status message below.
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

  private async request<TBody, TResponse>(
    method: HttpMethod,
    path: string,
    body?: TBody,
    query?: QueryParams,
    // When set, the request never follows a redirect and a 3xx fails with this code.
    options: { refuseRedirectsAs?: ErrorCodeValue } = {},
  ): Promise<TResponse> {
    this.assertNotCoolingDown()
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

    const headers = {
      Authorization: this.authHeader,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    }

    const init: RequestInit = { method, headers }
    if (body !== undefined) {
      init.body = JSON.stringify(body)
    }
    const { refuseRedirectsAs } = options
    if (refuseRedirectsAs) init.redirect = 'manual'

    return providerRequest(
      'Jira',
      url,
      init,
      async (response) => {
        this.rejectAuthOrRateLimit(response)
        if (refuseRedirectsAs && isRedirect(response)) {
          providerUpstreamError(
            `Jira redirected ${method} ${path}; this request reads the Jira origin only`,
            refuseRedirectsAs,
          )
        }
        if (!response.ok) await this.rejectFailure(response)

        const contentLength = response.headers.get('content-length')
        const text = response.status === 204 || contentLength === '0' ? '' : await response.text()
        if (text.length === 0) {
          // SAFETY: Jira mutation endpoints return an empty success body; their private callers
          // request void, while read endpoints are expected to return the documented JSON body.
          return undefined as TResponse
        }
        // SAFETY: Each private caller pairs a fixed Jira REST endpoint with its documented
        // response type; unsuccessful HTTP responses have already been rejected above.
        return JSON.parse(text) as TResponse
      },
      this.requestTimeoutMs,
    )
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
    const query = {
      jql: params.jql,
      maxResults: params.maxResults,
      nextPageToken: params.nextPageToken || undefined,
      startAt: params.nextPageToken ? undefined : params.startAt,
      fields: params.fields?.length ? params.fields.join(',') : undefined,
    }
    // /rest/api/3/search/jql ignores startAt and paginates by nextPageToken.
    // Send the cursor when we have one; only send startAt on the first page for
    // back-compat with the legacy endpoint.
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

  /**
   * The issue's own list decides which ids may be downloaded, so this read
   * refuses redirects too, and an entry without a usable size is refused
   * here rather than disabling the download bound later.
   */
  async getIssueAttachments(idOrKey: string): Promise<JiraAttachment[]> {
    const issue = await this.request<never, { fields?: { attachment?: JiraAttachment[] | null } }>(
      'GET',
      `/rest/api/3/issue/${encodeURIComponent(idOrKey)}`,
      undefined,
      { fields: 'attachment' },
      { refuseRedirectsAs: ErrorCode.ATTACHMENT_REFUSED },
    )
    const attachments = issue.fields?.attachment ?? []
    for (const attachment of attachments) {
      if (!Number.isSafeInteger(attachment.size) || attachment.size < 0) {
        providerUpstreamError(`Jira attachment '${attachment.id}' on ${idOrKey} has no valid size`)
      }
    }
    return attachments
  }

  /**
   * Downloads attachment bytes from the Jira origin only. Jira answers the
   * content route with a 303 to its media host by default; `redirect=false`
   * asks for the bytes inline and `redirect: 'manual'` makes any redirect that
   * still arrives a refusal instead of a cross-origin fetch with our credentials.
   * The body is read in chunks and abandoned the moment it passes `maxBytes`.
   * Refusals are ATTACHMENT_REFUSED so a caller can tell them from transient faults.
   */
  downloadAttachment(attachmentId: string, options: { maxBytes: number }): Promise<Uint8Array> {
    this.assertNotCoolingDown()
    const url = `${this.baseUrl}/rest/api/3/attachment/content/${encodeURIComponent(attachmentId)}?redirect=false`
    const init: RequestInit = {
      method: 'GET',
      headers: { Authorization: this.authHeader, Accept: '*/*' },
      redirect: 'manual',
    }
    return providerRequest(
      'Jira',
      url,
      init,
      async (response) => {
        this.rejectAuthOrRateLimit(response)
        if (isRedirect(response)) {
          providerUpstreamError(
            `Jira attachment '${attachmentId}' download was redirected; only the Jira origin is read`,
            ErrorCode.ATTACHMENT_REFUSED,
          )
        }
        if (!response.ok) await this.rejectFailure(response)

        const declared = Number(response.headers.get('content-length'))
        if (Number.isFinite(declared) && declared > options.maxBytes) {
          providerUpstreamError(
            `Jira attachment '${attachmentId}' is ${declared} bytes; at most ${options.maxBytes} are read`,
            ErrorCode.ATTACHMENT_REFUSED,
          )
        }
        return readBoundedBody(response, options.maxBytes, () =>
          providerUpstreamError(
            `Jira attachment '${attachmentId}' body exceeds ${options.maxBytes} bytes`,
            ErrorCode.ATTACHMENT_REFUSED,
          ),
        )
      },
      attachmentDownloadTimeoutMs(this.requestTimeoutMs, options.maxBytes),
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

  transitionIssue(idOrKey: string, transitionId: string, fields?: JsonObject): Promise<void> {
    const body = {
      transition: { id: transitionId },
      fields,
    }
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
