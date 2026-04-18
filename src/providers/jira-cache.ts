import type { Database } from 'bun:sqlite'
import type { BoardView, ProviderTeamInfo, Task } from '../types.ts'

// Column ids are prefixed to avoid collisions across sources:
// - board-sourced columns: 'board:<boardId>:<columnName>'
// - status-fallback columns: 'status:<statusId>'
// The provider (T04) picks ONE source per sync, so mixed-source boards
// do not occur in practice.
export interface JiraColumnRow {
  id: string
  name: string
  position: number
  status_ids: string
  source: 'board' | 'status'
}

export interface JiraSyncMeta {
  projectKey: string | null
  boardId: number | null
  lastSyncAt: string | null
  lastIssueUpdatedAt: string | null
}

export interface JiraCacheConfig {
  projectKey: string | null
  users: Array<{ accountId: string; displayName: string }>
  priorities: Array<{ id: string; name: string }>
  issueTypes: Array<{ id: string; name: string }>
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

export function initJiraCacheSchema(db: Database): void {
  db.run(`
CREATE TABLE IF NOT EXISTS jira_sync_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)
  `)
  db.run(`
CREATE TABLE IF NOT EXISTS jira_columns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  status_ids TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('board','status'))
)
  `)
  db.run(`
CREATE TABLE IF NOT EXISTS jira_users (
  account_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
)
  `)
  db.run(`
CREATE TABLE IF NOT EXISTS jira_priorities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
)
  `)
  db.run(`
CREATE TABLE IF NOT EXISTS jira_issue_types (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
)
  `)
  db.run(`
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
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_jira_issues_status_id ON jira_issues(status_id)')
  db.run('CREATE INDEX IF NOT EXISTS idx_jira_issues_updated_at ON jira_issues(updated_at)')
  migrateJiraCacheSchema(db)
}

export function migrateJiraCacheSchema(db: Database): void {
  const cols = db.query('PRAGMA table_info(jira_issues)').all() as { name: string }[]
  if (!cols.some((c) => c.name === 'labels')) {
    db.run("ALTER TABLE jira_issues ADD COLUMN labels TEXT NOT NULL DEFAULT '[]'")
  }
  if (!cols.some((c) => c.name === 'comment_count')) {
    db.run('ALTER TABLE jira_issues ADD COLUMN comment_count INTEGER NOT NULL DEFAULT 0')
  }
}

function setMeta(db: Database, key: string, value: string): void {
  db.query(
    `INSERT INTO jira_sync_meta (key, value) VALUES ($key, $value)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run({ $key: key, $value: value })
}

function deleteMeta(db: Database, key: string): void {
  db.query('DELETE FROM jira_sync_meta WHERE key = $key').run({ $key: key })
}

function getMeta(db: Database, key: string): string | null {
  const row = db.query('SELECT value FROM jira_sync_meta WHERE key = $key').get({
    $key: key,
  }) as { value: string } | null
  return row?.value ?? null
}

const META_KEYS = ['projectKey', 'boardId', 'lastSyncAt', 'lastIssueUpdatedAt'] as const
type MetaKey = (typeof META_KEYS)[number]

export function saveJiraSyncMeta(db: Database, meta: Partial<JiraSyncMeta>): void {
  for (const key of META_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(meta, key)) continue
    const value = (meta as Record<MetaKey, unknown>)[key]
    if (value === null) {
      deleteMeta(db, key)
      continue
    }
    if (key === 'boardId') {
      if (typeof value === 'number' && Number.isFinite(value)) {
        setMeta(db, key, String(value))
      }
      continue
    }
    if (typeof value === 'string') {
      setMeta(db, key, value)
    }
  }
}

export function saveTeamInfo(db: Database, team: ProviderTeamInfo | null): void {
  if (team === null) {
    deleteMeta(db, 'team')
    return
  }
  setMeta(db, 'team', JSON.stringify(team))
}

export function loadTeamInfo(db: Database): ProviderTeamInfo | null {
  const raw = getMeta(db, 'team')
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (
      parsed &&
      typeof parsed === 'object' &&
      'id' in parsed &&
      'key' in parsed &&
      'name' in parsed &&
      typeof (parsed as { id: unknown }).id === 'string' &&
      typeof (parsed as { key: unknown }).key === 'string' &&
      typeof (parsed as { name: unknown }).name === 'string'
    ) {
      const t = parsed as { id: string; key: string; name: string }
      return { id: t.id, key: t.key, name: t.name }
    }
    return null
  } catch {
    return null
  }
}

