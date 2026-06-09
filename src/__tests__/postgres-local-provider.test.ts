import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import postgres from 'postgres'

import { run } from '../index'
import { openKanbanRuntime } from '../provider-runtime'
import type { BoardMetrics, Task, TaskComment, TaskWithColumn } from '../types'

const databaseUrl = process.env['KANBAN_PG_TEST_URL'] ?? process.env['DATABASE_URL']
const pgTest = databaseUrl ? test : test.skip

function expectOk<T>(result: Awaited<ReturnType<typeof run>>): T {
  expect(result.exitCode).toBe(0)
  expect(result.output.ok).toBe(true)
  if (!result.output.ok) throw new Error('expected successful CLI output')
  return result.output.data as T
}

describe('postgres local provider', () => {
  let previousStorage: string | undefined
  let previousDatabaseUrl: string | undefined
  let previousProvider: string | undefined
  let previousDbPath: string | undefined
  let previousDefaultColumns: string | undefined
  let sql: postgres.Sql | null = null

  beforeEach(async () => {
    previousStorage = process.env['KANBAN_STORAGE']
    previousDatabaseUrl = process.env['KANBAN_DATABASE_URL']
    previousProvider = process.env['KANBAN_PROVIDER']
    previousDbPath = process.env['KANBAN_DB_PATH']
    previousDefaultColumns = process.env['KANBAN_DEFAULT_COLUMNS']

    process.env['KANBAN_STORAGE'] = 'postgres'
    process.env['KANBAN_DATABASE_URL'] = databaseUrl
    process.env['KANBAN_PROVIDER'] = 'local'
    delete process.env['KANBAN_DB_PATH']

    if (databaseUrl) {
      sql = postgres(databaseUrl, { max: 1, onnotice: () => {} })
      await sql`DROP TABLE IF EXISTS comments`
      await sql`DROP TABLE IF EXISTS column_time_tracking`
      await sql`DROP TABLE IF EXISTS activity_log`
      await sql`DROP TABLE IF EXISTS tasks`
      await sql`DROP TABLE IF EXISTS columns`
    }
  })

  afterEach(async () => {
    if (sql) {
      await sql.end({ timeout: 1 })
      sql = null
    }

    if (previousStorage === undefined) delete process.env['KANBAN_STORAGE']
    else process.env['KANBAN_STORAGE'] = previousStorage
    if (previousDatabaseUrl === undefined) delete process.env['KANBAN_DATABASE_URL']
    else process.env['KANBAN_DATABASE_URL'] = previousDatabaseUrl
    if (previousProvider === undefined) delete process.env['KANBAN_PROVIDER']
    else process.env['KANBAN_PROVIDER'] = previousProvider
    if (previousDbPath === undefined) delete process.env['KANBAN_DB_PATH']
    else process.env['KANBAN_DB_PATH'] = previousDbPath
    if (previousDefaultColumns === undefined) delete process.env['KANBAN_DEFAULT_COLUMNS']
    else process.env['KANBAN_DEFAULT_COLUMNS'] = previousDefaultColumns
  })

  pgTest('runs task and comment commands through Postgres storage', async () => {
    const created = expectOk<TaskWithColumn>(
      await run([
        'task',
        'add',
        'Postgres-backed task',
        '-d',
        'Stored in Postgres',
        '-c',
        'recurring',
        '-p',
        'high',
        '-a',
        'garage',
        '--project',
        'Dispatch',
        '--label',
        'garage-smoke',
        '--label',
        'postgres-local',
        '-m',
        '{"storage":"postgres"}',
      ]),
    )

    expect(created.title).toBe('Postgres-backed task')
    expect(created.column_name).toBe('recurring')
    expect(created.labels).toEqual(['garage-smoke', 'postgres-local'])
    expect(created.version).toBe('0')

    const listed = expectOk<Task[]>(await run(['task', 'list', '-c', 'recurring']))
    expect(listed.map((task) => task.id)).toContain(created.id)

    const updated = expectOk<Task>(
      await run(['task', 'update', created.id, '--title', 'Updated from Postgres', '-p', 'urgent']),
    )
    expect(updated.title).toBe('Updated from Postgres')
    expect(updated.priority).toBe('urgent')
    expect(updated.version).toBe('1')

    const comment = expectOk<TaskComment>(
      await run(['comment', 'add', created.id, 'Projection comment stored in Postgres']),
    )
    expect(comment.task_id).toBe(created.id)

    const comments = expectOk<TaskComment[]>(await run(['comment', 'list', created.id]))
    expect(comments).toHaveLength(1)
    expect(comments[0]!.body).toBe('Projection comment stored in Postgres')
  })

  pgTest('reports configEdit:false and refuses config edits', async () => {
    const runtime = await openKanbanRuntime()
    try {
      const context = await runtime.provider.getContext()
      expect(context.capabilities.configEdit).toBe(false)

      await expect(runtime.provider.patchConfig({ projects: ['Anything'] })).rejects.toMatchObject({
        code: 'UNSUPPORTED_OPERATION',
      })
    } finally {
      await runtime.close()
    }
  })

  pgTest('migrates a pre-existing tasks table missing project/labels/revision', async () => {
    // Simulate an older Postgres-local database created before project, labels,
    // and revision columns existed. CREATE TABLE IF NOT EXISTS would not add
    // them, so the provider's migration must backfill before any insert.
    await sql!`
      CREATE TABLE columns (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        position INTEGER NOT NULL,
        color TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `
    await sql!`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        column_id TEXT NOT NULL REFERENCES columns(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL DEFAULT 0,
        priority TEXT NOT NULL DEFAULT 'medium',
        assignee TEXT NOT NULL DEFAULT '',
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `

    // First provider use runs ensureSchema/migrateTasksTable and must succeed.
    const created = expectOk<TaskWithColumn>(
      await run(['task', 'add', 'After migration', '--project', 'Dispatch', '--label', 'smoke']),
    )
    expect(created.title).toBe('After migration')
    expect(created.project).toBe('Dispatch')
    expect(created.labels).toEqual(['smoke'])
    expect(created.version).toBe('0')

    const columnRows = await sql!<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'tasks'
    `
    const columnNames = columnRows.map((row) => row.column_name)
    expect(columnNames).toContain('project')
    expect(columnNames).toContain('labels')
    expect(columnNames).toContain('revision')
  })

  pgTest('seeds custom default columns for Garage local compose', async () => {
    process.env['KANBAN_DEFAULT_COLUMNS'] = 'Todo,In Progress,Human Review,Merging,Done'

    const created = expectOk<TaskWithColumn>(
      await run(['task', 'add', 'Garage column task', '-c', 'Todo']),
    )

    expect(created.column_name).toBe('Todo')
  })

  pgTest('defaults new tasks to the first configured column when backlog is absent', async () => {
    process.env['KANBAN_DEFAULT_COLUMNS'] = 'Todo,In Progress,Human Review,Merging,Done'

    const created = expectOk<TaskWithColumn>(
      await run(['task', 'add', 'Garage default column task']),
    )

    expect(created.column_name).toBe('Todo')
  })

  async function positionsInColumn(
    columnName: string,
  ): Promise<Array<{ id: string; position: number }>> {
    if (!sql) throw new Error('sql not initialized')
    return sql<Array<{ id: string; position: number }>>`
      SELECT t.id, t.position FROM tasks t
      JOIN columns c ON t.column_id = c.id
      WHERE c.name = ${columnName}
      ORDER BY t.position
    `
  }

  pgTest('move renumbers the source column and records column-time tracking', async () => {
    const a = expectOk<TaskWithColumn>(await run(['task', 'add', 'A', '-c', 'backlog']))
    const b = expectOk<TaskWithColumn>(await run(['task', 'add', 'B', '-c', 'backlog']))
    const c = expectOk<TaskWithColumn>(await run(['task', 'add', 'C', '-c', 'backlog']))
    expect((await positionsInColumn('backlog')).map((r) => r.id)).toEqual([a.id, b.id, c.id])

    expectOk<Task>(await run(['task', 'move', b.id, 'in-progress']))

    // Source column compacted to 0..n-1 with no gap left by B.
    expect(await positionsInColumn('backlog')).toEqual([
      { id: a.id, position: 0 },
      { id: c.id, position: 1 },
    ])

    // B has a closed backlog interval and an open in-progress interval.
    const tracking = await sql!<Array<{ column_name: string; exited_at: string | null }>>`
      SELECT c.name AS column_name, ct.exited_at
      FROM column_time_tracking ct JOIN columns c ON ct.column_id = c.id
      WHERE ct.task_id = ${b.id}
      ORDER BY ct.entered_at
    `
    expect(tracking.map((r) => r.column_name)).toEqual(['backlog', 'in-progress'])
    expect(tracking[0]!.exited_at).not.toBeNull()
    expect(tracking[1]!.exited_at).toBeNull()
  })

  pgTest('move to the same column is a no-op (no extra tracking, no reorder)', async () => {
    const a = expectOk<TaskWithColumn>(await run(['task', 'add', 'A', '-c', 'backlog']))
    const b = expectOk<TaskWithColumn>(await run(['task', 'add', 'B', '-c', 'backlog']))

    expectOk<Task>(await run(['task', 'move', a.id, 'backlog']))

    // Order preserved (no re-append of A to the end).
    expect((await positionsInColumn('backlog')).map((r) => r.id)).toEqual([a.id, b.id])
    // Only the single creation interval exists for A.
    const trackingRows = await sql!<Array<{ count: string | number }>>`
      SELECT COUNT(*) AS count FROM column_time_tracking WHERE task_id = ${a.id}
    `
    expect(Number(trackingRows[0]?.count ?? 0)).toBe(1)
  })

  pgTest('delete renumbers the remaining tasks in the column', async () => {
    const a = expectOk<TaskWithColumn>(await run(['task', 'add', 'A', '-c', 'backlog']))
    const b = expectOk<TaskWithColumn>(await run(['task', 'add', 'B', '-c', 'backlog']))
    const c = expectOk<TaskWithColumn>(await run(['task', 'add', 'C', '-c', 'backlog']))

    expectOk<Task>(await run(['task', 'delete', b.id]))

    expect(await positionsInColumn('backlog')).toEqual([
      { id: a.id, position: 0 },
      { id: c.id, position: 1 },
    ])
  })

  pgTest('getMetrics reports completion time for tasks that reached Done', async () => {
    const a = expectOk<TaskWithColumn>(await run(['task', 'add', 'A', '-c', 'backlog']))
    expectOk<TaskWithColumn>(await run(['task', 'add', 'B', '-c', 'backlog']))
    expectOk<Task>(await run(['task', 'move', a.id, 'done']))

    const runtime = await openKanbanRuntime()
    let metrics: BoardMetrics
    try {
      metrics = await runtime.provider.getMetrics()
    } finally {
      await runtime.close()
    }

    expect(metrics.completedTasks).toBe(1)
    // Bug fix: a task resting in Done now contributes to the average (no longer
    // requires exited_at), and the value is a real number, not a string.
    expect(typeof metrics.avgCompletionHours).toBe('number')
    expect(metrics.avgCompletionHours!).toBeGreaterThanOrEqual(0)
    expect(metrics.tasksCreatedThisWeek).toBe(2)
    expect(metrics.inProgressCount).toBe(0)
  })
})
