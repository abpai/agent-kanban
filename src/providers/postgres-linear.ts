import type { Sql } from 'postgres'

import { ErrorCode, KanbanError } from '../errors'
import type {
  ActivityEntry,
  BoardBootstrap,
  BoardConfig,
  BoardMetrics,
  BoardView,
  Column,
  ProviderTeamInfo,
  Task,
  TaskComment,
} from '../types'
import { DEFAULT_POLLING_SYNC_INTERVAL_MS } from '../sync-config'
import { headerLower, verifyHmacSha256, type WebhookRequest, type WebhookResult } from '../webhooks'
import {
  ensureWebhookEventsSchema,
  extractWebhookMeta,
  recordWebhookEvent,
  webhookEventStatus,
} from '../webhook-events'
import { LINEAR_CAPABILITIES } from './capabilities'
import { unsupportedOperation } from './errors'
import { LinearClient, resolveLinearLabelIds, type LinearComment } from './linear-client'
import type {
  CreateTaskInput,
  KanbanProvider,
  ProviderContext,
  ProviderSyncStatus,
  TaskListFilters,
  UpdateTaskInput,
} from './types'

const FULL_RECONCILIATION_INTERVAL_MS = 5 * 60_000
const ACTIVITY_VALUE_MAX_CHARS = 4096
const ACTIVITY_TRUNCATION_SUFFIX = '...[truncated]'
const ACTIVITY_VALUE_BUDGET = ACTIVITY_VALUE_MAX_CHARS - ACTIVITY_TRUNCATION_SUFFIX.length

interface LinearStateRow {
  id: string
  name: string
  position: number
  color: string | null
  type: string | null
  created_at: string
  updated_at: string
}

interface LinearIssueRow {
  id: string
  identifier: string
  title: string
  description: string
  state_id: string
  state_position: number
  priority: number
  assignee_name: string
  project_name: string
  labels: string
  comment_count: number
  url: string | null
  created_at: string
  updated_at: string
}

interface LinearSyncMeta {
  team: ProviderTeamInfo | null
  lastSyncAt: string | null
  lastFullSyncAt: string | null
  lastIssueUpdatedAt: string | null
  lastWebhookAt: string | null
}

interface LinearActivityRow {
  issue_id: string
  history_id: string
  item_field: string
  from_value: string | null
  to_value: string | null
  created_at: string
}

