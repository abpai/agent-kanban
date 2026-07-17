import type { Sql } from 'postgres'

import { ErrorCode, KanbanError } from '../errors'
import { generateId } from '../id'
import { assembleBoardMetrics, classifyColumnRoles } from '../metrics-spec'
import type {
  ActivityEntry,
  BoardConfig,
  BoardMetrics,
  BoardView,
  Column,
  Priority,
  Task,
  TaskComment,
  TaskWithColumn,
} from '../types'
import { POSTGRES_LOCAL_CAPABILITIES } from './capabilities'
import { unsupportedOperation } from './errors'
import { LocalProviderCore, type LocalStorePort } from './local-core'
import type { CreateTaskInput, TaskListFilters, UpdateTaskInput } from './types'
import type { LocalTrackerConfig } from '../tracker-config'
import { normalizeLabels, parseStoredLabels } from '../labels'
import type { Exec } from './postgres-batch'

const DEFAULT_COLUMNS = [
  { name: 'recurring', position: 0 },
  { name: 'backlog', position: 1 },
  { name: 'in-progress', position: 2 },
  { name: 'review', position: 3 },
  { name: 'done', position: 4 },
]

interface TaskRow {
  id: string
  title: string
  description: string
  column_id: string
  column_name?: string
  position: number
  priority: Priority
  assignee: string
  project: string
  labels: string
  metadata: string
  revision: number
  created_at: string
  updated_at: string
}

interface ActivityRow {
  id: string
  task_id: string
  action: ActivityEntry['action']
  field_changed: string | null
  old_value: string | null
  new_value: string | null
  timestamp: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function defaultColumns(config: Pick<LocalTrackerConfig, 'defaultColumns'>): Array<{
  name: string
  position: number
}> {
  const names =
    config.defaultColumns && config.defaultColumns.length > 0
      ? config.defaultColumns
      : DEFAULT_COLUMNS.map((column) => column.name)
  return names.map((name, position) => ({ name, position }))
}

function assertPriority(priority: string): asserts priority is Priority {
  if (!['low', 'medium', 'high', 'urgent'].includes(priority)) {
    throw new KanbanError(ErrorCode.INVALID_PRIORITY, `Invalid priority: ${priority}`)
  }
}

function parseMetadata(metadata: string | undefined): string {
  if (metadata === undefined) return '{}'
  try {
    JSON.parse(metadata)
    return metadata
  } catch {
    throw new KanbanError(ErrorCode.INVALID_METADATA, 'Metadata must be valid JSON')
  }
}

class PostgresLocalStore implements LocalStorePort {
  readonly capabilities = POSTGRES_LOCAL_CAPABILITIES
  private readonly ready: Promise<void>

  constructor(
    private readonly sql: Sql,
    private readonly config: Pick<LocalTrackerConfig, 'defaultColumns' | 'defaultTaskColumn'> = {},
  ) {
    this.ready = this.ensureSchema().then(() => this.seedDefaultColumns())
  }

  async initialize(): Promise<void> {
    await this.ready
  }

