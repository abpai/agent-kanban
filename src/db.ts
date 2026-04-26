import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { generateId } from './id'
import { ErrorCode, KanbanError } from './errors'
import type { BoardView, Column, Priority, Task, TaskComment, TaskWithColumn } from './types'
import { logActivity, enterColumn, exitColumn } from './activity'

const DEFAULT_COLUMNS = [
  { name: 'recurring', position: 0 },
  { name: 'backlog', position: 1 },
  { name: 'in-progress', position: 2 },
  { name: 'review', position: 3 },
  { name: 'done', position: 4 },
]

export function getDbPath(): string {
  const envPath = process.env['KANBAN_DB_PATH']
  if (envPath) return envPath

  const localPath = '.kanban/board.db'
  if (existsSync(localPath)) return localPath

  const homePath = process.env['HOME'] || homedir()
  const globalPath = join(homePath, '.kanban', 'board.db')
  if (existsSync(globalPath)) return globalPath

  return localPath
}

export function openDb(path?: string): Database {
  const dbPath = path ?? getDbPath()
  const dir = dbPath.substring(0, dbPath.lastIndexOf('/'))
  if (dir) {
    mkdirSync(dir, { recursive: true })
  }
  const db = new Database(dbPath)
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA foreign_keys = ON')
  return db
}

export function initSchema(db: Database): void {
  db.run('PRAGMA foreign_keys = ON')
  db.run(`
    CREATE TABLE IF NOT EXISTS columns (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      position INTEGER NOT NULL,
      color TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      column_id TEXT NOT NULL REFERENCES columns(id) ON DELETE RESTRICT,
      position INTEGER NOT NULL DEFAULT 0,
      priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
      assignee TEXT NOT NULL DEFAULT '',
      project TEXT NOT NULL DEFAULT '',
      metadata TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      action TEXT NOT NULL,
      field_changed TEXT,
      old_value TEXT,
      new_value TEXT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      author TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS column_time_tracking (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      column_id TEXT NOT NULL,
      entered_at TEXT NOT NULL DEFAULT (datetime('now')),
      exited_at TEXT
    )
  `)
  // Run migrations before creating indexes — existing DBs may lack newer columns
  migrateSchema(db)
  // Now safe to create all indexes
  db.run('CREATE INDEX IF NOT EXISTS idx_tasks_column_id ON tasks(column_id)')
  db.run('CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority)')
  db.run('CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee)')
  db.run('CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project)')
  db.run('CREATE INDEX IF NOT EXISTS idx_activity_task_id ON activity_log(task_id)')
  db.run('CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity_log(timestamp)')
  db.run('CREATE INDEX IF NOT EXISTS idx_comments_task_id ON comments(task_id)')
  db.run('CREATE INDEX IF NOT EXISTS idx_column_time_task_id ON column_time_tracking(task_id)')
}

export function migrateSchema(db: Database): void {
  // Guard: if tasks table doesn't exist yet, nothing to migrate
  const tables = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'")
    .all()
  if (tables.length === 0) return

  const columns = db.query('PRAGMA table_info(tasks)').all() as { name: string }[]
  const hasProject = columns.some((c) => c.name === 'project')
  if (!hasProject) {
    db.run("ALTER TABLE tasks ADD COLUMN project TEXT NOT NULL DEFAULT ''")
  }
  const hasRevision = columns.some((c) => c.name === 'revision')
  if (!hasRevision) {
    db.run('ALTER TABLE tasks ADD COLUMN revision INTEGER NOT NULL DEFAULT 0')
  }
  db.run('CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project)')
}

export function seedDefaultColumns(db: Database): void {
  const existing = db.query('SELECT COUNT(*) as count FROM columns').get() as {
    count: number
  }
  if (existing.count > 0) return
  const stmt = db.prepare('INSERT INTO columns (id, name, position) VALUES ($id, $name, $position)')
  for (const col of DEFAULT_COLUMNS) {
    stmt.run({ $id: generateId('c'), $name: col.name, $position: col.position })
  }
}

export function isInitialized(db: Database): boolean {
  const result = db
    .query("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name='columns'")
    .get() as { count: number }
  return result.count > 0
}

// --- Column CRUD ---

