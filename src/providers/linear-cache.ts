import type { Database } from 'bun:sqlite'
import type { BoardConfig, BoardView, ProviderTeamInfo, Task } from '../types.ts'

export interface LinearStateRow {
  id: string
  name: string
  position: number
  color: string | null
  type: string | null
  created_at: string
  updated_at: string
}

export interface LinearSyncMeta {
  team: ProviderTeamInfo | null
  lastSyncAt: string | null
  lastIssueUpdatedAt: string | null
}

export function initLinearCacheSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS linear_sync_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS linear_states (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      position INTEGER NOT NULL,
      color TEXT,
      type TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS linear_users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS linear_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT,
      state TEXT,
      updated_at TEXT NOT NULL
    )
  `)
  db.run(`
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
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_linear_issues_state_id ON linear_issues(state_id)')
  db.run('CREATE INDEX IF NOT EXISTS idx_linear_issues_updated_at ON linear_issues(updated_at)')
  migrateLinearCacheSchema(db)
}

export function migrateLinearCacheSchema(db: Database): void {
  const cols = db.query('PRAGMA table_info(linear_issues)').all() as { name: string }[]
  if (!cols.some((c) => c.name === 'labels')) {
    db.run("ALTER TABLE linear_issues ADD COLUMN labels TEXT NOT NULL DEFAULT '[]'")
  }
  if (!cols.some((c) => c.name === 'comment_count')) {
    db.run('ALTER TABLE linear_issues ADD COLUMN comment_count INTEGER NOT NULL DEFAULT 0')
  }
}