  private async ensureSchema(): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS columns (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        position INTEGER NOT NULL,
        color TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `
    await this.sql`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        column_id TEXT NOT NULL REFERENCES columns(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL DEFAULT 0,
        priority TEXT NOT NULL DEFAULT 'medium',
        assignee TEXT NOT NULL DEFAULT '',
        project TEXT NOT NULL DEFAULT '',
        labels TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}',
        revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `
    await this.sql`
      CREATE TABLE IF NOT EXISTS activity_log (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        action TEXT NOT NULL,
        field_changed TEXT,
        old_value TEXT,
        new_value TEXT,
        timestamp TEXT NOT NULL
      )
    `
    await this.sql`
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        author TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `
    await this.sql`
      CREATE TABLE IF NOT EXISTS column_time_tracking (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        column_id TEXT NOT NULL,
        entered_at TEXT NOT NULL,
        exited_at TEXT
      )
    `
    // Run column migrations before creating indexes — pre-existing databases
    // miss columns added after the original tasks table, and CREATE TABLE IF NOT
    // EXISTS won't add them (parity with SQLite migrateSchema).
    await this.migrateTasksTable()
    await this.sql`CREATE INDEX IF NOT EXISTS idx_tasks_column_id ON tasks(column_id)`
    await this.sql`CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority)`
    await this.sql`CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee)`
    await this.sql`CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project)`
    await this.sql`CREATE INDEX IF NOT EXISTS idx_activity_task_id ON activity_log(task_id)`
    await this.sql`CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity_log(timestamp)`
    await this.sql`CREATE INDEX IF NOT EXISTS idx_comments_task_id ON comments(task_id)`
    await this
      .sql`CREATE INDEX IF NOT EXISTS idx_column_time_task_id ON column_time_tracking(task_id)`
  }

  // Backfill columns added after the original tasks table shipped. Keep this in
  // lockstep with src/db.ts:migrateSchema (project, labels, revision).
  private async migrateTasksTable(): Promise<void> {
    await this.sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project TEXT NOT NULL DEFAULT ''`
    await this.sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS labels TEXT NOT NULL DEFAULT '[]'`
    await this.sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0`
  }

  private async seedDefaultColumns(): Promise<void> {
    const [row] = await this.sql<
      { count: string | number }[]
    >`SELECT COUNT(*) AS count FROM columns`
    if (Number(row?.count ?? 0) > 0) return

    for (const column of defaultColumns(this.config)) {
      await this.sql`
        INSERT INTO columns (id, name, position, created_at, updated_at)
        VALUES (${generateId('c')}, ${column.name}, ${column.position}, ${nowIso()}, ${nowIso()})
      `
    }
  }

  private enrichTask(row: TaskRow, commentCount = 0): TaskWithColumn {
    return {
      ...row,
      providerId: row.id,
      externalRef: row.id,
      url: null,
      assignees: row.assignee ? [row.assignee] : [],
      labels: parseStoredLabels(row.labels),
      comment_count: commentCount,
      version: String(row.revision ?? 0),
      source_updated_at: null,
      column_name: row.column_name ?? '',
    }
  }

  private async commentCountsByTask(): Promise<Map<string, number>> {
    await this.ready
    const rows = await this.sql<{ task_id: string; count: string | number }[]>`
      SELECT task_id, COUNT(*) AS count
      FROM comments
      GROUP BY task_id
    `
    return new Map(rows.map((row) => [row.task_id, Number(row.count)]))
  }

  private async resolveColumn(idOrName: string): Promise<Column> {
    await this.ready
    const [byId] = await this.sql<Column[]>`SELECT * FROM columns WHERE id = ${idOrName} LIMIT 1`
    if (byId) return byId

    const [byName] = await this.sql<Column[]>`
      SELECT * FROM columns WHERE LOWER(name) = LOWER(${idOrName}) LIMIT 1
    `
    if (byName) return byName
    throw new KanbanError(ErrorCode.COLUMN_NOT_FOUND, `No column matching '${idOrName}'`)
  }

  private async resolveDefaultTaskColumn(): Promise<Column> {
    const configured = this.config.defaultTaskColumn?.trim()
    if (configured) return this.resolveColumn(configured)

    await this.ready
    const [backlog] = await this.sql<Column[]>`
      SELECT * FROM columns WHERE LOWER(name) = 'backlog' ORDER BY position LIMIT 1
    `
    if (backlog) return backlog

    const [first] = await this.sql<Column[]>`
      SELECT * FROM columns ORDER BY position, name LIMIT 1
    `
    if (first) return first
    throw new KanbanError(ErrorCode.COLUMN_NOT_FOUND, 'No columns are configured')
  }

  private async selectTask(idOrRef: string): Promise<TaskRow | null> {
    const [row] = await this.sql<TaskRow[]>`
      SELECT tasks.*, columns.name AS column_name
      FROM tasks
      JOIN columns ON columns.id = tasks.column_id
      WHERE tasks.id = ${idOrRef}
      LIMIT 1
    `
    return row ?? null
  }

  private async requireTask(idOrRef: string): Promise<TaskRow> {
    await this.ready
    const row = await this.selectTask(idOrRef)
    if (!row) throw new KanbanError(ErrorCode.TASK_NOT_FOUND, `No task with id '${idOrRef}'`)
    return row
  }

  private async insertActivity(
    taskId: string,
    action: ActivityEntry['action'],
    fieldChanged: string | null,
    oldValue: string | null,
    newValue: string | null,
    exec: Exec = this.sql,
  ): Promise<void> {
    await exec`
      INSERT INTO activity_log (id, task_id, action, field_changed, old_value, new_value, timestamp)
      VALUES (${generateId('a')}, ${taskId}, ${action}, ${fieldChanged}, ${oldValue}, ${newValue}, ${nowIso()})
    `
  }

  async getBoard(): Promise<BoardView> {
    await this.ready
    const columns = await this.listColumns()
    const counts = await this.commentCountsByTask()
    const rows = await this.sql<TaskRow[]>`
      SELECT tasks.*, columns.name AS column_name
      FROM tasks
      JOIN columns ON columns.id = tasks.column_id
      ORDER BY columns.position, tasks.position, tasks.created_at
    `
    return {
      columns: columns.map((column) => ({
        ...column,
        tasks: rows
          .filter((task) => task.column_id === column.id)
          .map((task) => this.enrichTask(task, counts.get(task.id) ?? 0)),
      })),
    }
  }

  async listColumns(): Promise<Column[]> {
    await this.ready
    return this.sql<Column[]>`SELECT * FROM columns ORDER BY position`
  }

  async listTasks(filters: TaskListFilters = {}): Promise<Task[]> {
    await this.ready

    // Push filtering, ordering, and the row cap into SQL instead of loading the
    // whole table and a full comments group-by to filter in JS. Mirrors the
    // SQLite path (db.ts:listTasks) so both backends share filter/sort semantics.
    const conditions = []
    if (filters.column) {
      const column = await this.resolveColumn(filters.column)
      conditions.push(this.sql`tasks.column_id = ${column.id}`)
    }
    if (filters.priority) conditions.push(this.sql`tasks.priority = ${filters.priority}`)
    if (filters.assignee) conditions.push(this.sql`tasks.assignee = ${filters.assignee}`)
    if (filters.project) conditions.push(this.sql`tasks.project = ${filters.project}`)
    const where = conditions.length
      ? conditions.reduce((acc, cond) => this.sql`${acc} AND ${cond}`)
      : this.sql`TRUE`

    // Whitelisted ORDER BY fragments; the sort key never reaches SQL as data.
    const orderByMap: Record<string, ReturnType<typeof this.sql>> = {
      priority: this
        .sql`CASE tasks.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END`,
      created: this.sql`tasks.created_at`,
      updated: this.sql`tasks.updated_at`,
      position: this.sql`tasks.position`,
      title: this.sql`tasks.title`,
    }
    const orderBy = orderByMap[filters.sort ?? 'position'] ?? orderByMap['position']!
    const limit = filters.limit ? this.sql`LIMIT ${filters.limit}` : this.sql``

    const rows = await this.sql<Array<TaskRow & { comment_count: string | number }>>`
      SELECT tasks.*, columns.name AS column_name,
        (SELECT COUNT(*) FROM comments WHERE comments.task_id = tasks.id) AS comment_count
      FROM tasks
      JOIN columns ON columns.id = tasks.column_id
      WHERE ${where}
      ORDER BY ${orderBy}
      ${limit}
    `
    return rows.map((row) => this.enrichTask(row, Number(row.comment_count ?? 0)))
  }

  async getTask(idOrRef: string): Promise<Task> {
    const row = await this.requireTask(idOrRef)
    const counts = await this.commentCountsByTask()
    return this.enrichTask(row, counts.get(row.id) ?? 0)
  }

  async getTaskVersion(idOrRef: string): Promise<string> {
    const row = await this.requireTask(idOrRef)
    return String(row.revision ?? 0)
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    await this.ready
    const priority = input.priority ?? 'medium'
    assertPriority(priority)
    const metadata = parseMetadata(input.metadata)
    const labels = normalizeLabels(input.labels)
    const column = input.column
      ? await this.resolveColumn(input.column)
      : await this.resolveDefaultTaskColumn()
    const id = generateId('t')
    const timestamp = nowIso()
    await this.sql.begin(async (tx) => {
      const [positionRow] = await tx<{ next: string | number }[]>`
        SELECT COALESCE(MAX(position), -1) + 1 AS next FROM tasks WHERE column_id = ${column.id}
      `
      await tx`
        INSERT INTO tasks (
          id, title, description, column_id, position, priority, assignee, project, labels, metadata,
          revision, created_at, updated_at
        )
        VALUES (
          ${id}, ${input.title}, ${input.description ?? ''}, ${column.id}, ${Number(positionRow?.next ?? 0)},
          ${priority}, ${input.assignee ?? ''}, ${input.project ?? ''}, ${JSON.stringify(labels)}, ${metadata},
          0, ${timestamp}, ${timestamp}
        )
      `
      await this.insertActivity(id, 'created', null, null, input.title, tx)
      await this.enterColumn(id, column.id, tx)
    })
    return this.getTask(id)
  }

  async updateTask(
    idOrRef: string,
    input: Omit<UpdateTaskInput, 'expectedVersion'>,
  ): Promise<Task> {
    await this.ready
    const current = await this.requireTask(idOrRef)

    if (input.priority !== undefined) assertPriority(input.priority)
    const metadata = input.metadata === undefined ? undefined : parseMetadata(input.metadata)
    const nextLabels = input.labels !== undefined ? normalizeLabels(input.labels) : undefined
    const next = {
      title: input.title ?? current.title,
      description: input.description ?? current.description,
      priority: input.priority ?? current.priority,
      assignee: input.assignee ?? current.assignee,
      project: input.project ?? current.project,
      labels: nextLabels ?? current.labels,
      metadata: metadata ?? current.metadata,
    }
    await this.sql.begin(async (tx) => {
      await tx`
        UPDATE tasks
        SET title = ${next.title},
            description = ${next.description},
            priority = ${next.priority},
            assignee = ${next.assignee},
            project = ${next.project},
            labels = ${JSON.stringify(next.labels)},
            metadata = ${next.metadata},
            revision = revision + 1,
            updated_at = ${nowIso()}
        WHERE id = ${current.id}
      `
      if (input.title !== undefined && input.title !== current.title) {
        await this.insertActivity(current.id, 'updated', 'title', current.title, input.title, tx)
      }
      if (input.assignee !== undefined && input.assignee !== current.assignee) {
        await this.insertActivity(
          current.id,
          'assigned',
          'assignee',
          current.assignee,
          input.assignee,
          tx,
        )
      }
      if (input.priority !== undefined && input.priority !== current.priority) {
        await this.insertActivity(
          current.id,
          'prioritized',
          'priority',
          current.priority,
          input.priority,
          tx,
        )
      }
      if (input.project !== undefined && input.project !== current.project) {
        await this.insertActivity(
          current.id,
          'updated',
          'project',
          current.project || null,
          input.project,
          tx,
        )
      }
      if (input.description !== undefined && input.description !== current.description) {
        await this.insertActivity(
          current.id,
          'updated',
          'description',
          current.description,
          input.description,
          tx,
        )
      }
      if (
        nextLabels !== undefined &&
        JSON.stringify(nextLabels) !== JSON.stringify(current.labels)
      ) {
        await this.insertActivity(
          current.id,
          'updated',
          'labels',
          JSON.stringify(current.labels),
          JSON.stringify(nextLabels),
          tx,
        )
      }
      if (metadata !== undefined && metadata !== current.metadata) {
        await this.insertActivity(current.id, 'updated', 'metadata', current.metadata, metadata, tx)
      }
    })
    return this.getTask(current.id)
  }

  async moveTask(idOrRef: string, columnName: string): Promise<Task> {
    await this.ready
    const current = await this.requireTask(idOrRef)
    const column = await this.resolveColumn(columnName)
    const oldColumnId = current.column_id

    // No-op move to the same column: skip the write so we don't fragment
    // column-time tracking (spurious exit/enter) or re-append the task.
    if (column.id === oldColumnId) return this.getTask(current.id)

    await this.sql.begin(async (tx) => {
      const [posRow] = await tx<{ next: string | number }[]>`
        SELECT COALESCE(MAX(position), -1) + 1 AS next FROM tasks WHERE column_id = ${column.id}
      `
      await tx`
        UPDATE tasks
        SET column_id = ${column.id},
            position = ${Number(posRow?.next ?? 0)},
            revision = revision + 1,
            updated_at = ${nowIso()}
        WHERE id = ${current.id}
      `
      await this.renumberColumn(oldColumnId, tx)
      await this.exitColumn(current.id, oldColumnId, tx)
      await this.enterColumn(current.id, column.id, tx)
      await this.insertActivity(
        current.id,
        'moved',
        'column',
        current.column_name ?? oldColumnId,
        column.name,
        tx,
      )
    })
    return this.getTask(current.id)
  }

  async deleteTask(idOrRef: string): Promise<Task> {
    await this.ready
    const task = await this.getTask(idOrRef)
    await this.sql.begin(async (tx) => {
      await this.exitColumn(task.id, task.column_id, tx)
      await this.insertActivity(task.id, 'deleted', null, task.title, null, tx)
      await tx`DELETE FROM tasks WHERE id = ${task.id}`
      await this.renumberColumn(task.column_id, tx)
    })
    return task
  }

  async listComments(idOrRef: string): Promise<TaskComment[]> {
    const task = await this.requireTask(idOrRef)
    return this.sql<TaskComment[]>`
      SELECT * FROM comments WHERE task_id = ${task.id} ORDER BY created_at
    `
  }

  async getComment(idOrRef: string, commentId: string): Promise<TaskComment> {
    const task = await this.requireTask(idOrRef)
    const [comment] = await this.sql<TaskComment[]>`
      SELECT * FROM comments WHERE task_id = ${task.id} AND id = ${commentId} LIMIT 1
    `
    if (!comment) {
      throw new KanbanError(
        ErrorCode.COMMENT_NOT_FOUND,
        `No comment '${commentId}' on task '${idOrRef}'`,
      )
    }
    return comment
  }

  async comment(idOrRef: string, body: string): Promise<TaskComment> {
    const task = await this.requireTask(idOrRef)
    const id = generateId('cm')
    const timestamp = nowIso()
    // Comment writes are part of task history (parity with SQLite addComment):
    // insert and activity in one transaction so they commit or roll back together.
    const comment = await this.sql.begin(async (tx) => {
      const [row] = await tx<TaskComment[]>`
        INSERT INTO comments (id, task_id, body, author, created_at, updated_at)
        VALUES (${id}, ${task.id}, ${body}, ${null}, ${timestamp}, ${timestamp})
        RETURNING *
      `
      await this.insertActivity(task.id, 'updated', 'comment', null, body, tx)
      return row
    })
    return comment!
  }

  async updateComment(idOrRef: string, commentId: string, body: string): Promise<TaskComment> {
    const existing = await this.getComment(idOrRef, commentId)
    const timestamp = nowIso()
    const comment = await this.sql.begin(async (tx) => {
      const [row] = await tx<TaskComment[]>`
        UPDATE comments
        SET body = ${body}, updated_at = ${timestamp}
        WHERE id = ${existing.id}
        RETURNING *
      `
      await this.insertActivity(existing.task_id, 'updated', 'comment', existing.body, body, tx)
      return row
    })
    return comment!
  }

  async getActivity(limit = 100, taskId?: string): Promise<ActivityEntry[]> {
    await this.ready
    if (taskId) {
      return this.sql<ActivityRow[]>`
        SELECT * FROM activity_log
        WHERE task_id = ${taskId}
        ORDER BY timestamp DESC
        LIMIT ${limit}
      `
    }
    return this.sql<ActivityRow[]>`
      SELECT * FROM activity_log
      ORDER BY timestamp DESC
      LIMIT ${limit}
    `
  }

  async getMetrics(): Promise<BoardMetrics> {
    await this.ready
    const [total] = await this.sql<
      { count: string | number }[]
    >`SELECT COUNT(*) AS count FROM tasks`

    // Gather raw aggregates with Postgres SQL; metrics-spec owns the derived
    // fields (role classification, completion math, priority ordering) so both
    // backends stay identical without manual lockstep.
    const columnRows = await this.sql<
      { id: string; name: string; position: number; count: string | number }[]
    >`
      SELECT columns.id AS id, columns.name AS name, columns.position AS position,
        COUNT(tasks.id) AS count
      FROM columns
      LEFT JOIN tasks ON tasks.column_id = columns.id
      GROUP BY columns.id, columns.name, columns.position
      ORDER BY columns.position
    `
    const columnCounts = columnRows.map((row) => ({
      id: row.id,
      name: row.name,
      position: Number(row.position),
      count: Number(row.count),
    }))
    // Done ids are needed up front to scope the average-completion query.
    const { doneColumnIds } = classifyColumnRoles(columnCounts)

    const priorityCounts = (
      await this.sql<{ priority: string; count: string | number }[]>`
        SELECT priority, COUNT(*) AS count FROM tasks GROUP BY priority
      `
    ).map((row) => ({ priority: row.priority, count: Number(row.count) }))

    // Average completion time = first tracked entry (creation) -> first time the
    // task entered Done. Using the Done *entry* (not exit) counts tasks resting
    // in Done; MIN() handles tasks that re-enter Done. Cast to timestamptz so the
    // ISO-UTC strings compare correctly regardless of the server timezone.
    const [avgResult] =
      doneColumnIds.length > 0
        ? await this.sql<{ avg_hours: string | number | null }[]>`
      SELECT AVG(
        EXTRACT(EPOCH FROM (done_enter.entered_at - first_enter.entered_at)) / 3600
      ) AS avg_hours
      FROM (
        SELECT ct.task_id, MIN(ct.entered_at::timestamptz) AS entered_at
        FROM column_time_tracking ct
        WHERE ct.column_id IN ${this.sql(doneColumnIds)}
        GROUP BY ct.task_id
      ) done_enter
      JOIN (
        SELECT task_id, MIN(entered_at::timestamptz) AS entered_at
        FROM column_time_tracking GROUP BY task_id
      ) first_enter ON first_enter.task_id = done_enter.task_id
    `
        : [{ avg_hours: null }]
    const [weekCount] = await this.sql<{ count: string | number }[]>`
      SELECT COUNT(*) AS count FROM tasks
      WHERE created_at::timestamptz >= NOW() - INTERVAL '7 days'
    `

    return assembleBoardMetrics({
      columnCounts,
      priorityCounts,
      totalTasks: Number(total?.count ?? 0),
      tasksCreatedThisWeek: Number(weekCount?.count ?? 0),
      avgCompletionHours: avgResult?.avg_hours != null ? Number(avgResult.avg_hours) : null,
      recentActivity: await this.getActivity(20),
      assignees: await this.discoveredAssignees(),
      projects: await this.discoveredProjects(),
    })
  }

  private async discoveredAssignees(): Promise<string[]> {
    const rows = await this.sql<{ assignee: string }[]>`
      SELECT DISTINCT assignee FROM tasks WHERE assignee != '' ORDER BY assignee
    `
    return rows.map((row) => row.assignee)
  }

  private async discoveredProjects(): Promise<string[]> {
    const rows = await this.sql<{ project: string }[]>`
      SELECT DISTINCT project FROM tasks WHERE project != '' ORDER BY project
    `
    return rows.map((row) => row.project)
  }

  private async enterColumn(
    taskId: string,
    columnId: string,
    exec: Exec = this.sql,
  ): Promise<void> {
    const id = generateId('ct')
    await exec`
      INSERT INTO column_time_tracking (id, task_id, column_id, entered_at)
      VALUES (${id}, ${taskId}, ${columnId}, ${nowIso()})
    `
  }

  private async exitColumn(taskId: string, columnId: string, exec: Exec = this.sql): Promise<void> {
    await exec`
      UPDATE column_time_tracking
      SET exited_at = ${nowIso()}
      WHERE task_id = ${taskId} AND column_id = ${columnId} AND exited_at IS NULL
    `
  }

  // Compact positions to a contiguous 0..n-1 sequence in a single statement.
  private async renumberColumn(columnId: string, exec: Exec = this.sql): Promise<void> {
    await exec`
      UPDATE tasks t
      SET position = s.rn
      FROM (
        SELECT id, ROW_NUMBER() OVER (ORDER BY position, created_at, id) - 1 AS rn
        FROM tasks WHERE column_id = ${columnId}
      ) s
      WHERE t.id = s.id AND t.position <> s.rn
    `
  }

  async getConfig(): Promise<BoardConfig> {
    await this.ready
    return {
      members: [],
      projects: await this.discoveredProjects(),
      provider: 'local',
      discoveredAssignees: await this.discoveredAssignees(),
      discoveredProjects: await this.discoveredProjects(),
    }
  }

  async patchConfig(_input: Partial<BoardConfig>): Promise<BoardConfig> {
    // No persistent config repository exists for Postgres-local (getConfig is
    // reconstructed from task data). Rather than silently merge-and-return
    // without persisting, advertise the capability honestly (configEdit:false)
    // and fail loudly so the HTTP API and CLI agree.
    unsupportedOperation('Editing board config is not supported with KANBAN_STORAGE=postgres')
  }
}

export class PostgresLocalProvider extends LocalProviderCore {
  constructor(
    sql: Sql,
    config: Pick<LocalTrackerConfig, 'defaultColumns' | 'defaultTaskColumn'> = {},
  ) {
    super(new PostgresLocalStore(sql, config))
  }
}