export function loadJiraSyncMeta(db: Database): JiraSyncMeta {
  const boardIdRaw = getMeta(db, 'boardId')
  const boardId = boardIdRaw === null ? null : Number.parseInt(boardIdRaw, 10)
  return {
    projectKey: getMeta(db, 'projectKey'),
    boardId: boardId === null || Number.isNaN(boardId) ? null : boardId,
    lastSyncAt: getMeta(db, 'lastSyncAt'),
    lastIssueUpdatedAt: getMeta(db, 'lastIssueUpdatedAt'),
  }
}

export function replaceJiraColumns(
  db: Database,
  columns: Array<{
    id: string
    name: string
    position: number
    statusIds: string[]
    source: 'board' | 'status'
  }>,
): void {
  const run = db.transaction(() => {
    db.run('DELETE FROM jira_columns')
    const stmt = db.prepare(
      `INSERT INTO jira_columns (id, name, position, status_ids, source)
       VALUES ($id, $name, $position, $status_ids, $source)`,
    )
    for (const column of columns) {
      stmt.run({
        $id: column.id,
        $name: column.name,
        $position: column.position,
        $status_ids: JSON.stringify(column.statusIds),
        $source: column.source,
      })
    }
  })
  run()
}

export function upsertJiraUsers(
  db: Database,
  users: Array<{ accountId: string; displayName: string; active?: boolean }>,
): void {
  const stmt = db.prepare(
    `INSERT INTO jira_users (account_id, display_name, active, updated_at)
     VALUES ($account_id, $display_name, $active, datetime('now'))
     ON CONFLICT(account_id) DO UPDATE SET
       display_name = excluded.display_name,
       active = excluded.active,
       updated_at = excluded.updated_at`,
  )
  for (const user of users) {
    stmt.run({
      $account_id: user.accountId,
      $display_name: user.displayName,
      $active: user.active === false ? 0 : 1,
    })
  }
}

export function replaceJiraPriorities(
  db: Database,
  priorities: Array<{ id: string; name: string }>,
): void {
  const run = db.transaction(() => {
    db.run('DELETE FROM jira_priorities')
    const stmt = db.prepare('INSERT INTO jira_priorities (id, name) VALUES ($id, $name)')
    for (const priority of priorities) {
      stmt.run({ $id: priority.id, $name: priority.name })
    }
  })
  run()
}

export function replaceJiraIssueTypes(
  db: Database,
  types: Array<{ id: string; name: string }>,
): void {
  const run = db.transaction(() => {
    db.run('DELETE FROM jira_issue_types')
    const stmt = db.prepare('INSERT INTO jira_issue_types (id, name) VALUES ($id, $name)')
    for (const type of types) {
      stmt.run({ $id: type.id, $name: type.name })
    }
  })
  run()
}

export function upsertJiraIssues(
  db: Database,
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
): void {
  const stmt = db.prepare(
    `INSERT INTO jira_issues (
      id, key, summary, description_text, status_id, priority_name, issue_type_name,
      assignee_account_id, assignee_name, labels, comment_count, project_key, url, created_at, updated_at
    ) VALUES (
      $id, $key, $summary, $description_text, $status_id, $priority_name, $issue_type_name,
      $assignee_account_id, $assignee_name, $labels, $comment_count, $project_key, $url, $created_at, $updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      key = excluded.key,
      summary = excluded.summary,
      description_text = excluded.description_text,
      status_id = excluded.status_id,
      priority_name = excluded.priority_name,
      issue_type_name = excluded.issue_type_name,
      assignee_account_id = excluded.assignee_account_id,
      assignee_name = excluded.assignee_name,
      labels = excluded.labels,
      comment_count = excluded.comment_count,
      project_key = excluded.project_key,
      url = excluded.url,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at`,
  )
  for (const issue of issues) {
    stmt.run({
      $id: issue.id,
      $key: issue.key,
      $summary: issue.summary,
      $description_text: issue.descriptionText,
      $status_id: issue.statusId,
      $priority_name: issue.priorityName ?? '',
      $issue_type_name: issue.issueTypeName ?? '',
      $assignee_account_id: issue.assigneeAccountId ?? null,
      $assignee_name: issue.assigneeName ?? '',
      $labels: JSON.stringify(issue.labels ?? []),
      $comment_count: issue.commentCount ?? 0,
      $project_key: issue.projectKey,
      $url: issue.url ?? null,
      $created_at: issue.createdAt,
      $updated_at: issue.updatedAt,
    })
  }
}

