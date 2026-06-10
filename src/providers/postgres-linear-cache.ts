import type { Sql, TransactionSql } from 'postgres'

import type { BoardConfig, BoardView, Task } from '../types'
import { ensureWebhookEventsSchema } from '../webhook-events'
import type { LinearCachePort } from './linear-core'
import {
  clampActivityValue,
  type LinearActivityRow,
  type LinearStateRow,
  type LinearSyncMeta,
} from './linear-cache'
import { linearTaskFromRow, type LinearTaskRow } from './cache-task-mappers'
import { parseProviderTeamInfo } from './team-info'

export type { LinearActivityRow, LinearStateRow, LinearSyncMeta } from './linear-cache'

export type LinearIssueRow = LinearTaskRow

type Exec = Sql | TransactionSql

function recordsetJson(sql: Exec, rows: unknown[]): ReturnType<Sql['json']> {
  return sql.json(rows as never)
}

/**
 * Postgres-backed cache/repository for the Linear provider. Mirrors the role of
 * the SQLite-side `linear-cache.ts` free functions, but as an instance that owns
 * the async `postgres.js` client and its own schema-readiness promise. Holds only
 * cache I/O (persistence + materialization, including description-change activity
 * synthesis on write); API sync and business logic stay in `PostgresLinearProvider`.
 */
export class PostgresLinearCache implements LinearCachePort {
  readonly ready: Promise<void>

  constructor(private readonly sql: Sql) {
    this.ready = this.ensureSchema()
  }