function parseTimestamp(value: string | null | undefined): number {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function maxTimestamp(a: string | null | undefined, b: string | null | undefined): string | null {
  const aMs = parseTimestamp(a)
  const bMs = parseTimestamp(b)
  if (!aMs && !bMs) return null
  return aMs >= bMs ? (a ?? null) : (b ?? null)
}

function toLinearPriority(priority: Task['priority'] | undefined): number | undefined {
  switch (priority) {
    case 'urgent':
      return 1
    case 'high':
      return 2
    case 'medium':
      return 3
    case 'low':
      return 4
    default:
      return undefined
  }
}

function mapPriority(priority: number): Task['priority'] {
  switch (priority) {
    case 1:
      return 'urgent'
    case 2:
      return 'high'
    case 3:
      return 'medium'
    case 0:
    case 4:
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

function taskFromRow(row: LinearIssueRow): Task {
  return {
    id: `linear:${row.id}`,
    providerId: row.id,
    externalRef: row.identifier,
    url: row.url,
    title: row.title,
    description: row.description,
    column_id: row.state_id,
    position: row.state_position,
    priority: mapPriority(row.priority),
    assignee: row.assignee_name,
    assignees: row.assignee_name ? [row.assignee_name] : [],
    labels: parseLabels(row.labels),
    comment_count: row.comment_count,
    project: row.project_name,
    metadata: '{}',
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: row.updated_at,
    source_updated_at: row.updated_at,
  }
}

function clampActivityValue(value: string): string {
  if (value.length <= ACTIVITY_VALUE_MAX_CHARS) return value
  return value.slice(0, ACTIVITY_VALUE_BUDGET) + ACTIVITY_TRUNCATION_SUFFIX
}

export class PostgresLinearProvider implements KanbanProvider {
  readonly type = 'linear' as const
  private readonly ready: Promise<void>
  private readonly client: LinearClient

  constructor(
    private readonly sql: Sql,
    private readonly teamId: string,
    apiKey: string,
    private readonly pollingSyncIntervalMs = DEFAULT_POLLING_SYNC_INTERVAL_MS,
    client?: LinearClient,
  ) {
    this.ready = this.ensureSchema()
    this.client = client ?? new LinearClient(apiKey)
  }

  async initialize(): Promise<void> {
    await this.ready
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

  private async setMeta(key: string, value: string): Promise<void> {
    await this.sql`
      INSERT INTO linear_sync_meta (key, value)
      VALUES (${key}, ${value})
      ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value
    `
  }

  private async deleteMeta(key: string): Promise<void> {
    await this.sql`DELETE FROM linear_sync_meta WHERE key = ${key}`
  }

  private async getMeta(key: string): Promise<string | null> {
    const [row] = await this.sql<{ value: string }[]>`
      SELECT value FROM linear_sync_meta WHERE key = ${key}
    `
    return row?.value ?? null
  }

  private async saveSyncMeta(meta: Partial<LinearSyncMeta>): Promise<void> {
    const keys = [
      'team',
      'lastSyncAt',
      'lastFullSyncAt',
      'lastIssueUpdatedAt',
      'lastWebhookAt',
    ] as const
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(meta, key)) continue
      const value = meta[key]
      if (value === null) {
        await this.deleteMeta(key)
        continue
      }
      if (key === 'team') {
        await this.setMeta(key, JSON.stringify(value))
        continue
      }
      if (typeof value === 'string') await this.setMeta(key, value)
    }
  }

  private async loadSyncMeta(): Promise<LinearSyncMeta> {
    const teamRaw = await this.getMeta('team')
    return {
      team: teamRaw ? (JSON.parse(teamRaw) as ProviderTeamInfo) : null,
      lastSyncAt: await this.getMeta('lastSyncAt'),
      lastFullSyncAt: await this.getMeta('lastFullSyncAt'),
      lastIssueUpdatedAt: await this.getMeta('lastIssueUpdatedAt'),
      lastWebhookAt: await this.getMeta('lastWebhookAt'),
    }
  }

  private async resolvedTeamId(): Promise<string> {
    return (await this.loadSyncMeta()).team?.id ?? this.teamId
  }

  private async getConfiguredTeam(): Promise<ProviderTeamInfo> {
    const metaTeam = (await this.loadSyncMeta()).team
    if (metaTeam) return metaTeam

    const team = await this.client.getTeam(this.teamId)
    const configuredTeam = { id: team.id, key: team.key, name: team.name }
    await this.saveSyncMeta({ team: configuredTeam })
    return configuredTeam
  }

  private async replaceStates(
    states: Array<{
      id: string
      name: string
      position: number
      color?: string | null
      type?: string | null
    }>,
  ): Promise<void> {
    const now = new Date().toISOString()
    await this.sql.begin(async (tx) => {
      await tx`DELETE FROM linear_states`
      for (const state of states) {
        await tx`
          INSERT INTO linear_states (id, name, position, color, type, created_at, updated_at)
          VALUES (${state.id}, ${state.name}, ${state.position}, ${state.color ?? null}, ${state.type ?? null}, ${now}, ${now})
        `
      }
    })
  }

  private async upsertUsers(
    users: Array<{ id: string; name: string; active?: boolean }>,
  ): Promise<void> {
    const now = new Date().toISOString()
    for (const user of users) {
      await this.sql`
        INSERT INTO linear_users (id, name, active, updated_at)
        VALUES (${user.id}, ${user.name}, ${user.active === false ? 0 : 1}, ${now})
        ON CONFLICT(id) DO UPDATE SET
          name = EXCLUDED.name,
          active = EXCLUDED.active,
          updated_at = EXCLUDED.updated_at
      `
    }
  }

  private async upsertProjects(
    projects: Array<{ id: string; name: string; url?: string | null; state?: string | null }>,
  ): Promise<void> {
    const now = new Date().toISOString()
    for (const project of projects) {
      await this.sql`
        INSERT INTO linear_projects (id, name, url, state, updated_at)
        VALUES (${project.id}, ${project.name}, ${project.url ?? null}, ${project.state ?? null}, ${now})
        ON CONFLICT(id) DO UPDATE SET
          name = EXCLUDED.name,
          url = EXCLUDED.url,
          state = EXCLUDED.state,
          updated_at = EXCLUDED.updated_at
      `
    }
  }

  private async saveActivity(rows: LinearActivityRow[]): Promise<void> {
    for (const row of rows) {
      await this.sql`
        INSERT INTO linear_activity (issue_id, history_id, item_field, from_value, to_value, created_at)
        VALUES (${row.issue_id}, ${row.history_id}, ${row.item_field}, ${row.from_value}, ${row.to_value}, ${row.created_at})
        ON CONFLICT(issue_id, history_id, item_field) DO NOTHING
      `
    }
  }

  private async upsertIssues(
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
    for (const issue of issues) {
      const nextDescription = issue.description ?? ''
      const [prior] = await this.sql<{ description: string }[]>`
        SELECT description FROM linear_issues WHERE id = ${issue.id} LIMIT 1
      `
      if (prior && prior.description !== nextDescription) {
        await this.saveActivity([
          {
            issue_id: issue.id,
            history_id: `desc:${issue.updatedAt}`,
            item_field: 'description',
            from_value: clampActivityValue(prior.description),
            to_value: clampActivityValue(nextDescription),
            created_at: issue.updatedAt,
          },
        ])
      }

      const hasCommentCount = issue.commentCount !== undefined && issue.commentCount !== null
      await this.sql`
        INSERT INTO linear_issues (
          id, identifier, title, description, priority, assignee_id, assignee_name,
          project_id, project_name, state_id, state_name, state_position, labels, comment_count,
          url, created_at, updated_at
        ) VALUES (
          ${issue.id}, ${issue.identifier}, ${issue.title}, ${nextDescription}, ${issue.priority ?? 0},
          ${issue.assigneeId ?? null}, ${issue.assigneeName ?? ''}, ${issue.projectId ?? null},
          ${issue.projectName ?? ''}, ${issue.stateId}, ${issue.stateName}, ${issue.statePosition},
          ${JSON.stringify(issue.labels ?? [])}, ${hasCommentCount ? (issue.commentCount ?? 0) : 0},
          ${issue.url ?? null}, ${issue.createdAt}, ${issue.updatedAt}
        )
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
          labels = EXCLUDED.labels,
          comment_count = CASE
            WHEN ${hasCommentCount} THEN EXCLUDED.comment_count
            ELSE linear_issues.comment_count
          END,
          url = EXCLUDED.url,
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at
      `
    }
  }

  private async deleteIssue(idOrIdentifier: string): Promise<void> {
    await this.sql`
      DELETE FROM linear_activity
      WHERE issue_id = ${idOrIdentifier}
         OR issue_id IN (SELECT id FROM linear_issues WHERE identifier = ${idOrIdentifier})
    `
    await this
      .sql`DELETE FROM linear_issues WHERE id = ${idOrIdentifier} OR identifier = ${idOrIdentifier}`
  }

  private async pruneIssues(liveIssueIds: string[]): Promise<void> {
    if (liveIssueIds.length === 0) {
      await this.sql`DELETE FROM linear_activity`
      await this.sql`DELETE FROM linear_issues`
      return
    }
    await this.sql`
      DELETE FROM linear_activity
      WHERE issue_id IN (
        SELECT id FROM linear_issues WHERE NOT (id = ANY(${liveIssueIds}))
      )
    `
    await this.sql`DELETE FROM linear_issues WHERE NOT (id = ANY(${liveIssueIds}))`
  }

  private async adjustIssueCommentCount(idOrIdentifier: string, delta: number): Promise<void> {
    await this.sql`
      UPDATE linear_issues
      SET comment_count = GREATEST(0, comment_count + ${delta})
      WHERE id = ${idOrIdentifier} OR identifier = ${idOrIdentifier}
    `
  }

  private async getCachedColumns(): Promise<LinearStateRow[]> {
    return this.sql<LinearStateRow[]>`SELECT * FROM linear_states ORDER BY position, name`
  }

  private async getCachedBoard(): Promise<BoardView> {
    const columns = await this.getCachedColumns()
    const boardColumns = []
    for (const column of columns) {
      const tasks = (
        await this.sql<LinearIssueRow[]>`
          SELECT * FROM linear_issues
          WHERE state_id = ${column.id}
          ORDER BY updated_at DESC, title ASC
        `
      ).map(taskFromRow)
      boardColumns.push({ ...column, tasks })
    }
    return { columns: boardColumns }
  }

  private async getCachedTask(lookup: string): Promise<Task | null> {
    const normalized = lookup.startsWith('linear:') ? lookup.slice('linear:'.length) : lookup
    const [row] = await this.sql<LinearIssueRow[]>`
      SELECT * FROM linear_issues
      WHERE id = ${normalized} OR identifier = ${normalized}
      LIMIT 1
    `
    return row ? taskFromRow(row) : null
  }

  private async getCachedTasks(): Promise<Task[]> {
    return (
      await this.sql<LinearIssueRow[]>`
        SELECT * FROM linear_issues ORDER BY updated_at DESC, title ASC
      `
    ).map(taskFromRow)
  }

  private async getCachedConfig(): Promise<BoardConfig> {
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

  private async getCachedActivity(
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

  private async sync(force = false): Promise<void> {
    await this.ready
    const meta = await this.loadSyncMeta()
    const lastSyncAtMs = parseTimestamp(meta.lastSyncAt)
    const lastFullSyncAtMs = parseTimestamp(meta.lastFullSyncAt)
    const now = Date.now()
    if (!force && lastSyncAtMs && now - lastSyncAtMs < this.pollingSyncIntervalMs) return

    const shouldFullSync =
      force ||
      !lastFullSyncAtMs ||
      !meta.lastIssueUpdatedAt ||
      now - lastFullSyncAtMs >= FULL_RECONCILIATION_INTERVAL_MS

    const team = await this.client.getTeam(this.teamId)
    const [users, projects, issues] = await Promise.all([
      this.client.listUsers(),
      this.client.listProjects(),
      this.client.listIssues(
        team.id,
        shouldFullSync ? undefined : (meta.lastIssueUpdatedAt ?? undefined),
      ),
    ])

    await this.replaceStates(team.states)
    await this.upsertUsers(users)
    await this.upsertProjects(projects)
    await this.upsertIssues(
      issues.map((issue) => ({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? '',
        priority: issue.priority ?? 0,
        assigneeId: issue.assignee?.id ?? null,
        assigneeName: issue.assignee?.name ?? null,
        projectId: issue.project?.id ?? null,
        projectName: issue.project?.name ?? null,
        stateId: issue.state.id,
        stateName: issue.state.name,
        statePosition: issue.state.position,
        labels: issue.labels ?? [],
        commentCount: issue.commentCount,
        url: issue.url ?? null,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
      })),
    )
    if (shouldFullSync) await this.pruneIssues(issues.map((issue) => issue.id))

    const newestIssueTimestamp = maxTimestamp(
      meta.lastIssueUpdatedAt,
      issues.length > 0
        ? issues.reduce(
            (latest, issue) => (issue.updatedAt > latest ? issue.updatedAt : latest),
            issues[0]!.updatedAt,
          )
        : null,
    )

    await this.ingestTeamHistory(
      issues.map((issue) => issue.id),
      meta.lastIssueUpdatedAt,
    ).catch((err) => {
      console.warn('[linear] issueHistory ingest failed:', err)
    })

    const syncedAt = new Date().toISOString()
    await this.saveSyncMeta({
      team: { id: team.id, key: team.key, name: team.name },
      lastSyncAt: syncedAt,
      lastFullSyncAt: shouldFullSync ? syncedAt : undefined,
      lastIssueUpdatedAt: newestIssueTimestamp ?? syncedAt,
    })
  }

  private async ingestTeamHistory(issueIds: string[], sinceIso: string | null): Promise<void> {
    if (issueIds.length === 0) return
    const concurrency = 5
    for (let i = 0; i < issueIds.length; i += concurrency) {
      const batch = issueIds.slice(i, i + concurrency)
      const results = await Promise.all(
        batch.map((issueId) => this.fetchIssueHistory(issueId, sinceIso)),
      )
      const rows = results.flat()
      if (rows.length > 0) await this.saveActivity(rows)
    }
  }

  private async fetchIssueHistory(
    issueId: string,
    sinceIso: string | null,
  ): Promise<LinearActivityRow[]> {
    const rows: LinearActivityRow[] = []
    let cursor: string | null = null
    for (let page = 0; page < 10; page++) {
      const batch = await this.client.listIssueHistory({ issueId, first: 50, after: cursor })
      let reachedKnown = false
      for (const node of batch.nodes) {
        if (sinceIso && node.createdAt <= sinceIso) {
          reachedKnown = true
          break
        }
        if (!node.fromState && !node.toState) continue
        rows.push({
          issue_id: issueId,
          history_id: node.id,
          item_field: 'state',
          from_value: node.fromState?.id ?? null,
          to_value: node.toState?.id ?? null,
          created_at: node.createdAt,
        })
      }
      if (reachedKnown) break
      if (!batch.pageInfo.hasNextPage || !batch.pageInfo.endCursor) break
      cursor = batch.pageInfo.endCursor
    }
    return rows
  }

  private async resolveTask(idOrRef: string): Promise<Task> {
    const task = await this.getCachedTask(idOrRef)
    if (!task) {
      throw new KanbanError(ErrorCode.TASK_NOT_FOUND, `No task with id '${idOrRef}'`)
    }
    return task
  }

  private async resolveState(column: string): Promise<Column> {
    const states = await this.getCachedColumns()
    const match = states.find(
      (state) => state.id === column || state.name.toLowerCase() === column.toLowerCase(),
    )
    if (!match) {
      throw new KanbanError(
        ErrorCode.COLUMN_NOT_FOUND,
        `No Linear workflow state matching '${column}'`,
      )
    }
    return match
  }

  private async resolveAssigneeId(name?: string): Promise<string | undefined> {
    if (!name) return undefined
    const [row] = await this.sql<{ id: string }[]>`
      SELECT id FROM linear_users WHERE LOWER(name) = LOWER(${name}) LIMIT 1
    `
    return row?.id
  }

  private async resolveProjectId(name?: string): Promise<string | undefined> {
    if (!name) return undefined
    const [row] = await this.sql<{ id: string }[]>`
      SELECT id FROM linear_projects WHERE LOWER(name) = LOWER(${name}) LIMIT 1
    `
    return row?.id
  }

  private toTaskComment(task: Task, comment: LinearComment): TaskComment {
    return {
      id: comment.id,
      task_id: task.id,
      body: comment.body,
      author: comment.user?.displayName || comment.user?.name || null,
      created_at: comment.createdAt,
      updated_at: comment.updatedAt,
    }
  }

  async syncCache(): Promise<void> {
    await this.sync()
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
    return {
      provider: 'linear',
      capabilities: LINEAR_CAPABILITIES,
      team: (await this.loadSyncMeta()).team,
    }
  }

  async getBootstrap(): Promise<BoardBootstrap> {
    await this.sync()
    return {
      provider: 'linear',
      capabilities: LINEAR_CAPABILITIES,
      board: await this.getCachedBoard(),
      config: await this.getCachedConfig(),
      metrics: null,
      activity: [],
      team: (await this.loadSyncMeta()).team,
    }
  }

  async getBoard(): Promise<BoardView> {
    await this.sync()
    return this.getCachedBoard()
  }

  async listColumns(): Promise<Column[]> {
    await this.sync()
    return this.getCachedColumns()
  }

  async listTasks(filters: TaskListFilters = {}): Promise<Task[]> {
    await this.sync()
    let tasks = await this.getCachedTasks()
    if (filters.column) {
      const column = await this.resolveState(filters.column)
      tasks = tasks.filter((task) => task.column_id === column.id)
    }
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
    return this.resolveTask(idOrRef)
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    await this.sync()
    const state = input.column ? await this.resolveState(input.column) : undefined
    const labelIds = await this.resolveLabelIds(input.labels)
    const result = await this.client.createIssue({
      teamId: await this.resolvedTeamId(),
      stateId: state?.id,
      title: input.title,
      description: input.description,
      priority: toLinearPriority(input.priority),
      assigneeId: await this.resolveAssigneeId(input.assignee),
      projectId: await this.resolveProjectId(input.project),
      labelIds,
    })
    if (!result.success || !result.issue) {
      throw new KanbanError(ErrorCode.PROVIDER_UPSTREAM_ERROR, 'Linear issue creation failed')
    }
    const issue = result.issue
    await this.upsertIssues([
      {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? '',
        priority: issue.priority ?? 0,
        assigneeId: issue.assignee?.id ?? null,
        assigneeName: issue.assignee?.name ?? issue.assignee?.displayName ?? '',
        projectId: issue.project?.id ?? null,
        projectName: issue.project?.name ?? '',
        stateId: issue.state.id,
        stateName: issue.state.name,
        statePosition: issue.state.position,
        labels: issue.labels ?? [],
        commentCount: issue.commentCount,
        url: issue.url ?? null,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
      },
    ])
    return this.resolveTask(issue.id)
  }

  private async resolveLabelIds(labels: string[] | undefined): Promise<string[] | undefined> {
    if (!labels?.some((label) => label.trim())) return undefined
    return resolveLinearLabelIds(labels, await this.client.listIssueLabels())
  }

  async updateTask(idOrRef: string, input: UpdateTaskInput): Promise<Task> {
    await this.sync()
    const task = await this.resolveTask(idOrRef)
    if (input.expectedVersion !== undefined && task.version !== input.expectedVersion) {
      throw new KanbanError(
        ErrorCode.CONFLICT,
        `Linear issue ${task.externalRef ?? idOrRef} was updated remotely (expected version ${input.expectedVersion}, current ${task.version ?? 'unknown'})`,
      )
    }
    const updateInput: Record<string, unknown> = {}
    if (input.title !== undefined) updateInput['title'] = input.title
    if (input.description !== undefined) updateInput['description'] = input.description
    if (input.priority !== undefined) updateInput['priority'] = toLinearPriority(input.priority)
    if (input.assignee !== undefined)
      updateInput['assigneeId'] = input.assignee
        ? ((await this.resolveAssigneeId(input.assignee)) ?? null)
        : null
    if (input.project !== undefined)
      updateInput['projectId'] = input.project
        ? ((await this.resolveProjectId(input.project)) ?? null)
        : null
    if (input.metadata !== undefined) {
      unsupportedOperation('Linear mode does not support metadata updates')
    }
    const result = await this.client.updateIssue(task.providerId || task.id, updateInput)
    if (!result.success) {
      throw new KanbanError(ErrorCode.PROVIDER_UPSTREAM_ERROR, 'Linear issue update failed')
    }
    await this.sync(true)
    return this.resolveTask(task.providerId || task.id)
  }

  async moveTask(idOrRef: string, column: string): Promise<Task> {
    await this.sync()
    const task = await this.resolveTask(idOrRef)
    const state = await this.resolveState(column)
    const result = await this.client.updateIssue(task.providerId || task.id, { stateId: state.id })
    if (!result.success) {
      throw new KanbanError(ErrorCode.PROVIDER_UPSTREAM_ERROR, 'Linear issue move failed')
    }
    await this.sync(true)
    return this.resolveTask(task.providerId || task.id)
  }

  async deleteTask(_idOrRef: string): Promise<Task> {
    unsupportedOperation('Task deletion is not supported in Linear mode')
  }

  async listComments(idOrRef: string): Promise<TaskComment[]> {
    await this.sync()
    const task = await this.resolveTask(idOrRef)
    const comments = await this.client.listComments(task.providerId || task.id)
    return comments.map((comment) => this.toTaskComment(task, comment))
  }

  async getComment(idOrRef: string, commentId: string): Promise<TaskComment> {
    await this.sync()
    const task = await this.resolveTask(idOrRef)
    const comment = await this.client.getComment(commentId)
    return this.toTaskComment(task, comment)
  }

  async comment(idOrRef: string, body: string): Promise<TaskComment> {
    await this.sync()
    const task = await this.resolveTask(idOrRef)
    const result = await this.client.commentCreate(task.providerId || task.id, body)
    if (!result.success || !result.comment) {
      throw new KanbanError(ErrorCode.PROVIDER_UPSTREAM_ERROR, 'Linear comment creation failed')
    }
    await this.adjustIssueCommentCount(task.providerId || task.id, 1)
    return this.toTaskComment(task, result.comment)
  }

  async updateComment(idOrRef: string, commentId: string, body: string): Promise<TaskComment> {
    await this.sync()
    const task = await this.resolveTask(idOrRef)
    const result = await this.client.commentUpdate(commentId, body)
    if (!result.success || !result.comment) {
      throw new KanbanError(ErrorCode.PROVIDER_UPSTREAM_ERROR, 'Linear comment update failed')
    }
    return this.toTaskComment(task, result.comment)
  }

  async getActivity(limit?: number, taskId?: string): Promise<ActivityEntry[]> {
    await this.sync()
    const issueId = taskId ? await this.resolveIssueIdFromTaskId(taskId) : undefined
    const rows = await this.getCachedActivity({
      ...(issueId !== undefined ? { issueId } : {}),
      limit: limit ?? 100,
    })
    return rows.map((row) => this.activityRowToEntry(row))
  }

  private async resolveIssueIdFromTaskId(taskId: string): Promise<string | undefined> {
    const normalized = taskId.startsWith('linear:') ? taskId.slice('linear:'.length) : taskId
    const [row] = await this.sql<{ id: string }[]>`
      SELECT id FROM linear_issues WHERE id = ${normalized} OR identifier = ${normalized} LIMIT 1
    `
    return row?.id
  }

  private activityRowToEntry(row: LinearActivityRow): ActivityEntry {
    return {
      id: `linear-activity:${row.issue_id}:${row.history_id}:${row.item_field}`,
      task_id: `linear:${row.issue_id}`,
      action: row.item_field === 'state' ? 'moved' : 'updated',
      field_changed: row.item_field,
      old_value: row.from_value,
      new_value: row.to_value,
      timestamp: row.created_at,
    }
  }

  async getMetrics(): Promise<BoardMetrics> {
    unsupportedOperation('Metrics are not available in Linear mode')
  }

  async getConfig(): Promise<BoardConfig> {
    await this.sync()
    return this.getCachedConfig()
  }

  async patchConfig(_input: Partial<BoardConfig>): Promise<BoardConfig> {
    unsupportedOperation('Config mutation is not supported in Linear mode')
  }

  async handleWebhook(payload: WebhookRequest): Promise<WebhookResult> {
    const meta = extractWebhookMeta('linear', payload.rawBody)
    let result: WebhookResult
    try {
      result = await this.handleWebhookInner(payload)
    } catch (err) {
      void recordWebhookEvent(this.sql, {
        provider: 'linear',
        ...meta,
        status: 'error',
        detail: { error: err instanceof Error ? err.message : String(err) },
      })
      throw err
    }
    void recordWebhookEvent(this.sql, {
      provider: 'linear',
      ...meta,
      status: webhookEventStatus(result),
    })
    return result
  }

  private async handleWebhookInner(payload: WebhookRequest): Promise<WebhookResult> {
    const secret = process.env['LINEAR_WEBHOOK_SECRET']
    if (secret) {
      const sig = headerLower(payload.headers, 'linear-signature')
      if (!verifyHmacSha256(secret, payload.rawBody, sig)) {
        return { handled: false, unauthorized: true, message: 'Invalid signature' }
      }
    }
    let body: {
      action?: 'create' | 'update' | 'remove'
      type?: string
      data?: {
        id: string
        identifier?: string
        title?: string
        description?: string | null
        priority?: number | null
        url?: string | null
        createdAt?: string
        updatedAt?: string
        assignee?: { id: string; name?: string | null } | null
        assigneeId?: string | null
        project?: { id: string; name: string } | null
        projectId?: string | null
        state?: { id: string; name: string; position?: number } | null
        stateId?: string | null
        team?: { id?: string | null; key?: string | null } | null
        teamId?: string | null
        labels?: Array<{ id: string; name: string }> | null
        commentCount?: number | null
      }
    } = {}
    try {
      body = JSON.parse(payload.rawBody) as typeof body
    } catch {
      return { handled: false, message: 'Invalid JSON body' }
    }
    if (body.type !== 'Issue') {
      return { handled: false, message: `Ignoring ${body.type ?? 'unknown'} event` }
    }
    const data = body.data
    if (!data) return { handled: false, message: 'No data in payload' }

    if (body.action === 'remove') {
      await this.deleteIssue(data.id)
      await this.saveSyncMeta({ lastWebhookAt: new Date().toISOString() })
      return { handled: true }
    }

    if (body.action === 'create' || body.action === 'update') {
      const configuredTeam = await this.getConfiguredTeam()
      const payloadTeamId = data.team?.id ?? data.teamId ?? null
      if (payloadTeamId && payloadTeamId !== configuredTeam.id) {
        return {
          handled: false,
          message: `Ignoring issue from team '${payloadTeamId}'`,
        }
      }

      if (!payloadTeamId) {
        const issueTeam = await this.client.getIssueTeam(data.id)
        if (!issueTeam) {
          return {
            handled: false,
            message: `Ignoring issue '${data.id}' because its team could not be verified`,
          }
        }
        if (issueTeam.id !== configuredTeam.id) {
          return {
            handled: false,
            message: `Ignoring issue from team '${issueTeam.key}'`,
          }
        }
      }

      if (!data.identifier || !data.title || !data.createdAt || !data.updatedAt) {
        return { handled: false, message: 'Missing required issue fields' }
      }
      const stateId = data.state?.id ?? data.stateId ?? null
      if (!stateId) return { handled: false, message: 'Missing state id' }
      await this.upsertIssues([
        {
          id: data.id,
          identifier: data.identifier,
          title: data.title,
          description: data.description ?? '',
          priority: data.priority ?? 0,
          assigneeId: data.assignee?.id ?? data.assigneeId ?? null,
          assigneeName: data.assignee?.name ?? null,
          projectId: data.project?.id ?? data.projectId ?? null,
          projectName: data.project?.name ?? null,
          stateId,
          stateName: data.state?.name ?? '',
          statePosition: data.state?.position ?? 0,
          labels: (data.labels ?? []).map((label) => label.name),
          commentCount: data.commentCount,
          url: data.url ?? null,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
        },
      ])
      await this.saveSyncMeta({ lastWebhookAt: new Date().toISOString() })
      return { handled: true }
    }

    return { handled: false, message: `Unsupported action: ${body.action}` }
  }
}