export function resolveColumn(db: Database, idOrName: string): Column {
  const byId = db
    .query('SELECT * FROM columns WHERE id = $id')
    .get({ $id: idOrName }) as Column | null
  if (byId) return byId
  const byName = db
    .query('SELECT * FROM columns WHERE LOWER(name) = LOWER($name)')
    .get({ $name: idOrName }) as Column | null
  if (byName) return byName
  throw new KanbanError(ErrorCode.COLUMN_NOT_FOUND, `No column matching '${idOrName}'`)
}

export function listColumns(db: Database): Column[] {
  return db.query('SELECT * FROM columns ORDER BY position').all() as Column[]
}

export function addColumn(
  db: Database,
  name: string,
  opts: { position?: number; color?: string } = {},
): Column {
  const existing = db
    .query('SELECT id FROM columns WHERE LOWER(name) = LOWER($name)')
    .get({ $name: name })
  if (existing) {
    throw new KanbanError(ErrorCode.COLUMN_NAME_EXISTS, `Column '${name}' already exists`)
  }

  const id = generateId('c')
  const position =
    opts.position ??
    (
      db.query('SELECT COALESCE(MAX(position), -1) + 1 as next FROM columns').get() as {
        next: number
      }
    ).next

  db.query('UPDATE columns SET position = position + 1 WHERE position >= $pos').run({
    $pos: position,
  })

  db.query(
    'INSERT INTO columns (id, name, position, color) VALUES ($id, $name, $position, $color)',
  ).run({
    $id: id,
    $name: name,
    $position: position,
    $color: opts.color ?? null,
  })
  return resolveColumn(db, id)
}

export function renameColumn(db: Database, idOrName: string, newName: string): Column {
  const col = resolveColumn(db, idOrName)
  const conflict = db
    .query('SELECT id FROM columns WHERE LOWER(name) = LOWER($name) AND id != $id')
    .get({ $name: newName, $id: col.id })
  if (conflict) {
    throw new KanbanError(ErrorCode.COLUMN_NAME_EXISTS, `Column '${newName}' already exists`)
  }
  db.query("UPDATE columns SET name = $name, updated_at = datetime('now') WHERE id = $id").run({
    $name: newName,
    $id: col.id,
  })
  return resolveColumn(db, col.id)
}

export function reorderColumn(db: Database, idOrName: string, newPosition: number): Column {
  const col = resolveColumn(db, idOrName)
  if (newPosition < 0) {
    throw new KanbanError(ErrorCode.INVALID_POSITION, 'Position must be >= 0')
  }
  const oldPos = col.position
  if (oldPos === newPosition) return col

  if (newPosition < oldPos) {
    db.query(
      'UPDATE columns SET position = position + 1 WHERE position >= $new AND position < $old',
    ).run({ $new: newPosition, $old: oldPos })
  } else {
    db.query(
      'UPDATE columns SET position = position - 1 WHERE position > $old AND position <= $new',
    ).run({ $old: oldPos, $new: newPosition })
  }
  db.query("UPDATE columns SET position = $pos, updated_at = datetime('now') WHERE id = $id").run({
    $pos: newPosition,
    $id: col.id,
  })
  renumberColumns(db)
  return resolveColumn(db, col.id)
}

export function deleteColumn(db: Database, idOrName: string): Column {
  const col = resolveColumn(db, idOrName)
  const taskCount = db.query('SELECT COUNT(*) as count FROM tasks WHERE column_id = $id').get({
    $id: col.id,
  }) as { count: number }
  if (taskCount.count > 0) {
    throw new KanbanError(
      ErrorCode.COLUMN_NOT_EMPTY,
      `Column '${col.name}' has ${taskCount.count} task(s). Move or delete them first.`,
    )
  }
  db.query('DELETE FROM columns WHERE id = $id').run({ $id: col.id })
  renumberColumns(db)
  return col
}

function renumberColumns(db: Database): void {
  const cols = db.query('SELECT id FROM columns ORDER BY position').all() as { id: string }[]
  const stmt = db.prepare('UPDATE columns SET position = $pos WHERE id = $id')
  cols.forEach(({ id }, i) => stmt.run({ $pos: i, $id: id }))
}

// --- Task CRUD ---