export function deleteJiraIssue(db: Database, idOrKey: string): void {
  db.query('DELETE FROM jira_issues WHERE id = $v OR key = $v').run({ $v: idOrKey })
}

export function decodeColumnStatusIds(row: Pick<JiraColumnRow, 'status_ids'>): string[] {
  try {
    const parsed: unknown = JSON.parse(row.status_ids)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

export function getCachedColumns(db: Database): JiraColumnRow[] {
  return db.query('SELECT * FROM jira_columns ORDER BY position, name').all() as JiraColumnRow[]
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
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
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

function selectIssuesByStatusIds(db: Database, statusIds: string[]): JiraIssueRow[] {
  if (statusIds.length === 0) return []
  const placeholders = statusIds.map((_, i) => `$s${i}`).join(', ')
  const params: Record<string, string> = {}
  statusIds.forEach((id, i) => {
    params[`$s${i}`] = id
  })
  return db
    .query(
      `SELECT * FROM jira_issues
       WHERE status_id IN (${placeholders})
       ORDER BY updated_at DESC, summary ASC`,
    )
    .all(params) as JiraIssueRow[]
}

export function getCachedBoard(db: Database): BoardView {
  const columns = getCachedColumns(db)
  return {
    columns: columns.map((column) => {
      const statusIds = decodeColumnStatusIds(column)
      const tasks = selectIssuesByStatusIds(db, statusIds).map(taskFromRow)
      return {
        id: column.id,
        name: column.name,
        position: column.position,
        color: null,
        created_at: '',
        updated_at: '',
        tasks,
      }
    }),
  }
}

export function getCachedTask(db: Database, lookup: string): Task | null {
  const normalized = lookup.startsWith('jira:') ? lookup.slice('jira:'.length) : lookup
  const row = db
    .query(
      `SELECT * FROM jira_issues
       WHERE id = $lookup OR key = $lookup
       LIMIT 1`,
    )
    .get({ $lookup: normalized }) as JiraIssueRow | null
  return row ? taskFromRow(row) : null
}

export function getCachedTasks(db: Database, params?: { columnId?: string }): Task[] {
  if (params?.columnId !== undefined) {
    const columnRow = db
      .query('SELECT status_ids FROM jira_columns WHERE id = $id')
      .get({ $id: params.columnId }) as Pick<JiraColumnRow, 'status_ids'> | null
    if (!columnRow) return []
    const statusIds = decodeColumnStatusIds(columnRow)
    return selectIssuesByStatusIds(db, statusIds).map(taskFromRow)
  }
  return (
    db
      .query('SELECT * FROM jira_issues ORDER BY updated_at DESC, summary ASC')
      .all() as JiraIssueRow[]
  ).map(taskFromRow)
}

export function getCachedConfig(db: Database): JiraCacheConfig {
  const users = (
    db
      .query(
        'SELECT account_id, display_name FROM jira_users WHERE active = 1 ORDER BY display_name',
      )
      .all() as { account_id: string; display_name: string }[]
  ).map((row) => ({ accountId: row.account_id, displayName: row.display_name }))
  const priorities = db.query('SELECT id, name FROM jira_priorities ORDER BY name').all() as Array<{
    id: string
    name: string
  }>
  const issueTypes = db
    .query('SELECT id, name FROM jira_issue_types ORDER BY name')
    .all() as Array<{ id: string; name: string }>
  return {
    projectKey: getMeta(db, 'projectKey'),
    users,
    priorities,
    issueTypes,
  }
}
