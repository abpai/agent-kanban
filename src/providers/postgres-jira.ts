import type { Sql } from 'postgres'

import { ErrorCode, KanbanError } from '../errors'
import type {
  ActivityEntry,
  BoardBootstrap,
  BoardConfig,
  BoardMetrics,
  BoardView,
  Column,
  Priority,
  ProviderTeamInfo,
  Task,
  TaskComment,
} from '../types'
import { JIRA_CAPABILITIES } from './capabilities'
import {
  decodeColumnStatusIds,
  jiraBoardColumnRows,
  resolveJiraColumnId,
  type JiraActivityRow,
  type JiraColumnRow,
} from './jira-cache'
import { adfToPlainText, plainTextToAdf, type AdfDocument } from './jira-adf'
import {
  JiraClient,
  decideJiraPagination,
  normalizeJiraLabels,
  type JiraComment,
  type JiraIssue,
} from './jira-client'
import type { JiraProviderConfig } from './jira'
import { providerUpstreamError, unsupportedOperation } from './errors'
import type {
  CreateTaskInput,
  KanbanProvider,
  ProviderContext,
  ProviderSyncStatus,
  TaskListFilters,
  UpdateTaskInput,
} from './types'
import { DEFAULT_POLLING_SYNC_INTERVAL_MS } from '../sync-config'
import {
  headerLower,
  verifySha256HmacSignatureHeader,
  type WebhookRequest,
  type WebhookResult,
} from '../webhooks'
import {
  ensureWebhookEventsSchema,
  extractWebhookMeta,
  recordWebhookEvent,
  webhookEventStatus,
} from '../webhook-events'

const FULL_RECONCILE_INTERVAL_MS = 5 * 60_000

function shouldRunFullReconcile(lastFullSyncAt: string | null, now: number): boolean {
  if (!lastFullSyncAt) return true
  const lastFullSyncAtMs = Date.parse(lastFullSyncAt)
  if (!Number.isFinite(lastFullSyncAtMs)) return true
  return now - lastFullSyncAtMs >= FULL_RECONCILE_INTERVAL_MS
}

const CANONICAL_TO_JIRA_DEFAULT: Record<Priority, string> = {
  urgent: 'Highest',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

interface JiraIssueRow {
  id: string
  key: string
  summary: string
  description_text: string
  status_id: string
  priority_name: string
  issue_type_name: string
  assignee_account_id: string | null
  assignee_name: string
  labels: string
  comment_count: number
  project_key: string
  url: string | null
  created_at: string
  updated_at: string
}

interface JiraSyncMeta {
  projectKey: string | null
  boardId: number | null
  lastSyncAt: string | null
  lastIssueUpdatedAt: string | null
  lastFullSyncAt: string | null
  lastWebhookAt: string | null
}

interface JiraCacheConfig {
  projectKey: string | null
  users: Array<{ accountId: string; displayName: string }>
  priorities: Array<{ id: string; name: string }>
  issueTypes: Array<{ id: string; name: string }>
}

function mapPriorityNameToCanonical(name: string): Task['priority'] {
  switch (name.trim().toLowerCase()) {
    case 'highest':
      return 'urgent'
    case 'high':
      return 'high'
    case 'medium':
      return 'medium'
    default:
      return 'low'
  }
}

function parseLabels(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : []
  } catch {
    return []
  }
}

function taskFromRow(row: JiraIssueRow): Task {
  return {
    id: `jira:${row.id}`,
    providerId: row.id,
    externalRef: row.key,
    url: row.url,
    title: row.summary,
    description: row.description_text,
    column_id: row.status_id,
    position: 0,
    priority: mapPriorityNameToCanonical(row.priority_name),
    assignee: row.assignee_name,
    assignees: row.assignee_name ? [row.assignee_name] : [],
    labels: parseLabels(row.labels),
    comment_count: row.comment_count,
    project: row.project_key,
    metadata: '{}',
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: row.updated_at,
    source_updated_at: row.updated_at,
  }
}

export class PostgresJiraProvider implements KanbanProvider {
  readonly type = 'jira' as const
  private readonly ready: Promise<void>
  private readonly client: JiraClient
  private readonly pollingSyncIntervalMs: number
  // When a server-side background warmer owns cache refresh, implicit request-path
  // syncs are suppressed once the cache is warm so reads never block on Jira I/O.
  private backgroundManaged = false

  constructor(
    private readonly sql: Sql,
    private readonly config: JiraProviderConfig,
    client?: JiraClient,
  ) {
    this.ready = this.ensureSchema()
    this.pollingSyncIntervalMs = config.pollingSyncIntervalMs ?? DEFAULT_POLLING_SYNC_INTERVAL_MS
    this.client =
      client ??
      new JiraClient({
        baseUrl: config.baseUrl,
        email: config.email,
        apiToken: config.apiToken,
      })
  }

  async initialize(): Promise<void> {
    await this.ready
  }