export function addTask(
  db: Database,
  title: string,
  opts: {
    description?: string
    column?: string
    priority?: Priority
    assignee?: string
    project?: string
    metadata?: string
  } = {},
): TaskWithColumn {
  const column = opts.column ? resolveColumn(db, opts.column) : resolveColumn(db, 'backlog')

  if (opts.priority && !['low', 'medium', 'high', 'urgent'].includes(opts.priority)) {
    throw new KanbanError(
      ErrorCode.INVALID_PRIORITY,
      `Invalid priority '${opts.priority}'. Must be low, medium, high, or urgent.`,
    )
  }

  if (opts.metadata) {
    try {
      JSON.parse(opts.metadata)
    } catch {
      throw new KanbanError(ErrorCode.INVALID_METADATA, 'Metadata must be valid JSON')
    }
  }

  const id = generateId('t')
  const maxPos = db
    .query('SELECT COALESCE(MAX(position), -1) + 1 as next FROM tasks WHERE column_id = $col')
    .get({ $col: column.id }) as { next: number }

  db.query(
    `INSERT INTO tasks (id, title, description, column_id, position, priority, assignee, project, metadata)
     VALUES ($id, $title, $desc, $col, $pos, $pri, $assignee, $project, $meta)`,
  ).run({
    $id: id,
    $title: title,
    $desc: opts.description ?? '',
    $col: column.id,
    $pos: maxPos.next,
    $pri: opts.priority ?? 'medium',
    $assignee: opts.assignee ?? '',
    $project: opts.project ?? '',
    $meta: opts.metadata ?? '{}',
  })
  logActivity(db, id, 'created', { new_value: title })
  enterColumn(db, id, column.id)
  return getTask(db, id)
}

export function getTask(db: Database, id: string): TaskWithColumn {
  const task = db
    .query(
      `SELECT t.*, c.name as column_name FROM tasks t
       JOIN columns c ON t.column_id = c.id WHERE t.id = $id`,
    )
    .get({ $id: id }) as TaskWithColumn | null
  if (!task) {
    throw new KanbanError(ErrorCode.TASK_NOT_FOUND, `No task with id '${id}'`)
  }
  return task
}

