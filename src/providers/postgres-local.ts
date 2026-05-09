import type { Sql } from 'postgres'

import { ErrorCode, KanbanError } from '../errors'
import { generateId } from '../id'
import type {
  ActivityEntry,
  BoardBootstrap,
  BoardConfig,
  BoardMetrics,
  BoardView,
  Column,
  Priority,
  Task,
  TaskComment,
  TaskWithColumn,
} from '../types'
import { LOCAL_CAPABILITIES } from './capabilities'
import type {
  CreateTaskInput,
  KanbanProvider,
  ProviderContext,
  ProviderSyncStatus,
  TaskListFilters,
  UpdateTaskInput,
} from './types'

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

function defaultColumns(): Array<{ name: string; position: number }> {
  const raw = process.env['KANBAN_DEFAULT_COLUMNS']?.trim()
  const names = raw
    ? raw
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
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

export class PostgresLocalProvider implements KanbanProvider {
  readonly type = 'local' as const
  private readonly ready: Promise<void>

  constructor(private readonly sql: Sql) {
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

  private async seedDefaultColumns(): Promise<void> {
    const [row] = await this.sql<
      { count: string | number }[]
    >`SELECT COUNT(*) AS count FROM columns`
    if (Number(row?.count ?? 0) > 0) return

    for (const column of defaultColumns()) {
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
      labels: [],
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
    const configured = process.env['KANBAN_DEFAULT_TASK_COLUMN']?.trim()
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
  ): Promise<void> {
    await this.sql`
      INSERT INTO activity_log (id, task_id, action, field_changed, old_value, new_value, timestamp)
      VALUES (${generateId('a')}, ${taskId}, ${action}, ${fieldChanged}, ${oldValue}, ${newValue}, ${nowIso()})
    `
  }

  async getContext(): Promise<ProviderContext> {
    await this.ready
    return { provider: this.type, capabilities: LOCAL_CAPABILITIES, team: null }
  }

  async getBootstrap(): Promise<BoardBootstrap> {
    await this.ready
    const metrics = await this.getMetrics()
    return {
      provider: this.type,
      capabilities: LOCAL_CAPABILITIES,
      board: await this.getBoard(),
      config: await this.getConfig(),
      metrics,
      activity: await this.getActivity(50),
      team: null,
    }
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
    const rows = await this.sql<TaskRow[]>`
      SELECT tasks.*, columns.name AS column_name
      FROM tasks
      JOIN columns ON columns.id = tasks.column_id
      ORDER BY tasks.created_at
    `
    const counts = await this.commentCountsByTask()
    let tasks = rows.map((task) => this.enrichTask(task, counts.get(task.id) ?? 0))

    if (filters.column) {
      const column = await this.resolveColumn(filters.column)
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
    const row = await this.requireTask(idOrRef)
    const counts = await this.commentCountsByTask()
    return this.enrichTask(row, counts.get(row.id) ?? 0)
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    await this.ready
    const priority = input.priority ?? 'medium'
    assertPriority(priority)
    const metadata = parseMetadata(input.metadata)
    const column = input.column
      ? await this.resolveColumn(input.column)
      : await this.resolveDefaultTaskColumn()
    const [positionRow] = await this.sql<{ next: string | number }[]>`
      SELECT COALESCE(MAX(position), -1) + 1 AS next FROM tasks WHERE column_id = ${column.id}
    `
    const id = generateId('t')
    const timestamp = nowIso()
    await this.sql`
      INSERT INTO tasks (
        id, title, description, column_id, position, priority, assignee, project, metadata,
        revision, created_at, updated_at
      )
      VALUES (
        ${id}, ${input.title}, ${input.description ?? ''}, ${column.id}, ${Number(positionRow?.next ?? 0)},
        ${priority}, ${input.assignee ?? ''}, ${input.project ?? ''}, ${metadata},
        0, ${timestamp}, ${timestamp}
      )
    `
    await this.insertActivity(id, 'created', null, null, input.title)
    return this.getTask(id)
  }

  async updateTask(idOrRef: string, input: UpdateTaskInput): Promise<Task> {
    await this.ready
    const current = await this.requireTask(idOrRef)
    if (
      input.expectedVersion !== undefined &&
      String(current.revision ?? 0) !== input.expectedVersion
    ) {
      throw new KanbanError(
        ErrorCode.CONFLICT,
        `Task ${idOrRef} was modified since you loaded it (expected version ${input.expectedVersion}, current ${current.revision ?? 0})`,
      )
    }

    if (input.priority !== undefined) assertPriority(input.priority)
    const metadata = input.metadata === undefined ? undefined : parseMetadata(input.metadata)
    const next = {
      title: input.title ?? current.title,
      description: input.description ?? current.description,
      priority: input.priority ?? current.priority,
      assignee: input.assignee ?? current.assignee,
      project: input.project ?? current.project,
      metadata: metadata ?? current.metadata,
    }
    await this.sql`
      UPDATE tasks
      SET title = ${next.title},
          description = ${next.description},
          priority = ${next.priority},
          assignee = ${next.assignee},
          project = ${next.project},
          metadata = ${next.metadata},
          revision = revision + 1,
          updated_at = ${nowIso()}
      WHERE id = ${current.id}
    `
    if (input.title !== undefined && input.title !== current.title) {
      await this.insertActivity(current.id, 'updated', 'title', current.title, input.title)
    }
    if (input.assignee !== undefined && input.assignee !== current.assignee) {
      await this.insertActivity(
        current.id,
        'assigned',
        'assignee',
        current.assignee,
        input.assignee,
      )
    }
    if (input.priority !== undefined && input.priority !== current.priority) {
      await this.insertActivity(
        current.id,
        'prioritized',
        'priority',
        current.priority,
        input.priority,
      )
    }
    return this.getTask(current.id)
  }

  async moveTask(idOrRef: string, columnName: string): Promise<Task> {
    await this.ready
    const current = await this.requireTask(idOrRef)
    const column = await this.resolveColumn(columnName)
    const oldColumn = current.column_name ?? current.column_id
    await this.sql`
      UPDATE tasks
      SET column_id = ${column.id},
          revision = revision + 1,
          updated_at = ${nowIso()}
      WHERE id = ${current.id}
    `
    await this.insertActivity(current.id, 'moved', 'column', oldColumn, column.name)
    return this.getTask(current.id)
  }

  async deleteTask(idOrRef: string): Promise<Task> {
    await this.ready
    const task = await this.getTask(idOrRef)
    await this.sql`DELETE FROM tasks WHERE id = ${task.id}`
    await this.insertActivity(task.id, 'deleted', null, task.title, null)
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
    const [comment] = await this.sql<TaskComment[]>`
      INSERT INTO comments (id, task_id, body, author, created_at, updated_at)
      VALUES (${id}, ${task.id}, ${body}, ${null}, ${timestamp}, ${timestamp})
      RETURNING *
    `
    return comment!
  }

  async updateComment(idOrRef: string, commentId: string, body: string): Promise<TaskComment> {
    const existing = await this.getComment(idOrRef, commentId)
    const [comment] = await this.sql<TaskComment[]>`
      UPDATE comments
      SET body = ${body}, updated_at = ${nowIso()}
      WHERE id = ${existing.id}
      RETURNING *
    `
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
    const [doneColumn] = await this.sql<{ id: string }[]>`
      SELECT id FROM columns WHERE LOWER(name) = 'done' LIMIT 1
    `
    const [completed] = doneColumn
      ? await this.sql<{ count: string | number }[]>`
          SELECT COUNT(*) AS count FROM tasks WHERE column_id = ${doneColumn.id}
        `
      : [{ count: 0 }]
    const tasksByColumn = await this.sql<{ column_name: string; count: string | number }[]>`
      SELECT columns.name AS column_name, COUNT(tasks.id) AS count
      FROM columns
      LEFT JOIN tasks ON tasks.column_id = columns.id
      GROUP BY columns.id, columns.name, columns.position
      ORDER BY columns.position
    `
    const tasksByPriority = await this.sql<{ priority: string; count: string | number }[]>`
      SELECT priority, COUNT(*) AS count FROM tasks GROUP BY priority ORDER BY priority
    `
    const assignees = await this.discoveredAssignees()
    const projects = await this.discoveredProjects()
    const totalTasks = Number(total?.count ?? 0)
    const completedTasks = Number(completed?.count ?? 0)
    return {
      tasksByColumn: tasksByColumn.map((row) => ({
        column_name: row.column_name,
        count: Number(row.count),
      })),
      tasksByPriority: tasksByPriority.map((row) => ({
        priority: row.priority,
        count: Number(row.count),
      })),
      totalTasks,
      completedTasks,
      avgCompletionHours: null,
      recentActivity: await this.getActivity(10),
      tasksCreatedThisWeek: 0,
      inProgressCount:
        tasksByColumn.find((row) => row.column_name === 'in-progress')?.count === undefined
          ? 0
          : Number(tasksByColumn.find((row) => row.column_name === 'in-progress')!.count),
      completionPercent: totalTasks === 0 ? 0 : Math.round((completedTasks / totalTasks) * 100),
      assignees,
      projects,
    }
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

  async patchConfig(input: Partial<BoardConfig>): Promise<BoardConfig> {
    await this.ready
    const config = await this.getConfig()
    return {
      ...config,
      members: input.members ?? config.members,
      projects: input.projects ?? config.projects,
    }
  }

  async getSyncStatus(): Promise<ProviderSyncStatus | null> {
    return null
  }
}