  private async ensureSchema(): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS linear_sync_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `
    await this.sql`
      CREATE TABLE IF NOT EXISTS linear_states (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        position INTEGER NOT NULL,
        color TEXT,
        type TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `
    await this.sql`
      CREATE TABLE IF NOT EXISTS linear_users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      )
    `
    await this.sql`
      CREATE TABLE IF NOT EXISTS linear_projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT,
        state TEXT,
        updated_at TEXT NOT NULL
      )
    `
    await this.sql`
      CREATE TABLE IF NOT EXISTS linear_issues (
        id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        priority INTEGER NOT NULL DEFAULT 0,
        assignee_id TEXT,
        assignee_name TEXT NOT NULL DEFAULT '',
        project_id TEXT,
        project_name TEXT NOT NULL DEFAULT '',
        state_id TEXT NOT NULL,
        state_name TEXT NOT NULL,
        state_position INTEGER NOT NULL DEFAULT 0,
        labels TEXT NOT NULL DEFAULT '[]',
        comment_count INTEGER NOT NULL DEFAULT 0,
        url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `
    await this
      .sql`ALTER TABLE linear_issues ADD COLUMN IF NOT EXISTS labels TEXT NOT NULL DEFAULT '[]'`
    await this
      .sql`ALTER TABLE linear_issues ADD COLUMN IF NOT EXISTS comment_count INTEGER NOT NULL DEFAULT 0`
    await this.sql`CREATE INDEX IF NOT EXISTS idx_linear_issues_state_id ON linear_issues(state_id)`
    await this
      .sql`CREATE INDEX IF NOT EXISTS idx_linear_issues_updated_at ON linear_issues(updated_at)`
    await this.sql`
      CREATE TABLE IF NOT EXISTS linear_activity (
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
      CREATE INDEX IF NOT EXISTS linear_activity_created_at_idx ON linear_activity(created_at DESC)
    `
    await ensureWebhookEventsSchema(this.sql)
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.sql`
      INSERT INTO linear_sync_meta (key, value)
      VALUES (${key}, ${value})
      ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value
    `
  }

  async deleteMeta(key: string): Promise<void> {
    await this.sql`DELETE FROM linear_sync_meta WHERE key = ${key}`
  }

  async getMeta(key: string): Promise<string | null> {
    const [row] = await this.sql<{ value: string }[]>`
      SELECT value FROM linear_sync_meta WHERE key = ${key}
    `
    return row?.value ?? null
  }

  async saveSyncMeta(meta: Partial<LinearSyncMeta>): Promise<void> {
    const keys = [
      'team',
      'lastSyncAt',
      'lastFullSyncAt',
      'lastIssueUpdatedAt',
      'lastWebhookAt',
    ] as const
    await this.sql.begin(async (tx) => {
      for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(meta, key)) continue
        const value = meta[key]
        if (value === null) {
          await tx`DELETE FROM linear_sync_meta WHERE key = ${key}`
          continue
        }
        if (key === 'team') {
          await tx`
            INSERT INTO linear_sync_meta (key, value)
            VALUES (${key}, ${JSON.stringify(value)})
            ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value
          `
          continue
        }
        if (typeof value === 'string') {
          await tx`
            INSERT INTO linear_sync_meta (key, value)
            VALUES (${key}, ${value})
            ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value
          `
        }
      }
    })
  }

  async loadSyncMeta(): Promise<LinearSyncMeta> {
    return {
      team: parseProviderTeamInfo(await this.getMeta('team')),
      lastSyncAt: await this.getMeta('lastSyncAt'),
      lastFullSyncAt: await this.getMeta('lastFullSyncAt'),
      lastIssueUpdatedAt: await this.getMeta('lastIssueUpdatedAt'),
      lastWebhookAt: await this.getMeta('lastWebhookAt'),
    }
  }

  async replaceStates(
    states: Array<{
      id: string
      name: string
      position: number
      color?: string | null
      type?: string | null
    }>,
  ): Promise<void> {
    const now = new Date().toISOString()
    const rows = states.map((state) => ({
      id: state.id,
      name: state.name,
      position: state.position,
      color: state.color ?? null,
      type: state.type ?? null,
      created_at: now,
      updated_at: now,
    }))
    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('agent-kanban:postgres-linear:states'))`
      await tx`DELETE FROM linear_states`
      if (rows.length > 0) {
        await tx`
          INSERT INTO linear_states (id, name, position, color, type, created_at, updated_at)
          SELECT id, name, position, color, type, created_at, updated_at
          FROM jsonb_to_recordset(${recordsetJson(tx, rows)}) AS data(
            id text,
            name text,
            position integer,
            color text,
            type text,
            created_at text,
            updated_at text
          )
          WHERE true
        `
      }
    })
  }

  async upsertUsers(users: Array<{ id: string; name: string; active?: boolean }>): Promise<void> {
    if (users.length === 0) return
    const now = new Date().toISOString()
    const rows = users.map((user) => ({
      id: user.id,
      name: user.name,
      active: user.active === false ? 0 : 1,
      updated_at: now,
    }))
    await this.sql.begin(async (tx) => {
      await tx`
        INSERT INTO linear_users (id, name, active, updated_at)
        SELECT id, name, active, updated_at
        FROM jsonb_to_recordset(${recordsetJson(tx, rows)}) AS data(
          id text,
          name text,
          active integer,
          updated_at text
        )
        WHERE true
        ON CONFLICT(id) DO UPDATE SET
          name = EXCLUDED.name,
          active = EXCLUDED.active,
          updated_at = EXCLUDED.updated_at
      `
    })
  }

  async upsertProjects(
    projects: Array<{ id: string; name: string; url?: string | null; state?: string | null }>,
  ): Promise<void> {
    if (projects.length === 0) return
    const now = new Date().toISOString()
    const rows = projects.map((project) => ({
      id: project.id,
      name: project.name,
      url: project.url ?? null,
      state: project.state ?? null,
      updated_at: now,
    }))
    await this.sql.begin(async (tx) => {
      await tx`
        INSERT INTO linear_projects (id, name, url, state, updated_at)
        SELECT id, name, url, state, updated_at
        FROM jsonb_to_recordset(${recordsetJson(tx, rows)}) AS data(
          id text,
          name text,
          url text,
          state text,
          updated_at text
        )
        WHERE true
        ON CONFLICT(id) DO UPDATE SET
          name = EXCLUDED.name,
          url = EXCLUDED.url,
          state = EXCLUDED.state,
          updated_at = EXCLUDED.updated_at
      `
    })
  }

  async saveActivity(rows: LinearActivityRow[]): Promise<void> {
    await this.insertActivityRows(this.sql, rows)
  }

  private async insertActivityRows(sql: Exec, rows: LinearActivityRow[]): Promise<void> {
    if (rows.length === 0) return
    await sql`
      INSERT INTO linear_activity (issue_id, history_id, item_field, from_value, to_value, created_at)
      SELECT issue_id, history_id, item_field, from_value, to_value, created_at
      FROM jsonb_to_recordset(${recordsetJson(sql, rows)}) AS data(
        issue_id text,
        history_id text,
        item_field text,
        from_value text,
        to_value text,
        created_at text
      )
      WHERE true
      ON CONFLICT(issue_id, history_id, item_field) DO NOTHING
    `
  }

  async upsertIssues(
    issues: Array<{
      id: string
      identifier: string
      title: string
      description?: string | null
      priority?: number | null
      assigneeId?: string | null
      assigneeName?: string | null
      projectId?: string | null
      projectName?: string | null
      stateId: string
      stateName: string
      statePosition: number
      labels?: string[] | null
      commentCount?: number | null
      url?: string | null
      createdAt: string
      updatedAt: string
    }>,
  ): Promise<void> {
    if (issues.length === 0) return
    const rows = issues.map((issue) => {
      const hasCommentCount = issue.commentCount !== undefined && issue.commentCount !== null
      return {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? '',
        priority: issue.priority ?? 0,
        assignee_id: issue.assigneeId ?? null,
        assignee_name: issue.assigneeName ?? '',
        project_id: issue.projectId ?? null,
        project_name: issue.projectName ?? '',
        state_id: issue.stateId,
        state_name: issue.stateName,
        state_position: issue.statePosition,
        labels: JSON.stringify(issue.labels ?? []),
        comment_count: issue.commentCount ?? 0,
        comment_count_provided: hasCommentCount,
        url: issue.url ?? null,
        created_at: issue.createdAt,
        updated_at: issue.updatedAt,
      }
    })

    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('agent-kanban:postgres-linear:issues'))`
      const ids = rows.map((issue) => issue.id)
      const priorRows = await tx<{ id: string; description: string }[]>`
        SELECT id, description FROM linear_issues WHERE id = ANY(${ids})
      `
      const priorDescriptions = new Map(priorRows.map((row) => [row.id, row.description]))
      await this.insertActivityRows(
        tx,
        rows.flatMap((issue) => {
          const prior = priorDescriptions.get(issue.id)
          if (prior === undefined || prior === issue.description) return []
          return [
            {
              issue_id: issue.id,
              history_id: `desc:${issue.updated_at}`,
              item_field: 'description',
              from_value: clampActivityValue(prior),
              to_value: clampActivityValue(issue.description),
              created_at: issue.updated_at,
            },
          ]
        }),
      )

      await this.upsertIssueRows(
        tx,
        rows.filter((issue) => issue.comment_count_provided),
        true,
      )
      await this.upsertIssueRows(
        tx,
        rows.filter((issue) => !issue.comment_count_provided),
        false,
      )
    })
  }

  private async upsertIssueRows(
    sql: Exec,
    rows: Array<{
      id: string
      identifier: string
      title: string
      description: string
      priority: number
      assignee_id: string | null
      assignee_name: string
      project_id: string | null
      project_name: string
      state_id: string
      state_name: string
      state_position: number
      labels: string
      comment_count: number
      url: string | null
      created_at: string
      updated_at: string
    }>,
    updateCommentCount: boolean,
  ): Promise<void> {
    if (rows.length === 0) return
    const commentCountAssignment = updateCommentCount
      ? sql`, comment_count = EXCLUDED.comment_count`
      : sql``
    await sql`
      INSERT INTO linear_issues (
        id, identifier, title, description, priority, assignee_id, assignee_name,
        project_id, project_name, state_id, state_name, state_position, labels, comment_count,
        url, created_at, updated_at
      )
      SELECT
        id, identifier, title, description, priority, assignee_id, assignee_name,
        project_id, project_name, state_id, state_name, state_position, labels, comment_count,
        url, created_at, updated_at
      FROM jsonb_to_recordset(${recordsetJson(sql, rows)}) AS data(
        id text,
        identifier text,
        title text,
        description text,
        priority integer,
        assignee_id text,
        assignee_name text,
        project_id text,
        project_name text,
        state_id text,
        state_name text,
        state_position integer,
        labels text,
        comment_count integer,
        url text,
        created_at text,
        updated_at text
      )
      WHERE true
      ON CONFLICT(id) DO UPDATE SET
        identifier = EXCLUDED.identifier,
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        priority = EXCLUDED.priority,
        assignee_id = EXCLUDED.assignee_id,
        assignee_name = EXCLUDED.assignee_name,
        project_id = EXCLUDED.project_id,
        project_name = EXCLUDED.project_name,
        state_id = EXCLUDED.state_id,
        state_name = EXCLUDED.state_name,
        state_position = EXCLUDED.state_position,
        labels = EXCLUDED.labels${commentCountAssignment},
        url = EXCLUDED.url,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at
    `
  }

  async deleteIssue(idOrIdentifier: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('agent-kanban:postgres-linear:issues'))`
      await tx`
        DELETE FROM linear_activity
        WHERE issue_id = ${idOrIdentifier}
           OR issue_id IN (SELECT id FROM linear_issues WHERE identifier = ${idOrIdentifier})
      `
      await tx`DELETE FROM linear_issues WHERE id = ${idOrIdentifier} OR identifier = ${idOrIdentifier}`
    })
  }

  async pruneIssues(liveIssueIds: string[]): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('agent-kanban:postgres-linear:issues'))`
      if (liveIssueIds.length === 0) {
        await tx`DELETE FROM linear_activity`
        await tx`DELETE FROM linear_issues`
        return
      }
      await tx`
        DELETE FROM linear_activity
        WHERE issue_id IN (
          SELECT id FROM linear_issues WHERE NOT (id = ANY(${liveIssueIds}))
        )
      `
      await tx`DELETE FROM linear_issues WHERE NOT (id = ANY(${liveIssueIds}))`
    })
  }

  async adjustIssueCommentCount(idOrIdentifier: string, delta: number): Promise<void> {
    await this.sql`
      UPDATE linear_issues
      SET comment_count = GREATEST(0, comment_count + ${delta})
      WHERE id = ${idOrIdentifier} OR identifier = ${idOrIdentifier}
    `
  }

  async getCachedColumns(): Promise<LinearStateRow[]> {
    return this.sql<LinearStateRow[]>`SELECT * FROM linear_states ORDER BY position, name`
  }

  async getCachedBoard(): Promise<BoardView> {
    const columns = await this.getCachedColumns()
    const boardColumns = []
    for (const column of columns) {
      const tasks = (
        await this.sql<LinearIssueRow[]>`
          SELECT * FROM linear_issues
          WHERE state_id = ${column.id}
          ORDER BY updated_at DESC, title ASC
        `
      ).map(linearTaskFromRow)
      boardColumns.push({ ...column, tasks })
    }
    return { columns: boardColumns }
  }

  async getCachedTask(lookup: string): Promise<Task | null> {
    const normalized = lookup.startsWith('linear:') ? lookup.slice('linear:'.length) : lookup
    const [row] = await this.sql<LinearIssueRow[]>`
      SELECT * FROM linear_issues
      WHERE id = ${normalized} OR identifier = ${normalized}
      LIMIT 1
    `
    return row ? linearTaskFromRow(row) : null
  }

  async getCachedTasks(): Promise<Task[]> {
    return (
      await this.sql<LinearIssueRow[]>`
        SELECT * FROM linear_issues ORDER BY updated_at DESC, title ASC
      `
    ).map(linearTaskFromRow)
  }

  async getCachedConfig(): Promise<BoardConfig> {
    const members = (
      await this.sql<{ name: string }[]>`
        SELECT name FROM linear_users WHERE active = 1 AND name != '' ORDER BY name
      `
    ).map((row) => ({ name: row.name, role: 'human' as const }))
    const projects = (
      await this.sql<{ name: string }[]>`
        SELECT name FROM linear_projects WHERE name != '' ORDER BY name
      `
    ).map((row) => row.name)
    return {
      members,
      projects,
      provider: 'linear',
      discoveredAssignees: members.map((member) => member.name),
      discoveredProjects: projects,
    }
  }

  async getCachedActivity(
    params: { issueId?: string; limit?: number } = {},
  ): Promise<LinearActivityRow[]> {
    const limit = params.limit ?? 100
    if (params.issueId) {
      return this.sql<LinearActivityRow[]>`
        SELECT issue_id, history_id, item_field, from_value, to_value, created_at
        FROM linear_activity
        WHERE issue_id = ${params.issueId}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `
    }
    return this.sql<LinearActivityRow[]>`
      SELECT issue_id, history_id, item_field, from_value, to_value, created_at
      FROM linear_activity
      ORDER BY created_at DESC
      LIMIT ${limit}
    `
  }

  async findUserIdByName(name: string): Promise<string | null> {
    const [row] = await this.sql<{ id: string }[]>`
      SELECT id FROM linear_users WHERE LOWER(name) = LOWER(${name}) LIMIT 1
    `
    return row?.id ?? null
  }

  async findProjectIdByName(name: string): Promise<string | null> {
    const [row] = await this.sql<{ id: string }[]>`
      SELECT id FROM linear_projects WHERE LOWER(name) = LOWER(${name}) LIMIT 1
    `
    return row?.id ?? null
  }

  async resolveIssueId(lookup: string): Promise<string | null> {
    const normalized = lookup.startsWith('linear:') ? lookup.slice('linear:'.length) : lookup
    const [row] = await this.sql<{ id: string }[]>`
      SELECT id FROM linear_issues WHERE id = ${normalized} OR identifier = ${normalized} LIMIT 1
    `
    return row?.id ?? null
  }
}