export function listTasks(
  db: Database,
  opts: {
    column?: string
    priority?: string
    assignee?: string
    project?: string
    limit?: number
    sort?: string
  } = {},
): TaskWithColumn[] {
  const conditions: string[] = []
  const params: Record<string, string | number> = {}

  if (opts.column) {
    const col = resolveColumn(db, opts.column)
    conditions.push('t.column_id = $col')
    params['$col'] = col.id
  }
  if (opts.priority) {
    conditions.push('t.priority = $pri')
    params['$pri'] = opts.priority
  }
  if (opts.assignee) {
    conditions.push('t.assignee = $assignee')
    params['$assignee'] = opts.assignee
  }
  if (opts.project) {
    conditions.push('t.project = $project')
    params['$project'] = opts.project
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const sortMap: Record<string, string> = {
    priority:
      "CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END",
    created: 't.created_at',
    updated: 't.updated_at',
    position: 't.position',
    title: 't.title',
  }
  const orderBy = sortMap[opts.sort ?? 'position'] ?? 't.position'
  const limitClause = opts.limit ? `LIMIT ${opts.limit}` : ''

  return db
    .query(
      `SELECT t.*, c.name as column_name FROM tasks t
       JOIN columns c ON t.column_id = c.id
       ${where} ORDER BY ${orderBy} ${limitClause}`,
    )
    .all(params as Record<string, string>) as TaskWithColumn[]
}

export function updateTask(
  db: Database,
  id: string,
  updates: {
    title?: string
    description?: string
    priority?: Priority
    assignee?: string
    project?: string
    metadata?: string
  },
): TaskWithColumn {
  const existing = getTask(db, id)

  if (updates.priority && !['low', 'medium', 'high', 'urgent'].includes(updates.priority)) {
    throw new KanbanError(
      ErrorCode.INVALID_PRIORITY,
      `Invalid priority '${updates.priority}'. Must be low, medium, high, or urgent.`,
    )
  }
  if (updates.metadata) {
    try {
      JSON.parse(updates.metadata)
    } catch {
      throw new KanbanError(ErrorCode.INVALID_METADATA, 'Metadata must be valid JSON')
    }
  }

  const sets: string[] = ["updated_at = datetime('now')", 'revision = revision + 1']
  const params: Record<string, string> = { $id: id }

  if (updates.title !== undefined) {
    sets.push('title = $title')
    params['$title'] = updates.title
  }
  if (updates.description !== undefined) {
    sets.push('description = $desc')
    params['$desc'] = updates.description
  }
  if (updates.priority !== undefined) {
    sets.push('priority = $pri')
    params['$pri'] = updates.priority
  }
  if (updates.assignee !== undefined) {
    sets.push('assignee = $assignee')
    params['$assignee'] = updates.assignee
  }
  if (updates.project !== undefined) {
    sets.push('project = $project')
    params['$project'] = updates.project
  }
  if (updates.metadata !== undefined) {
    sets.push('metadata = $meta')
    params['$meta'] = updates.metadata
  }

  db.query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $id`).run(params)

  if (updates.assignee !== undefined && updates.assignee !== existing.assignee) {
    logActivity(db, id, 'assigned', {
      field: 'assignee',
      old_value: existing.assignee || null,
      new_value: updates.assignee,
    })
  }
  if (updates.priority !== undefined && updates.priority !== existing.priority) {
    logActivity(db, id, 'prioritized', {
      field: 'priority',
      old_value: existing.priority,
      new_value: updates.priority,
    })
  }
  if (updates.project !== undefined && updates.project !== existing.project) {
    logActivity(db, id, 'updated', {
      field: 'project',
      old_value: existing.project || null,
      new_value: updates.project,
    })
  }
  const fieldsToLog: Array<{ key: keyof typeof updates; field: string }> = [
    { key: 'title', field: 'title' },
    { key: 'description', field: 'description' },
    { key: 'metadata', field: 'metadata' },
  ]
  for (const { key, field } of fieldsToLog) {
    if (updates[key] !== undefined && updates[key] !== existing[key as keyof TaskWithColumn]) {
      logActivity(db, id, 'updated', {
        field,
        old_value: String(existing[key as keyof TaskWithColumn] ?? ''),
        new_value: String(updates[key]),
      })
    }
  }

  return getTask(db, id)
}

export function deleteTask(db: Database, id: string): TaskWithColumn {
  const task = getTask(db, id)
  exitColumn(db, id, task.column_id)
  logActivity(db, id, 'deleted', { old_value: task.title })
  db.query('DELETE FROM tasks WHERE id = $id').run({ $id: id })
  renumberTasksInColumn(db, task.column_id)
  return task
}

export function getComment(db: Database, taskId: string, commentId: string): TaskComment {
  const row = db
    .query(
      `SELECT id, task_id, body, author, created_at, updated_at
         FROM comments
        WHERE id = $id AND task_id = $task_id`,
    )
    .get({
      $id: commentId,
      $task_id: taskId,
    }) as TaskComment | null
  if (!row) {
    throw new KanbanError(
      ErrorCode.COMMENT_NOT_FOUND,
      `No comment '${commentId}' exists on task '${taskId}'`,
    )
  }
  return row
}

export function listComments(db: Database, taskId: string): TaskComment[] {
  getTask(db, taskId)
  return db
    .query(
      `SELECT id, task_id, body, author, created_at, updated_at
         FROM comments
        WHERE task_id = $task_id
        ORDER BY created_at ASC, rowid ASC`,
    )
    .all({ $task_id: taskId }) as TaskComment[]
}

export function countComments(db: Database, taskId: string): number {
  const row = db
    .query('SELECT COUNT(*) as count FROM comments WHERE task_id = $task_id')
    .get({ $task_id: taskId }) as { count: number }
  return row.count
}

export function countCommentsByTask(db: Database): Map<string, number> {
  const rows = db
    .query('SELECT task_id, COUNT(*) as count FROM comments GROUP BY task_id')
    .all() as Array<{ task_id: string; count: number }>
  return new Map(rows.map((row) => [row.task_id, row.count]))
}

export function addComment(
  db: Database,
  taskId: string,
  body: string,
  author: string | null = null,
): TaskComment {
  getTask(db, taskId)
  const id = generateId('cm')
  db.query(
    `INSERT INTO comments (id, task_id, body, author)
     VALUES ($id, $task_id, $body, $author)`,
  ).run({
    $id: id,
    $task_id: taskId,
    $body: body,
    $author: author,
  })
  logActivity(db, taskId, 'updated', {
    field: 'comment',
    new_value: body,
  })
  return getComment(db, taskId, id)
}

export function updateComment(
  db: Database,
  taskId: string,
  commentId: string,
  body: string,
): TaskComment {
  const existing = getComment(db, taskId, commentId)
  db.query(
    `UPDATE comments
        SET body = $body,
            updated_at = datetime('now')
      WHERE id = $id AND task_id = $task_id`,
  ).run({
    $id: commentId,
    $task_id: taskId,
    $body: body,
  })
  logActivity(db, taskId, 'updated', {
    field: 'comment',
    old_value: existing.body,
    new_value: body,
  })
  return getComment(db, taskId, commentId)
}

export function moveTask(db: Database, id: string, columnIdOrName: string): TaskWithColumn {
  const task = getTask(db, id)
  const column = resolveColumn(db, columnIdOrName)

  const maxPos = db
    .query('SELECT COALESCE(MAX(position), -1) + 1 as next FROM tasks WHERE column_id = $col')
    .get({ $col: column.id }) as { next: number }

  const oldColumnId = task.column_id
  db.query(
    "UPDATE tasks SET column_id = $col, position = $pos, updated_at = datetime('now'), revision = revision + 1 WHERE id = $id",
  ).run({ $col: column.id, $pos: maxPos.next, $id: id })
  renumberTasksInColumn(db, oldColumnId)

  exitColumn(db, id, oldColumnId)
  enterColumn(db, id, column.id)
  logActivity(db, id, 'moved', {
    field: 'column',
    old_value: task.column_name,
    new_value: column.name,
  })

  return getTask(db, id)
}

function renumberTasksInColumn(db: Database, columnId: string): void {
  const tasks = db
    .query('SELECT id FROM tasks WHERE column_id = $col ORDER BY position')
    .all({ $col: columnId }) as { id: string }[]
  const stmt = db.prepare('UPDATE tasks SET position = $pos WHERE id = $id')
  tasks.forEach(({ id }, i) => stmt.run({ $pos: i, $id: id }))
}

// --- Board ---

export function getBoardView(db: Database): BoardView {
  const columns = listColumns(db)
  return {
    columns: columns.map((col) => ({
      ...col,
      tasks: db
        .query('SELECT * FROM tasks WHERE column_id = $col ORDER BY position')
        .all({ $col: col.id }) as Task[],
    })),
  }
}

// --- Bulk ---

export function bulkMoveAll(
  db: Database,
  fromIdOrName: string,
  toIdOrName: string,
): { moved: number } {
  const fromCol = resolveColumn(db, fromIdOrName)
  const toCol = resolveColumn(db, toIdOrName)

  const maxPos = db
    .query('SELECT COALESCE(MAX(position), -1) + 1 as next FROM tasks WHERE column_id = $col')
    .get({ $col: toCol.id }) as { next: number }

  const tasks = db
    .query('SELECT id FROM tasks WHERE column_id = $col ORDER BY position')
    .all({ $col: fromCol.id }) as { id: string }[]

  const stmt = db.prepare(
    "UPDATE tasks SET column_id = $toCol, position = $pos, updated_at = datetime('now') WHERE id = $id",
  )
  tasks.forEach(({ id }, i) => {
    stmt.run({ $toCol: toCol.id, $pos: maxPos.next + i, $id: id })
    exitColumn(db, id, fromCol.id)
    enterColumn(db, id, toCol.id)
    logActivity(db, id, 'moved', {
      field: 'column',
      old_value: fromCol.name,
      new_value: toCol.name,
    })
  })

  return { moved: tasks.length }
}

export function bulkClearDone(db: Database): { deleted: number } {
  const doneCol = db.query("SELECT id, name FROM columns WHERE LOWER(name) = 'done'").get() as {
    id: string
    name: string
  } | null
  if (!doneCol) return { deleted: 0 }

  const tasks = db
    .query('SELECT id, title FROM tasks WHERE column_id = $col')
    .all({ $col: doneCol.id }) as { id: string; title: string }[]
  for (const task of tasks) {
    exitColumn(db, task.id, doneCol.id)
    logActivity(db, task.id, 'deleted', { old_value: task.title })
  }
  db.query('DELETE FROM tasks WHERE column_id = $col').run({ $col: doneCol.id })
  return { deleted: tasks.length }
}

export function resetBoard(db: Database): void {
  db.run('DROP TABLE IF EXISTS comments')
  db.run('DROP TABLE IF EXISTS column_time_tracking')
  db.run('DROP TABLE IF EXISTS activity_log')
  db.run('DROP TABLE IF EXISTS tasks')
  db.run('DROP TABLE IF EXISTS columns')
  initSchema(db)
  seedDefaultColumns(db)
}