  private async ensureSchema(): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS jira_sync_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `
    await this.sql`
      CREATE TABLE IF NOT EXISTS jira_columns (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        position INTEGER NOT NULL,
        status_ids TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('board','status'))
      )
    `
    await this.sql`
      CREATE TABLE IF NOT EXISTS jira_users (
        account_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      )
    `
    await this.sql`
      CREATE TABLE IF NOT EXISTS jira_priorities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      )
    `
    await this.sql`
      CREATE TABLE IF NOT EXISTS jira_issue_types (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      )
    `
    await this.sql`
      CREATE TABLE IF NOT EXISTS jira_activity (
        issue_id TEXT NOT NULL,
        history_id TEXT NOT NULL,
        item_field TEXT NOT NULL,
        from_value TEXT,
        to_value TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (issue_id, history_id, item_field)
      )
    `
    await this.sql`
      CREATE TABLE IF NOT EXISTS jira_issues (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        summary TEXT NOT NULL,
        description_text TEXT NOT NULL DEFAULT '',
        status_id TEXT NOT NULL,
        priority_name TEXT NOT NULL DEFAULT '',
        issue_type_name TEXT NOT NULL DEFAULT '',
        assignee_account_id TEXT,
        assignee_name TEXT NOT NULL DEFAULT '',
        labels TEXT NOT NULL DEFAULT '[]',
        comment_count INTEGER NOT NULL DEFAULT 0,
        project_key TEXT NOT NULL,
        url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `
    await this.sql`CREATE INDEX IF NOT EXISTS idx_jira_issues_status_id ON jira_issues(status_id)`
    await this.sql`CREATE INDEX IF NOT EXISTS idx_jira_issues_updated_at ON jira_issues(updated_at)`
    await this.sql`
      CREATE INDEX IF NOT EXISTS jira_activity_created_at_idx ON jira_activity(created_at DESC)
    `
    await ensureWebhookEventsSchema(this.sql)
  }

  private async setMeta(key: string, value: string): Promise<void> {
    await this.sql`
      INSERT INTO jira_sync_meta (key, value)
      VALUES (${key}, ${value})
      ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value
    `
  }

  private async deleteMeta(key: string): Promise<void> {
    await this.sql`DELETE FROM jira_sync_meta WHERE key = ${key}`
  }

  private async getMeta(key: string): Promise<string | null> {
    const [row] = await this.sql<{ value: string }[]>`
      SELECT value FROM jira_sync_meta WHERE key = ${key}
    `
    return row?.value ?? null
  }

  private async saveSyncMeta(meta: Partial<JiraSyncMeta>): Promise<void> {
    const keys = [
      'projectKey',
      'boardId',
      'lastSyncAt',
      'lastIssueUpdatedAt',
      'lastFullSyncAt',
      'lastWebhookAt',
    ] as const
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(meta, key)) continue
      const value = meta[key]
      if (value === null) {
        await this.deleteMeta(key)
        continue
      }
      if (key === 'boardId') {
        if (typeof value === 'number' && Number.isFinite(value))
          await this.setMeta(key, String(value))
        continue
      }
      if (typeof value === 'string') await this.setMeta(key, value)
    }
  }

  private async loadSyncMeta(): Promise<JiraSyncMeta> {
    const boardIdRaw = await this.getMeta('boardId')
    const boardId = boardIdRaw === null ? null : Number.parseInt(boardIdRaw, 10)
    return {
      projectKey: await this.getMeta('projectKey'),
      boardId: boardId === null || Number.isNaN(boardId) ? null : boardId,
      lastSyncAt: await this.getMeta('lastSyncAt'),
      lastIssueUpdatedAt: await this.getMeta('lastIssueUpdatedAt'),
      lastFullSyncAt: await this.getMeta('lastFullSyncAt'),
      lastWebhookAt: await this.getMeta('lastWebhookAt'),
    }
  }

  private async saveTeamInfo(team: ProviderTeamInfo | null): Promise<void> {
    if (team === null) {
      await this.deleteMeta('team')
      return
    }
    await this.setMeta('team', JSON.stringify(team))
  }

  private async loadTeamInfo(): Promise<ProviderTeamInfo | null> {
    const raw = await this.getMeta('team')
    if (raw === null) return null
    try {
      const parsed = JSON.parse(raw) as ProviderTeamInfo
      return typeof parsed.id === 'string' &&
        typeof parsed.key === 'string' &&
        typeof parsed.name === 'string'
        ? parsed
        : null
    } catch {
      return null
    }
  }

  // Catalog refreshes (columns, priorities, issue types) UPSERT the current rows
  // on every sync — UPSERT serializes per row and never collides on the primary
  // key when multiple Dispatch replicas refresh concurrently, so a newly-created
  // status/column/priority is reflected on the next sync. The obsolete-row DELETE
  // (`prune`) runs ONLY on a full reconcile, mirroring how upstream-missing issues
  // are pruned (see pruneIssuesMissingUpstream): a delta sync's snapshot can be
  // stale, and a stale snapshot's DELETE would drop a row another replica just
  // added with a fresher snapshot. Confining the delete to the periodic full
  // reconcile (and self-healing via the every-sync UPSERT) keeps catalog pruning
  // consistent with issue pruning and out of the common delta path.
  private async replaceColumns(
    columns: Array<{
      id: string
      name: string
      position: number
      statusIds: string[]
      source: 'board' | 'status'
    }>,
    prune: boolean,
  ): Promise<void> {
    for (const column of columns) {
      await this.sql`
        INSERT INTO jira_columns (id, name, position, status_ids, source)
        VALUES (
          ${column.id},
          ${column.name},
          ${column.position},
          ${JSON.stringify(column.statusIds)},
          ${column.source}
        )
        ON CONFLICT(id) DO UPDATE SET
          name = EXCLUDED.name,
          position = EXCLUDED.position,
          status_ids = EXCLUDED.status_ids,
          source = EXCLUDED.source
      `
    }
    if (prune) {
      await this.sql`DELETE FROM jira_columns WHERE NOT (id = ANY(${columns.map((c) => c.id)}))`
    }
  }

  private async upsertUsers(
    users: Array<{ accountId: string; displayName: string; active?: boolean }>,
  ): Promise<void> {
    for (const user of users) {
      await this.sql`
        INSERT INTO jira_users (account_id, display_name, active, updated_at)
        VALUES (${user.accountId}, ${user.displayName}, ${user.active === false ? 0 : 1}, ${new Date().toISOString()})
        ON CONFLICT(account_id) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          active = EXCLUDED.active,
          updated_at = EXCLUDED.updated_at
      `
    }
  }

  private async replacePriorities(
    priorities: Array<{ id: string; name: string }>,
    prune: boolean,
  ): Promise<void> {
    for (const priority of priorities) {
      await this.sql`
        INSERT INTO jira_priorities (id, name)
        VALUES (${priority.id}, ${priority.name})
        ON CONFLICT(id) DO UPDATE SET name = EXCLUDED.name
      `
    }
    if (prune) {
      await this
        .sql`DELETE FROM jira_priorities WHERE NOT (id = ANY(${priorities.map((p) => p.id)}))`
    }
  }

  private async replaceIssueTypes(
    types: Array<{ id: string; name: string }>,
    prune: boolean,
  ): Promise<void> {
    for (const type of types) {
      await this.sql`
        INSERT INTO jira_issue_types (id, name)
        VALUES (${type.id}, ${type.name})
        ON CONFLICT(id) DO UPDATE SET name = EXCLUDED.name
      `
    }
    if (prune) {
      await this.sql`DELETE FROM jira_issue_types WHERE NOT (id = ANY(${types.map((t) => t.id)}))`
    }
  }

  private async upsertIssues(
    issues: Array<{
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
    }>,
  ): Promise<void> {
    for (const issue of issues) {
      await this.sql`
        INSERT INTO jira_issues (
          id, key, summary, description_text, status_id, priority_name, issue_type_name,
          assignee_account_id, assignee_name, labels, comment_count, project_key, url, created_at, updated_at
        ) VALUES (
          ${issue.id}, ${issue.key}, ${issue.summary}, ${issue.descriptionText}, ${issue.statusId},
          ${issue.priorityName ?? ''}, ${issue.issueTypeName ?? ''}, ${issue.assigneeAccountId ?? null},
          ${issue.assigneeName ?? ''}, ${JSON.stringify(issue.labels ?? [])}, ${issue.commentCount ?? 0},
          ${issue.projectKey}, ${issue.url ?? null}, ${issue.createdAt}, ${issue.updatedAt}
        )
        ON CONFLICT(id) DO UPDATE SET
          key = EXCLUDED.key,
          summary = EXCLUDED.summary,
          description_text = EXCLUDED.description_text,
          status_id = EXCLUDED.status_id,
          priority_name = EXCLUDED.priority_name,
          issue_type_name = EXCLUDED.issue_type_name,
          assignee_account_id = EXCLUDED.assignee_account_id,
          assignee_name = EXCLUDED.assignee_name,
          labels = EXCLUDED.labels,
          comment_count = EXCLUDED.comment_count,
          project_key = EXCLUDED.project_key,
          url = EXCLUDED.url,
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at
      `
    }
  }

  private async deleteIssue(idOrKey: string): Promise<void> {
    await this.sql`
      DELETE FROM jira_activity
      WHERE issue_id = ${idOrKey}
         OR issue_id IN (SELECT id FROM jira_issues WHERE key = ${idOrKey})
    `
    await this.sql`DELETE FROM jira_issues WHERE id = ${idOrKey} OR key = ${idOrKey}`
  }

  private async pruneIssuesMissingUpstream(
    projectKey: string,
    upstreamIssueIds: string[],
  ): Promise<void> {
    if (upstreamIssueIds.length === 0) {
      await this.sql`
        DELETE FROM jira_activity
        WHERE issue_id IN (SELECT id FROM jira_issues WHERE project_key = ${projectKey})
      `
      await this.sql`DELETE FROM jira_issues WHERE project_key = ${projectKey}`
      return
    }

    await this.sql`
      DELETE FROM jira_activity
      WHERE issue_id IN (
        SELECT id FROM jira_issues
        WHERE project_key = ${projectKey}
          AND NOT (id = ANY(${upstreamIssueIds}))
      )
    `
    await this.sql`
      DELETE FROM jira_issues
      WHERE project_key = ${projectKey}
        AND NOT (id = ANY(${upstreamIssueIds}))
    `
  }

  private async getColumns(): Promise<JiraColumnRow[]> {
    await this.ready
    return this.sql<JiraColumnRow[]>`SELECT * FROM jira_columns ORDER BY position, name`
  }

  private async selectIssuesByStatusIds(statusIds: string[]): Promise<JiraIssueRow[]> {
    if (statusIds.length === 0) return []
    return this.sql<JiraIssueRow[]>`
      SELECT * FROM jira_issues
      WHERE status_id = ANY(${statusIds})
      ORDER BY updated_at DESC, summary ASC
    `
  }

  private async getCachedBoard(): Promise<BoardView> {
    const columns = await this.getColumns()
    const boardColumns = []
    for (const column of columns) {
      const tasks = (await this.selectIssuesByStatusIds(decodeColumnStatusIds(column))).map(
        taskFromRow,
      )
      boardColumns.push({
        id: column.id,
        name: column.name,
        position: column.position,
        color: null,
        created_at: '',
        updated_at: '',
        tasks,
      })
    }
    return { columns: boardColumns }
  }

  private async getCachedTask(lookup: string): Promise<Task | null> {
    const normalized = lookup.startsWith('jira:') ? lookup.slice('jira:'.length) : lookup
    const [row] = await this.sql<JiraIssueRow[]>`
      SELECT * FROM jira_issues
      WHERE id = ${normalized} OR key = ${normalized}
      LIMIT 1
    `
    return row ? taskFromRow(row) : null
  }

  private async adjustIssueCommentCount(idOrKey: string, delta: number): Promise<void> {
    await this.sql`
      UPDATE jira_issues
      SET comment_count = GREATEST(0, comment_count + ${delta})
      WHERE id = ${idOrKey} OR key = ${idOrKey}
    `
  }

  private async getCachedTasks(params?: { columnId?: string }): Promise<Task[]> {
    if (params?.columnId !== undefined) {
      const [columnRow] = await this.sql<Pick<JiraColumnRow, 'status_ids'>[]>`
        SELECT status_ids FROM jira_columns WHERE id = ${params.columnId}
      `
      if (!columnRow) return []
      return (await this.selectIssuesByStatusIds(decodeColumnStatusIds(columnRow))).map(taskFromRow)
    }
    return (
      await this.sql<JiraIssueRow[]>`
        SELECT * FROM jira_issues ORDER BY updated_at DESC, summary ASC
      `
    ).map(taskFromRow)
  }

  private async getCachedConfig(): Promise<JiraCacheConfig> {
    const users = (
      await this.sql<{ account_id: string; display_name: string }[]>`
        SELECT account_id, display_name
        FROM jira_users
        WHERE active = 1
        ORDER BY display_name
      `
    ).map((row) => ({ accountId: row.account_id, displayName: row.display_name }))
    const priorities = await this.sql<Array<{ id: string; name: string }>>`
      SELECT id, name FROM jira_priorities ORDER BY name
    `
    const issueTypes = await this.sql<Array<{ id: string; name: string }>>`
      SELECT id, name FROM jira_issue_types ORDER BY name
    `
    return {
      projectKey: await this.getMeta('projectKey'),
      users,
      priorities,
      issueTypes,
    }
  }

  private async saveActivity(rows: JiraActivityRow[]): Promise<void> {
    for (const row of rows) {
      await this.sql`
        INSERT INTO jira_activity (issue_id, history_id, item_field, from_value, to_value, created_at)
        VALUES (${row.issue_id}, ${row.history_id}, ${row.item_field}, ${row.from_value}, ${row.to_value}, ${row.created_at})
        ON CONFLICT(issue_id, history_id, item_field) DO NOTHING
      `
    }
  }

  private async getCachedActivity(
    params: { issueId?: string; limit?: number } = {},
  ): Promise<JiraActivityRow[]> {
    const limit = params.limit ?? 100
    if (params.issueId) {
      return this.sql<JiraActivityRow[]>`
        SELECT issue_id, history_id, item_field, from_value, to_value, created_at
        FROM jira_activity
        WHERE issue_id = ${params.issueId}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `
    }
    return this.sql<JiraActivityRow[]>`
      SELECT issue_id, history_id, item_field, from_value, to_value, created_at
      FROM jira_activity
      ORDER BY created_at DESC
      LIMIT ${limit}
    `
  }

  private async sync(force = false, viaWarmer = false): Promise<void> {
    await this.ready
    const meta = await this.loadSyncMeta()
    const lastSyncAtMs = meta.lastSyncAt ? Date.parse(meta.lastSyncAt) : 0
    // Server mode: a background warmer (syncCache(), viaWarmer=true) owns refresh.
    // Once warm, implicit request-path reads serve the warm cache instead of
    // blocking on a Jira round-trip (a periodic full reconcile can take minutes and
    // exceed the HTTP idle timeout). Forced syncs (write read-after-write) and the
    // warmer still run; CLI mode and cold start sync synchronously.
    if (this.backgroundManaged && !force && !viaWarmer && lastSyncAtMs) return
    const now = Date.now()
    if (!force && lastSyncAtMs && now - lastSyncAtMs < this.pollingSyncIntervalMs) return
    // `force` bypasses the poll throttle (so create/move/update see their own
    // write) but must NOT force a full 1970-based reconcile: on a large project
    // that re-fetches every issue plus a per-issue changelog call (~minutes) on
    // every write. A delta sync (updated >= lastIssueUpdatedAt) is cheap and
    // still catches the just-written issue, which is always among the newest.
    const fullReconcile = shouldRunFullReconcile(meta.lastFullSyncAt, now)

    const project = await this.client.getProject(this.config.projectKey)
    await this.saveTeamInfo({ id: project.id, key: project.key, name: project.name })

    // Columns + catalogs (users/priorities/issue types) UPSERT on every sync so a
    // newly-created Jira status/column/priority/user is reflected promptly; the
    // obsolete-row prune is confined to the full reconcile (see replaceColumns).
    if (this.config.boardId !== undefined) {
      const boardCfg = await this.client.getBoardColumns(this.config.boardId)
      const boardId = this.config.boardId
      await this.replaceColumns(
        jiraBoardColumnRows(boardId, boardCfg.columnConfig.columns),
        fullReconcile,
      )
    } else {
      const statusCats = await this.client.getProjectStatuses(project.key)
      const seen = new Set<string>()
      const uniqueStatuses: Array<{ id: string; name: string }> = []
      for (const category of statusCats) {
        for (const status of category.statuses) {
          if (seen.has(status.id)) continue
          seen.add(status.id)
          uniqueStatuses.push({ id: status.id, name: status.name })
        }
      }
      await this.replaceColumns(
        uniqueStatuses.map((status, index) => ({
          id: `status:${status.id}`,
          name: status.name,
          position: index,
          statusIds: [status.id],
          source: 'status' as const,
        })),
        fullReconcile,
      )
    }

    const [users, priorities, issueTypes] = await Promise.all([
      this.client.listAssignableUsers({
        projectKey: project.key,
        startAt: 0,
        maxResults: 100,
      }),
      this.client.listPriorities(),
      this.client.listIssueTypes({ projectId: project.id }),
    ])
    await this.upsertUsers(
      users.map((user) => ({
        accountId: user.accountId,
        displayName: user.displayName,
        active: user.active ?? true,
      })),
    )
    await this.replacePriorities(
      priorities.map((priority) => ({ id: priority.id, name: priority.name })),
      fullReconcile,
    )
    await this.replaceIssueTypes(
      issueTypes.map((issueType) => ({ id: issueType.id, name: issueType.name })),
      fullReconcile,
    )

    const since = fullReconcile ? null : meta.lastIssueUpdatedAt
    const sinceClause = since ?? '1970-01-01 00:00'
    const jql = `project = ${project.key} AND updated >= "${sinceClause}" ORDER BY updated ASC`
    const maxResults = 100
    let newestUpdatedAt: string | null = meta.lastIssueUpdatedAt
    const seenIssueIds = new Set<string>()
    const issueFields = [
      'summary',
      'description',
      'status',
      'issuetype',
      'priority',
      'assignee',
      'labels',
      'comment',
      'created',
      'updated',
      'project',
    ]

    // /rest/api/3/search/jql paginates by an opaque nextPageToken and omits
    // `total`, so we follow the cursor until the server reports `isLast` or stops
    // handing back a token. The previous total/startAt loop fetched only the first
    // page (oldest 100 by updated ASC) once `total` came back undefined, so every
    // issue beyond the first page — including newly-created tickets on a project
    // with >100 issues — was never cached. seenPageTokens guards against a server
    // that repeats a cursor, which would otherwise spin this loop forever and hang
    // the poll cycle; an empty page is not treated as terminal because a non-last
    // page may legitimately carry a token with zero issues.
    const seenPageTokens = new Set<string>()
    let nextPageToken: string | undefined
    let firstPage = true
    let paginationComplete = false
    while (firstPage || nextPageToken !== undefined) {
      firstPage = false
      const page = await this.client.listIssues({
        jql,
        startAt: 0,
        maxResults,
        fields: issueFields,
        nextPageToken,
      })

      await this.upsertIssues(
        page.issues.map((issue) => ({
          id: issue.id,
          key: issue.key,
          summary: issue.fields.summary,
          descriptionText: issue.fields.description
            ? adfToPlainText(issue.fields.description as AdfDocument)
            : '',
          statusId: issue.fields.status.id,
          priorityName: issue.fields.priority?.name ?? null,
          issueTypeName: issue.fields.issuetype?.name ?? '',
          assigneeAccountId: issue.fields.assignee?.accountId ?? null,
          assigneeName: issue.fields.assignee?.displayName ?? null,
          labels: issue.fields.labels ?? [],
          commentCount: issue.fields.comment?.total ?? 0,
          projectKey: issue.fields.project?.key ?? project.key,
          url: `${this.config.baseUrl}/browse/${issue.key}`,
          createdAt: issue.fields.created,
          updatedAt: issue.fields.updated,
        })),
      )

      for (const issue of page.issues) {
        if (fullReconcile) seenIssueIds.add(issue.id)
        if (newestUpdatedAt === null || issue.fields.updated > newestUpdatedAt) {
          newestUpdatedAt = issue.fields.updated
        }
      }

      for (const issue of page.issues) {
        await this.ingestIssueActivity(issue.id).catch((err) => {
          console.warn(`[jira] activity fetch for ${issue.key} failed:`, err)
        })
      }

      const decision = decideJiraPagination(page, seenPageTokens)
      if (decision.nextToken !== undefined) {
        seenPageTokens.add(decision.nextToken)
        nextPageToken = decision.nextToken
        continue
      }
      paginationComplete = decision.complete
      if (!paginationComplete) {
        // The server stopped advancing the cursor before reporting a definitive
        // end (stalled/contradictory). seenIssueIds is only a partial scan, so we
        // must not treat it as authoritative for pruning below.
        console.warn(
          `[jira] search/jql scan ended without a definitive last page; treating as incomplete`,
        )
      }
      break
    }

    if (!paginationComplete) {
      // The scan ended early (stalled/contradictory cursor). Leave sync metadata
      // unchanged so this partial result is not recorded as a clean sync: lastSyncAt
      // is not advanced, so the next sync is not throttled and retries promptly, and
      // the full-reconcile marker stays due. The issues we did fetch are already
      // cached (additive); we only skip pruning — which would delete issues that
      // exist upstream on pages we never fetched — and the metadata advance.
      return
    }

    // Prune against seenIssueIds and advance lastFullSyncAt only on a full
    // reconcile; a delta sync's seenIssueIds is intentionally partial. (The scan
    // is known complete here — an incomplete scan returned above.)
    if (fullReconcile) {
      await this.pruneIssuesMissingUpstream(project.key, [...seenIssueIds])
    }

    const nextMeta: Partial<JiraSyncMeta> = {
      projectKey: project.key,
      boardId: this.config.boardId ?? null,
      lastSyncAt: new Date().toISOString(),
      lastIssueUpdatedAt: newestUpdatedAt ?? new Date().toISOString(),
    }
    if (fullReconcile) nextMeta.lastFullSyncAt = nextMeta.lastSyncAt
    await this.saveSyncMeta(nextMeta)
  }

  private async resolveColumnId(input: string): Promise<string> {
    return resolveJiraColumnId(await this.getColumns(), input)
  }

  private async buildBoardConfig(): Promise<BoardConfig> {
    const cache = await this.getCachedConfig()
    const members = cache.users.map((user) => ({ name: user.displayName, role: 'human' as const }))
    const projects = cache.projectKey ? [cache.projectKey] : []
    const discoveredAssignees = (
      await this.sql<{ assignee_name: string }[]>`
        SELECT DISTINCT assignee_name FROM jira_issues WHERE assignee_name != '' ORDER BY assignee_name
      `
    ).map((row) => row.assignee_name)
    return {
      members,
      projects,
      provider: 'jira',
      discoveredAssignees,
      discoveredProjects: projects.slice(),
    }
  }

  async syncCache(): Promise<void> {
    // viaWarmer bypasses the backgroundManaged request-path suppression without
    // forcing a full reconcile (force=false keeps the normal delta/full cadence).
    await this.sync(false, true)
  }

  setBackgroundManaged(managed: boolean): void {
    this.backgroundManaged = managed
  }

  async getSyncStatus(): Promise<ProviderSyncStatus> {
    const meta = await this.loadSyncMeta()
    return {
      lastSyncAt: meta.lastSyncAt,
      lastFullSyncAt: meta.lastFullSyncAt,
      lastWebhookAt: meta.lastWebhookAt,
    }
  }

  async getContext(): Promise<ProviderContext> {
    await this.sync()
    return { provider: 'jira', capabilities: JIRA_CAPABILITIES, team: await this.loadTeamInfo() }
  }

  async getBootstrap(): Promise<BoardBootstrap> {
    await this.sync()
    return {
      provider: 'jira',
      capabilities: JIRA_CAPABILITIES,
      board: await this.getCachedBoard(),
      config: await this.buildBoardConfig(),
      metrics: null,
      activity: [],
      team: await this.loadTeamInfo(),
    }
  }

  async getBoard(): Promise<BoardView> {
    await this.sync()
    return this.getCachedBoard()
  }

  async listColumns(): Promise<Column[]> {
    await this.sync()
    return (await this.getColumns()).map((row) => ({
      id: row.id,
      name: row.name,
      position: row.position,
      color: null,
      created_at: '',
      updated_at: '',
    }))
  }

  async listTasks(filters: TaskListFilters = {}): Promise<Task[]> {
    await this.sync()
    const columnId = filters.column ? await this.resolveColumnId(filters.column) : undefined
    let tasks = await this.getCachedTasks(columnId ? { columnId } : undefined)
    if (filters.priority) tasks = tasks.filter((task) => task.priority === filters.priority)
    if (filters.assignee) tasks = tasks.filter((task) => task.assignee === filters.assignee)
    if (filters.project) tasks = tasks.filter((task) => task.project === filters.project)
    if (filters.sort === 'title') tasks = [...tasks].sort((a, b) => a.title.localeCompare(b.title))
    if (filters.sort === 'updated')
      tasks = [...tasks].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    if (filters.limit) tasks = tasks.slice(0, filters.limit)
    return tasks
  }

  async getTask(idOrRef: string): Promise<Task> {
    await this.sync()
    const task = await this.getCachedTask(idOrRef)
    if (!task) throw new KanbanError(ErrorCode.TASK_NOT_FOUND, `No task with id '${idOrRef}'`)
    return task
  }

  private async resolveTaskByIdOrKey(idOrRef: string): Promise<Task> {
    const task = await this.getCachedTask(idOrRef)
    if (!task) throw new KanbanError(ErrorCode.TASK_NOT_FOUND, `No task with id '${idOrRef}'`)
    return task
  }

  private issueKeyFor(task: Task): string {
    return task.externalRef ?? task.providerId ?? task.id.replace(/^jira:/, '')
  }

  private async resolveJiraPriorityName(canonical: Priority): Promise<string> {
    const wanted = CANONICAL_TO_JIRA_DEFAULT[canonical]
    const [row] = await this.sql<{ name: string }[]>`
      SELECT name FROM jira_priorities WHERE LOWER(name) = LOWER(${wanted}) LIMIT 1
    `
    if (row) return row.name
    const available = (
      await this.sql<{ name: string }[]>`SELECT name FROM jira_priorities ORDER BY name`
    ).map((priority) => priority.name)
    providerUpstreamError(
      `Canonical priority '${canonical}' maps to Jira priority '${wanted}' which is not present in this tenant's priority catalog. Available Jira priorities: [${available
        .map((name) => `"${name}"`)
        .join(', ')}]`,
    )
  }

  private async resolveAssigneeAccountId(displayName: string): Promise<string> {
    const [row] = await this.sql<{ account_id: string }[]>`
      SELECT account_id
      FROM jira_users
      WHERE active = 1 AND LOWER(display_name) = LOWER(${displayName})
      LIMIT 1
    `
    if (row) return row.account_id
    providerUpstreamError(
      `Jira assignee '${displayName}' was not found in the cached active user list. Try 'kanban task list --assignee' to see cached names.`,
    )
  }

  private async resolveIssueTypeId(name: string): Promise<string> {
    const [row] = await this.sql<{ id: string }[]>`
      SELECT id FROM jira_issue_types WHERE LOWER(name) = LOWER(${name}) LIMIT 1
    `
    if (row) return row.id
    const available = (
      await this.sql<{ name: string }[]>`SELECT name FROM jira_issue_types ORDER BY name`
    ).map((issueType) => issueType.name)
    providerUpstreamError(
      `Jira issue type '${name}' is not present in this project's issue-type catalog. Available types: [${available
        .map((availableName) => `"${availableName}"`)
        .join(', ')}]`,
    )
  }

  private normalizeProjectField(input?: string): void {
    if (!input) return
    if (input === this.config.projectKey) return
    unsupportedOperation(
      `JiraProvider is pinned to project '${this.config.projectKey}'. A different project field ('${input}') is not supported.`,
    )
  }

  private toTaskComment(task: Task, comment: JiraComment): TaskComment {
    const timestamp = comment.updated ?? comment.created ?? task.updated_at
    return {
      id: comment.id,
      task_id: task.id,
      body: comment.body ? adfToPlainText(comment.body as AdfDocument) : '',
      author: comment.author?.displayName ?? null,
      created_at: comment.created ?? timestamp,
      updated_at: timestamp,
    }
  }

  private async ingestIssueActivity(issueId: string): Promise<void> {
    const page = await this.client.getChangelog(issueId, { maxResults: 100 })
    const rows: JiraActivityRow[] = []
    for (const entry of page.values) {
      for (const item of entry.items) {
        rows.push({
          issue_id: issueId,
          history_id: entry.id,
          item_field: item.field,
          from_value: item.from ?? null,
          to_value: item.to ?? null,
          created_at: entry.created,
        })
      }
    }
    await this.saveActivity(rows)
  }

  // Read-after-write via the direct issue endpoint. Unlike JQL search (used by
  // sync()), GET /issue/{key} has no search-index lag, so a just-created or
  // just-transitioned issue is reflected immediately. This replaces the previous
  // "transition/create then sync(true) then getCachedTask" pattern, which both
  // raced the search index (create reported "not yet visible"; a move's new
  // status didn't land, causing the daemon to re-issue the move in a loop) and
  // forced a full whole-project reconcile (~minutes) on every write.
  private async hydrateIssueByKey(key: string): Promise<Task> {
    // getIssue throws on a missing key (404), so reaching this method means the
    // issue exists upstream. A null read-back would therefore be a genuine cache
    // anomaly (the upsert above did not land), not an ordinary not-found — surface
    // it rather than threading an unreachable null through every caller.
    const issue = await this.client.getIssue(key)
    await this.upsertIssues([
      {
        id: issue.id,
        key: issue.key,
        summary: issue.fields.summary,
        descriptionText: issue.fields.description
          ? adfToPlainText(issue.fields.description as AdfDocument)
          : '',
        statusId: issue.fields.status.id,
        priorityName: issue.fields.priority?.name ?? null,
        issueTypeName: issue.fields.issuetype?.name ?? '',
        assigneeAccountId: issue.fields.assignee?.accountId ?? null,
        assigneeName: issue.fields.assignee?.displayName ?? null,
        labels: issue.fields.labels ?? [],
        commentCount: issue.fields.comment?.total ?? 0,
        projectKey: issue.fields.project?.key ?? this.config.projectKey,
        url: `${this.config.baseUrl}/browse/${issue.key}`,
        createdAt: issue.fields.created,
        updatedAt: issue.fields.updated,
      },
    ])
    // Ingest the changelog like the sync loop does, so a just-applied transition
    // is recorded in jira_activity immediately (backs getActivity and the
    // poll-based `moved` trigger) rather than waiting for the next unthrottled
    // sync. Best-effort: activity must not fail the mutation.
    await this.ingestIssueActivity(issue.id).catch((err) => {
      console.warn(`[jira] activity fetch for ${issue.key} failed:`, err)
    })
    const task = await this.getCachedTask(key)
    if (!task) {
      providerUpstreamError(
        `Jira issue ${key} was hydrated from GET /issue but is missing from the cache.`,
      )
    }
    return task
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    await this.sync()
    this.normalizeProjectField(input.project)
    const issueTypeName = this.config.defaultIssueType ?? 'Task'
    const issueTypeId = await this.resolveIssueTypeId(issueTypeName)
    const fields: Record<string, unknown> = {
      project: { key: this.config.projectKey },
      summary: input.title,
      issuetype: { id: issueTypeId },
    }
    if (input.description !== undefined) fields['description'] = plainTextToAdf(input.description)
    if (input.priority !== undefined) {
      fields['priority'] = { name: await this.resolveJiraPriorityName(input.priority) }
    }
    if (input.assignee) {
      fields['assignee'] = { accountId: await this.resolveAssigneeAccountId(input.assignee) }
    }
    const labels = normalizeJiraLabels(input.labels)
    if (labels.length > 0) fields['labels'] = labels
    const created = await this.client.createIssue({ fields })
    return this.hydrateIssueByKey(created.key)
  }

  async updateTask(idOrRef: string, input: UpdateTaskInput): Promise<Task> {
    await this.sync()
    this.normalizeProjectField(input.project)
    if (input.metadata !== undefined)
      unsupportedOperation('Jira mode does not support metadata updates')
    const task = await this.resolveTaskByIdOrKey(idOrRef)
    if (input.expectedVersion !== undefined && task.version !== input.expectedVersion) {
      throw new KanbanError(
        ErrorCode.CONFLICT,
        `Jira issue ${task.externalRef ?? idOrRef} was updated remotely (expected version ${input.expectedVersion}, current ${task.version ?? 'unknown'})`,
      )
    }
    const issueKey = this.issueKeyFor(task)
    const fields: Record<string, unknown> = {}
    if (input.title !== undefined) fields['summary'] = input.title
    if (input.description !== undefined) fields['description'] = plainTextToAdf(input.description)
    if (input.priority !== undefined) {
      fields['priority'] = { name: await this.resolveJiraPriorityName(input.priority) }
    }
    if (input.assignee !== undefined) {
      fields['assignee'] = input.assignee
        ? { accountId: await this.resolveAssigneeAccountId(input.assignee) }
        : null
    }
    if (Object.keys(fields).length > 0) await this.client.updateIssue(issueKey, { fields })
    return this.hydrateIssueByKey(issueKey)
  }

  async moveTask(idOrRef: string, column: string): Promise<Task> {
    await this.sync()
    const task = await this.resolveTaskByIdOrKey(idOrRef)
    return this.moveTaskByKey(this.issueKeyFor(task), column)
  }

  private async moveTaskByKey(issueKey: string, column: string): Promise<Task> {
    const columnId = await this.resolveColumnId(column)
    const columnRow = (await this.getColumns()).find((candidate) => candidate.id === columnId)
    if (!columnRow) {
      throw new KanbanError(
        ErrorCode.COLUMN_NOT_FOUND,
        `Resolved column '${column}' but cache row missing`,
      )
    }
    const statusIds = decodeColumnStatusIds(columnRow)
    if (statusIds.length === 0) {
      providerUpstreamError(`Column '${columnRow.name}' has no mapped Jira statuses.`)
    }
    const targetStatusId = statusIds[0]!
    const { transitions } = await this.client.getTransitions(issueKey)
    const match = transitions.find((transition) => transition.to.id === targetStatusId)
    if (!match) {
      const currentStatusId = (await this.getCachedTask(issueKey))?.column_id ?? '<unknown>'
      providerUpstreamError(
        `Cannot transition Jira issue ${issueKey} (current status id ${currentStatusId}) to column '${columnRow.name}' (target status id ${targetStatusId}). Available transitions: [${transitions
          .map((transition) => `"${transition.name}"`)
          .join(', ')}]`,
      )
    }
    await this.client.transitionIssue(issueKey, match.id)
    return this.hydrateIssueByKey(issueKey)
  }

  async deleteTask(_idOrRef: string): Promise<Task> {
    unsupportedOperation('Task deletion is not supported in Jira mode')
  }

  async listComments(idOrRef: string): Promise<TaskComment[]> {
    await this.sync()
    const task = await this.resolveTaskByIdOrKey(idOrRef)
    const issueKey = this.issueKeyFor(task)
    const comments: JiraComment[] = []
    let startAt = 0

    while (true) {
      const page = await this.client.getComments(issueKey, { startAt, maxResults: 100 })
      comments.push(...page.comments)
      startAt += page.comments.length
      if (comments.length >= page.total || page.comments.length === 0) break
    }

    return comments.map((comment) => this.toTaskComment(task, comment))
  }

  async getComment(idOrRef: string, commentId: string): Promise<TaskComment> {
    await this.sync()
    const task = await this.resolveTaskByIdOrKey(idOrRef)
    const comment = await this.client.getComment(this.issueKeyFor(task), commentId)
    return this.toTaskComment(task, comment)
  }

  async comment(idOrRef: string, body: string): Promise<TaskComment> {
    await this.sync()
    const task = await this.resolveTaskByIdOrKey(idOrRef)
    const created = await this.client.addComment(this.issueKeyFor(task), {
      body: plainTextToAdf(body),
    })
    await this.adjustIssueCommentCount(task.providerId || task.externalRef || task.id, 1)
    return this.toTaskComment(task, created)
  }

  async updateComment(idOrRef: string, commentId: string, body: string): Promise<TaskComment> {
    await this.sync()
    const task = await this.resolveTaskByIdOrKey(idOrRef)
    const updated = await this.client.updateComment(this.issueKeyFor(task), commentId, {
      body: plainTextToAdf(body),
    })
    return this.toTaskComment(task, updated)
  }

  async getActivity(limit?: number, taskId?: string): Promise<ActivityEntry[]> {
    await this.sync()
    const lookupIssueId = taskId ? await this.resolveIssueIdFromTaskId(taskId) : undefined
    const rows = await this.getCachedActivity({
      ...(lookupIssueId !== undefined ? { issueId: lookupIssueId } : {}),
      limit: limit ?? 100,
    })
    return Promise.all(rows.map((row) => this.activityRowToEntry(row)))
  }

  private async resolveIssueIdFromTaskId(taskId: string): Promise<string | undefined> {
    const normalized = taskId.startsWith('jira:') ? taskId.slice('jira:'.length) : taskId
    const [row] = await this.sql<{ id: string }[]>`
      SELECT id FROM jira_issues WHERE id = ${normalized} OR key = ${normalized} LIMIT 1
    `
    return row?.id
  }

  private async activityRowToEntry(row: JiraActivityRow): Promise<ActivityEntry> {
    const action: ActivityEntry['action'] = row.item_field === 'status' ? 'moved' : 'updated'
    let fromCol = row.from_value
    let toCol = row.to_value
    if (row.item_field === 'status') {
      fromCol = row.from_value
        ? ((await this.statusIdToColumnId(row.from_value)) ?? row.from_value)
        : null
      toCol = row.to_value ? ((await this.statusIdToColumnId(row.to_value)) ?? row.to_value) : null
    }
    return {
      id: `jira-activity:${row.issue_id}:${row.history_id}:${row.item_field}`,
      task_id: `jira:${row.issue_id}`,
      action,
      field_changed: row.item_field,
      old_value: fromCol,
      new_value: toCol,
      timestamp: row.created_at,
    }
  }

  private async statusIdToColumnId(statusId: string): Promise<string | undefined> {
    for (const column of await this.getColumns()) {
      if (decodeColumnStatusIds(column).includes(statusId)) return column.id
    }
    return undefined
  }

  async getMetrics(): Promise<BoardMetrics> {
    unsupportedOperation('Metrics are not available in Jira mode')
  }

  async getConfig(): Promise<BoardConfig> {
    await this.sync()
    return this.buildBoardConfig()
  }

  async patchConfig(_input: Partial<BoardConfig>): Promise<BoardConfig> {
    unsupportedOperation('Config mutation is not supported in Jira mode')
  }

  async handleWebhook(payload: WebhookRequest): Promise<WebhookResult> {
    const meta = extractWebhookMeta('jira', payload.rawBody)
    let result: WebhookResult
    try {
      result = await this.handleWebhookInner(payload)
    } catch (err) {
      void recordWebhookEvent(this.sql, {
        provider: 'jira',
        ...meta,
        status: 'error',
        detail: { error: err instanceof Error ? err.message : String(err) },
      })
      throw err
    }
    void recordWebhookEvent(this.sql, {
      provider: 'jira',
      ...meta,
      status: webhookEventStatus(result),
    })
    return result
  }

  private async handleWebhookInner(payload: WebhookRequest): Promise<WebhookResult> {
    const secret = process.env['JIRA_WEBHOOK_SECRET']
    if (secret) {
      const sig = headerLower(payload.headers, 'x-hub-signature')
      if (!verifySha256HmacSignatureHeader(secret, payload.rawBody, sig)) {
        return { handled: false, unauthorized: true, message: 'Invalid signature' }
      }
    }
    let body: { webhookEvent?: string; issue?: JiraIssue } = {}
    try {
      body = JSON.parse(payload.rawBody) as typeof body
    } catch {
      return { handled: false, message: 'Invalid JSON body' }
    }
    const event = body.webhookEvent ?? ''
    const issue = body.issue
    if (!issue) return { handled: false, message: `No issue in payload (${event})` }

    if (event === 'jira:issue_deleted') {
      await this.deleteIssue(issue.id)
      await this.saveSyncMeta({ lastWebhookAt: new Date().toISOString() })
      return { handled: true }
    }

    if (event === 'jira:issue_created' || event === 'jira:issue_updated') {
      const projectKey = issue.fields.project?.key
      if (projectKey !== this.config.projectKey) {
        return {
          handled: false,
          message: `Ignoring issue from project '${projectKey ?? 'unknown'}'`,
        }
      }
      await this.upsertIssues([
        {
          id: issue.id,
          key: issue.key,
          summary: issue.fields.summary,
          descriptionText: issue.fields.description
            ? adfToPlainText(issue.fields.description as AdfDocument)
            : '',
          statusId: issue.fields.status.id,
          priorityName: issue.fields.priority?.name ?? null,
          issueTypeName: issue.fields.issuetype?.name ?? '',
          assigneeAccountId: issue.fields.assignee?.accountId ?? null,
          assigneeName: issue.fields.assignee?.displayName ?? null,
          labels: issue.fields.labels ?? [],
          commentCount: issue.fields.comment?.total ?? 0,
          projectKey,
          url: `${this.config.baseUrl}/browse/${issue.key}`,
          createdAt: issue.fields.created,
          updatedAt: issue.fields.updated,
        },
      ])
      if (event === 'jira:issue_updated') {
        await this.ingestIssueActivity(issue.id).catch((err) => {
          console.warn(`[jira] activity fetch for webhook issue ${issue.key} failed:`, err)
        })
      }
      await this.saveSyncMeta({ lastWebhookAt: new Date().toISOString() })
      return { handled: true }
    }

    return { handled: false, message: `Unsupported event: ${event}` }
  }
}
