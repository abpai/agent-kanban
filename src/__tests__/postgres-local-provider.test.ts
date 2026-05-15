import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import postgres from 'postgres'

import { run } from '../index'
import type { Task, TaskComment, TaskWithColumn } from '../types'

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
})