function setMeta(db: Database, key: string, value: string): void {
  db.query(
    `INSERT INTO linear_sync_meta (key, value) VALUES ($key, $value)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run({ $key: key, $value: value })
}

function getMeta(db: Database, key: string): string | null {
  const row = db.query('SELECT value FROM linear_sync_meta WHERE key = $key').get({
    $key: key,
  }) as { value: string } | null
  return row?.value ?? null
}

export function saveSyncMeta(db: Database, meta: LinearSyncMeta): void {
  if (meta.team) setMeta(db, 'team', JSON.stringify(meta.team))
  if (meta.lastSyncAt) setMeta(db, 'lastSyncAt', meta.lastSyncAt)
  if (meta.lastIssueUpdatedAt) setMeta(db, 'lastIssueUpdatedAt', meta.lastIssueUpdatedAt)
}

export function loadSyncMeta(db: Database): LinearSyncMeta {
  const teamRaw = getMeta(db, 'team')
  return {
    team: teamRaw ? (JSON.parse(teamRaw) as ProviderTeamInfo) : null,
    lastSyncAt: getMeta(db, 'lastSyncAt'),
    lastIssueUpdatedAt: getMeta(db, 'lastIssueUpdatedAt'),
  }
}

export function replaceStates(
  db: Database,
  states: Array<{
    id: string
    name: string
    position: number
    color?: string | null
    type?: string | null
  }>,
): void {
  const run = db.transaction(() => {
    db.run('DELETE FROM linear_states')
    const stmt = db.prepare(
      `INSERT INTO linear_states (id, name, position, color, type, created_at, updated_at)
       VALUES ($id, $name, $position, $color, $type, datetime('now'), datetime('now'))`,
    )
    for (const state of states) {
      stmt.run({
        $id: state.id,
        $name: state.name,
        $position: state.position,
        $color: state.color ?? null,
        $type: state.type ?? null,
      })
    }
  })
  run()
}

export function upsertUsers(
  db: Database,
  users: Array<{ id: string; name: string; active?: boolean }>,
): void {
  const stmt = db.prepare(
    `INSERT INTO linear_users (id, name, active, updated_at)
     VALUES ($id, $name, $active, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       active = excluded.active,
       updated_at = excluded.updated_at`,
  )
  for (const user of users) {
    stmt.run({ $id: user.id, $name: user.name, $active: user.active === false ? 0 : 1 })
  }
}

export function upsertProjects(
  db: Database,
  projects: Array<{ id: string; name: string; url?: string | null; state?: string | null }>,
): void {
  const stmt = db.prepare(
    `INSERT INTO linear_projects (id, name, url, state, updated_at)
     VALUES ($id, $name, $url, $state, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       url = excluded.url,
       state = excluded.state,
       updated_at = excluded.updated_at`,
  )
  for (const project of projects) {
    stmt.run({
      $id: project.id,
      $name: project.name,
      $url: project.url ?? null,
      $state: project.state ?? null,
    })
  }
}

export function upsertIssues(
  db: Database,
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
): void {
  const stmt = db.prepare(
    `INSERT INTO linear_issues (
      id, identifier, title, description, priority, assignee_id, assignee_name,
      project_id, project_name, state_id, state_name, state_position, labels, comment_count,
      url, created_at, updated_at
    ) VALUES (
      $id, $identifier, $title, $description, $priority, $assignee_id, $assignee_name,
      $project_id, $project_name, $state_id, $state_name, $state_position, $labels, $comment_count,
      $url, $created_at, $updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      identifier = excluded.identifier,
      title = excluded.title,
      description = excluded.description,
      priority = excluded.priority,
      assignee_id = excluded.assignee_id,
      assignee_name = excluded.assignee_name,
      project_id = excluded.project_id,
      project_name = excluded.project_name,
      state_id = excluded.state_id,
      state_name = excluded.state_name,
      state_position = excluded.state_position,
      labels = excluded.labels,
      comment_count = excluded.comment_count,
      url = excluded.url,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at`,
  )
  for (const issue of issues) {
    stmt.run({
      $id: issue.id,
      $identifier: issue.identifier,
      $title: issue.title,
      $description: issue.description ?? '',
      $priority: issue.priority ?? 0,
      $assignee_id: issue.assigneeId ?? null,
      $assignee_name: issue.assigneeName ?? '',
      $project_id: issue.projectId ?? null,
      $project_name: issue.projectName ?? '',
      $state_id: issue.stateId,
      $state_name: issue.stateName,
      $state_position: issue.statePosition,
      $labels: JSON.stringify(issue.labels ?? []),
      $comment_count: issue.commentCount ?? 0,
      $url: issue.url ?? null,
      $created_at: issue.createdAt,
      $updated_at: issue.updatedAt,
    })
  }
}

export function deleteLinearIssue(db: Database, idOrIdentifier: string): void {
  db.query('DELETE FROM linear_issues WHERE id = $v OR identifier = $v').run({
    $v: idOrIdentifier,
  })
}

export function getCachedColumns(db: Database): LinearStateRow[] {
  return db.query('SELECT * FROM linear_states ORDER BY position, name').all() as LinearStateRow[]
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

function parseLabels(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
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

export function getCachedBoard(db: Database): BoardView {
  const columns = getCachedColumns(db)
  return {
    columns: columns.map((column) => ({
      ...column,
      tasks: (
        db
          .query(
            `SELECT * FROM linear_issues
             WHERE state_id = $state_id
             ORDER BY updated_at DESC, title ASC`,
          )
          .all({ $state_id: column.id }) as LinearIssueRow[]
      ).map(taskFromRow),
    })),
  }
}

export function getCachedTask(db: Database, lookup: string): Task | null {
  const normalized = lookup.startsWith('linear:') ? lookup.slice('linear:'.length) : lookup
  const row = db
    .query(
      `SELECT * FROM linear_issues
       WHERE id = $lookup OR identifier = $lookup
       LIMIT 1`,
    )
    .get({ $lookup: normalized }) as LinearIssueRow | null
  return row ? taskFromRow(row) : null
}

export function getCachedTasks(db: Database): Task[] {
  return (
    db
      .query('SELECT * FROM linear_issues ORDER BY updated_at DESC, title ASC')
      .all() as LinearIssueRow[]
  ).map(taskFromRow)
}

export function getCachedConfig(db: Database): BoardConfig {
  const members = (
    db
      .query("SELECT name FROM linear_users WHERE active = 1 AND name != '' ORDER BY name")
      .all() as { name: string }[]
  ).map((row) => ({ name: row.name, role: 'human' as const }))
  const projects = (
    db.query("SELECT name FROM linear_projects WHERE name != '' ORDER BY name").all() as {
      name: string
    }[]
  ).map((row) => row.name)
  return {
    members,
    projects,
    provider: 'linear',
    discoveredAssignees: members.map((member) => member.name),
    discoveredProjects: projects,
  }
}
