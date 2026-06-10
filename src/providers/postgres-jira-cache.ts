import type { Sql } from 'postgres'

import type { BoardView, ProviderTeamInfo, Task } from '../types'
import {
  decodeColumnStatusIds,
  type JiraActivityRow,
  type JiraCacheConfig,
  type JiraColumnRow,
  type JiraSyncMeta,
} from './jira-cache'
import type { JiraCachePort } from './jira-core'
import { ensureWebhookEventsSchema } from '../webhook-events'
import { jiraTaskFromRow, type JiraTaskRow } from './cache-task-mappers'
import { type Exec, recordsetJson } from './postgres-batch'
import { parseProviderTeamInfo } from './team-info'

export type JiraIssueRow = JiraTaskRow

/**
 * Postgres-backed cache/repository for the Jira provider. Mirrors the role of the
 * SQLite-side `jira-cache.ts` free functions, but as an instance that owns the
 * async `postgres.js` client and its own schema-readiness promise. Holds only
 * cache I/O (persistence + materialization); API sync and business logic stay in
 * `PostgresJiraProvider`.
 */
export class PostgresJiraCache implements JiraCachePort {
  readonly ready: Promise<void>

  constructor(private readonly sql: Sql) {
    this.ready = this.ensureSchema()
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

  async setMeta(key: string, value: string): Promise<void> {
    await this.sql`
      INSERT INTO jira_sync_meta (key, value)
      VALUES (${key}, ${value})
      ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value
    `
  }

  async deleteMeta(key: string): Promise<void> {
    await this.sql`DELETE FROM jira_sync_meta WHERE key = ${key}`
  }

  async getMeta(key: string): Promise<string | null> {
    const [row] = await this.sql<{ value: string }[]>`
      SELECT value FROM jira_sync_meta WHERE key = ${key}
    `
    return row?.value ?? null
  }

  async saveSyncMeta(meta: Partial<JiraSyncMeta>): Promise<void> {
    const keys = [
      'projectKey',
      'boardId',
      'lastSyncAt',
      'lastIssueUpdatedAt',
      'lastFullSyncAt',
      'lastWebhookAt',
    ] as const
    await this.sql.begin(async (tx) => {
      for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(meta, key)) continue
        const value = meta[key]
        if (value === null) {
          await tx`DELETE FROM jira_sync_meta WHERE key = ${key}`
          continue
        }
        if (key === 'boardId') {
          if (typeof value === 'number' && Number.isFinite(value)) {
            await tx`
              INSERT INTO jira_sync_meta (key, value)
              VALUES (${key}, ${String(value)})
              ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value
            `
          }
          continue
        }
        if (typeof value === 'string') {
          await tx`
            INSERT INTO jira_sync_meta (key, value)
            VALUES (${key}, ${value})
            ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value
          `
        }
      }
    })
  }

  async loadSyncMeta(): Promise<JiraSyncMeta> {
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

  async saveTeamInfo(team: ProviderTeamInfo | null): Promise<void> {
    if (team === null) {
      await this.deleteMeta('team')
      return
    }
    await this.setMeta('team', JSON.stringify(team))
  }

  async loadTeamInfo(): Promise<ProviderTeamInfo | null> {
    return parseProviderTeamInfo(await this.getMeta('team'))
  }

  // Catalog refreshes (columns, priorities, issue types) UPSERT the current rows
  // on every sync. The obsolete-row DELETE (`prune`) runs ONLY on a full
  // reconcile, mirroring issue pruning: a delta snapshot can be stale, and a
  // stale snapshot must not delete rows another replica just added. Each catalog
  // write runs in one advisory-locked transaction so the full-reconcile upsert
  // and prune step are visible as one cache update.
  async replaceColumns(
    columns: Array<{
      id: string
      name: string
      position: number
      statusIds: string[]
      source: 'board' | 'status'
    }>,
    prune: boolean,
  ): Promise<void> {
    const rows = columns.map((column) => ({
      id: column.id,
      name: column.name,
      position: column.position,
      status_ids: JSON.stringify(column.statusIds),
      source: column.source,
    }))
    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('agent-kanban:postgres-jira:catalog'))`
      if (rows.length > 0) {
        await tx`
          INSERT INTO jira_columns (id, name, position, status_ids, source)
          SELECT id, name, position, status_ids, source
          FROM jsonb_to_recordset(${recordsetJson(tx, rows)}) AS data(
            id text,
            name text,
            position integer,
            status_ids text,
            source text
          )
          ON CONFLICT(id) DO UPDATE SET
            name = EXCLUDED.name,
            position = EXCLUDED.position,
            status_ids = EXCLUDED.status_ids,
            source = EXCLUDED.source
        `
      }
      if (!prune) return
      if (columns.length === 0) {
        await tx`DELETE FROM jira_columns`
      } else {
        await tx`DELETE FROM jira_columns WHERE NOT (id = ANY(${columns.map((c) => c.id)}))`
      }
    })
  }

  async upsertUsers(
    users: Array<{ accountId: string; displayName: string; active?: boolean }>,
  ): Promise<void> {
    if (users.length === 0) return
    const now = new Date().toISOString()
    const rows = users.map((user) => ({
      account_id: user.accountId,
      display_name: user.displayName,
      active: user.active === false ? 0 : 1,
      updated_at: now,
    }))
    await this.sql`
      INSERT INTO jira_users (account_id, display_name, active, updated_at)
      SELECT account_id, display_name, active, updated_at
      FROM jsonb_to_recordset(${recordsetJson(this.sql, rows)}) AS data(
        account_id text,
        display_name text,
        active integer,
        updated_at text
      )
      ON CONFLICT(account_id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        active = EXCLUDED.active,
        updated_at = EXCLUDED.updated_at
    `
  }

  async replacePriorities(
    priorities: Array<{ id: string; name: string }>,
    prune: boolean,
  ): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('agent-kanban:postgres-jira:catalog'))`
      if (priorities.length > 0) {
        await tx`
          INSERT INTO jira_priorities (id, name)
          SELECT id, name
          FROM jsonb_to_recordset(${recordsetJson(tx, priorities)}) AS data(
            id text,
            name text
          )
          ON CONFLICT(id) DO UPDATE SET name = EXCLUDED.name
        `
      }
      if (!prune) return
      if (priorities.length === 0) {
        await tx`DELETE FROM jira_priorities`
      } else {
        await tx`DELETE FROM jira_priorities WHERE NOT (id = ANY(${priorities.map((p) => p.id)}))`
      }
    })
  }

  async replaceIssueTypes(
    types: Array<{ id: string; name: string }>,
    prune: boolean,
  ): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('agent-kanban:postgres-jira:catalog'))`
      if (types.length > 0) {
        await tx`
          INSERT INTO jira_issue_types (id, name)
          SELECT id, name
          FROM jsonb_to_recordset(${recordsetJson(tx, types)}) AS data(
            id text,
            name text
          )
          ON CONFLICT(id) DO UPDATE SET name = EXCLUDED.name
        `
      }
      if (!prune) return
      if (types.length === 0) {
        await tx`DELETE FROM jira_issue_types`
      } else {
        await tx`DELETE FROM jira_issue_types WHERE NOT (id = ANY(${types.map((t) => t.id)}))`
      }
    })
  }

  async upsertIssues(
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
    if (issues.length === 0) return
    // A sync batch can repeat an issue id (an issue updated while pagination is
    // in flight shows up on two pages); the batched ON CONFLICT DO UPDATE
    // statement errors on intra-statement duplicates, so keep the last
    // occurrence — matching the old row-by-row and SQLite last-wins behavior.
    const rows = [
      ...new Map(
        issues.map((issue) => [
          issue.id,
          {
            id: issue.id,
            key: issue.key,
            summary: issue.summary,
            description_text: issue.descriptionText,
            status_id: issue.statusId,
            priority_name: issue.priorityName ?? '',
            issue_type_name: issue.issueTypeName ?? '',
            assignee_account_id: issue.assigneeAccountId ?? null,
            assignee_name: issue.assigneeName ?? '',
            labels: JSON.stringify(issue.labels ?? []),
            comment_count: issue.commentCount ?? 0,
            project_key: issue.projectKey,
            url: issue.url ?? null,
            created_at: issue.createdAt,
            updated_at: issue.updatedAt,
          },
        ]),
      ).values(),
    ]
    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('agent-kanban:postgres-jira:issues'))`
      await tx`
        INSERT INTO jira_issues (
          id, key, summary, description_text, status_id, priority_name, issue_type_name,
          assignee_account_id, assignee_name, labels, comment_count, project_key, url, created_at, updated_at
        )
        SELECT
          id, key, summary, description_text, status_id, priority_name, issue_type_name,
          assignee_account_id, assignee_name, labels, comment_count, project_key, url, created_at, updated_at
        FROM jsonb_to_recordset(${recordsetJson(tx, rows)}) AS data(
          id text,
          key text,
          summary text,
          description_text text,
          status_id text,
          priority_name text,
          issue_type_name text,
          assignee_account_id text,
          assignee_name text,
          labels text,
          comment_count integer,
          project_key text,
          url text,
          created_at text,
          updated_at text
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
    })
  }

  async deleteIssue(idOrKey: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('agent-kanban:postgres-jira:issues'))`
      await tx`
        DELETE FROM jira_activity
        WHERE issue_id = ${idOrKey}
           OR issue_id IN (SELECT id FROM jira_issues WHERE key = ${idOrKey})
      `
      await tx`DELETE FROM jira_issues WHERE id = ${idOrKey} OR key = ${idOrKey}`
    })
  }

  async pruneIssuesMissingUpstream(projectKey: string, upstreamIssueIds: string[]): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('agent-kanban:postgres-jira:issues'))`
      if (upstreamIssueIds.length === 0) {
        await tx`
          DELETE FROM jira_activity
          WHERE issue_id IN (SELECT id FROM jira_issues WHERE project_key = ${projectKey})
        `
        await tx`DELETE FROM jira_issues WHERE project_key = ${projectKey}`
        return
      }

      await tx`
        DELETE FROM jira_activity
        WHERE issue_id IN (
          SELECT id FROM jira_issues
          WHERE project_key = ${projectKey}
            AND NOT (id = ANY(${upstreamIssueIds}))
        )
      `
      await tx`
        DELETE FROM jira_issues
        WHERE project_key = ${projectKey}
          AND NOT (id = ANY(${upstreamIssueIds}))
      `
    })
  }

  async getColumns(): Promise<JiraColumnRow[]> {
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

  async getCachedBoard(): Promise<BoardView> {
    const columns = await this.getColumns()
    const boardColumns = []
    for (const column of columns) {
      const tasks = (await this.selectIssuesByStatusIds(decodeColumnStatusIds(column))).map(
        jiraTaskFromRow,
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

  async getCachedTask(lookup: string): Promise<Task | null> {
    const normalized = lookup.startsWith('jira:') ? lookup.slice('jira:'.length) : lookup
    const [row] = await this.sql<JiraIssueRow[]>`
      SELECT * FROM jira_issues
      WHERE id = ${normalized} OR key = ${normalized}
      LIMIT 1
    `
    return row ? jiraTaskFromRow(row) : null
  }

  async adjustIssueCommentCount(idOrKey: string, delta: number): Promise<void> {
    await this.sql`
      UPDATE jira_issues
      SET comment_count = GREATEST(0, comment_count + ${delta})
      WHERE id = ${idOrKey} OR key = ${idOrKey}
    `
  }

  async getCachedTasks(params?: { columnId?: string }): Promise<Task[]> {
    if (params?.columnId !== undefined) {
      const [columnRow] = await this.sql<Pick<JiraColumnRow, 'status_ids'>[]>`
        SELECT status_ids FROM jira_columns WHERE id = ${params.columnId}
      `
      if (!columnRow) return []
      return (await this.selectIssuesByStatusIds(decodeColumnStatusIds(columnRow))).map(
        jiraTaskFromRow,
      )
    }
    return (
      await this.sql<JiraIssueRow[]>`
        SELECT * FROM jira_issues ORDER BY updated_at DESC, summary ASC
      `
    ).map(jiraTaskFromRow)
  }

  async getCachedConfig(): Promise<JiraCacheConfig> {
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

  async saveActivity(rows: JiraActivityRow[]): Promise<void> {
    await this.insertActivityRows(this.sql, rows)
  }

  private async insertActivityRows(sql: Exec, rows: JiraActivityRow[]): Promise<void> {
    if (rows.length === 0) return
    await sql`
      INSERT INTO jira_activity (issue_id, history_id, item_field, from_value, to_value, created_at)
      SELECT issue_id, history_id, item_field, from_value, to_value, created_at
      FROM jsonb_to_recordset(${recordsetJson(sql, rows)}) AS data(
        issue_id text,
        history_id text,
        item_field text,
        from_value text,
        to_value text,
        created_at text
      )
      ON CONFLICT(issue_id, history_id, item_field) DO NOTHING
    `
  }

  async getCachedActivity(
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

  async getDiscoveredAssignees(): Promise<string[]> {
    return (
      await this.sql<{ assignee_name: string }[]>`
        SELECT DISTINCT assignee_name FROM jira_issues WHERE assignee_name != '' ORDER BY assignee_name
      `
    ).map((row) => row.assignee_name)
  }

  async findPriorityName(wanted: string): Promise<string | null> {
    const [row] = await this.sql<{ name: string }[]>`
      SELECT name FROM jira_priorities WHERE LOWER(name) = LOWER(${wanted}) LIMIT 1
    `
    return row?.name ?? null
  }

  async getPriorityNames(): Promise<string[]> {
    return (await this.sql<{ name: string }[]>`SELECT name FROM jira_priorities ORDER BY name`).map(
      (row) => row.name,
    )
  }

  async findActiveAssigneeAccountId(displayName: string): Promise<string | null> {
    const [row] = await this.sql<{ account_id: string }[]>`
      SELECT account_id
      FROM jira_users
      WHERE active = 1 AND LOWER(display_name) = LOWER(${displayName})
      LIMIT 1
    `
    return row?.account_id ?? null
  }

  async findIssueTypeId(name: string): Promise<string | null> {
    const [row] = await this.sql<{ id: string }[]>`
      SELECT id FROM jira_issue_types WHERE LOWER(name) = LOWER(${name}) LIMIT 1
    `
    return row?.id ?? null
  }

  async getIssueTypeNames(): Promise<string[]> {
    return (
      await this.sql<{ name: string }[]>`SELECT name FROM jira_issue_types ORDER BY name`
    ).map((row) => row.name)
  }

  async resolveIssueId(lookup: string): Promise<string | null> {
    const normalized = lookup.startsWith('jira:') ? lookup.slice('jira:'.length) : lookup
    const [row] = await this.sql<{ id: string }[]>`
      SELECT id FROM jira_issues WHERE id = ${normalized} OR key = ${normalized} LIMIT 1
    `
    return row?.id ?? null
  }
}
