import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ErrorCode, KanbanError, type ErrorCodeValue } from '../errors'
import type { Task } from '../types'
import { parseServeArgs, run } from '../index'

async function withTempDb(runTest: (dbPath: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'kanban-run-'))
  const dbPath = join(dir, 'board.db')
  const prevProvider = process.env['KANBAN_PROVIDER']
  process.env['KANBAN_PROVIDER'] = 'local'

  try {
    await runTest(dbPath)
  } finally {
    if (prevProvider === undefined) delete process.env['KANBAN_PROVIDER']
    else process.env['KANBAN_PROVIDER'] = prevProvider
    rmSync(dir, { recursive: true, force: true })
  }
}

function expectOk<T>(result: Awaited<ReturnType<typeof run>>): T {
  expect(result.exitCode).toBe(0)
  expect(result.output.ok).toBe(true)
  if (!result.output.ok) {
    throw new Error('expected successful CLI output')
  }
  return result.output.data as T
}

async function expectKanbanError(
  runPromise: Promise<Awaited<ReturnType<typeof run>>>,
  code: ErrorCodeValue,
): Promise<KanbanError> {
  const err = await runPromise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(KanbanError)
  expect((err as KanbanError).code).toBe(code)
  return err as KanbanError
}

describe('parseServeArgs', () => {
  test('defaults: no tunnel, port from PORT env or 3000', () => {
    const prev = process.env['PORT']
    delete process.env['PORT']
    try {
      expect(parseServeArgs(['serve'])).toEqual({ db: undefined, port: 3000, tunnel: false })
      process.env['PORT'] = '4001'
      expect(parseServeArgs(['serve'])).toEqual({ db: undefined, port: 4001, tunnel: false })
    } finally {
      if (prev === undefined) delete process.env['PORT']
      else process.env['PORT'] = prev
    }
  })

  test('--tunnel opts in; --port and --db override', () => {
    const opts = parseServeArgs(['serve', '--tunnel', '--port', '5050', '--db', '/tmp/b.db'])
    expect(opts).toEqual({ db: '/tmp/b.db', port: 5050, tunnel: true })
  })
})

describe('run', () => {
  test('applies schema migration before task commands', async () => {
    await withTempDb(async (dbPath) => {
      const legacy = new Database(dbPath)
      legacy.run(
        `CREATE TABLE columns (
          id TEXT PRIMARY KEY,
          name TEXT UNIQUE NOT NULL,
          position INTEGER NOT NULL,
          color TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`,
      )
      legacy.run(
        `CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          column_id TEXT NOT NULL,
          position INTEGER NOT NULL DEFAULT 0,
          priority TEXT NOT NULL DEFAULT 'medium',
          assignee TEXT NOT NULL DEFAULT '',
          metadata TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`,
      )
      legacy.run(
        `CREATE TABLE activity_log (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          action TEXT NOT NULL,
          field_changed TEXT,
          old_value TEXT,
          new_value TEXT,
          timestamp TEXT NOT NULL DEFAULT (datetime('now'))
        )`,
      )
      legacy.run(
        `CREATE TABLE column_time_tracking (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          column_id TEXT NOT NULL,
          entered_at TEXT NOT NULL DEFAULT (datetime('now')),
          exited_at TEXT
        )`,
      )
      legacy.run("INSERT INTO columns (id, name, position) VALUES ('c_backlog', 'backlog', 0)")
      legacy.close()

      const result = await run(['--db', dbPath, 'task', 'add', 'Migrated task'])
      expect(result.exitCode).toBe(0)
      expect(result.output.ok).toBe(true)

      const verify = new Database(dbPath)
      const columns = verify.query('PRAGMA table_info(tasks)').all() as { name: string }[]
      expect(columns.some((column) => column.name === 'project')).toBe(true)
      verify.close()
    })
  })

  test('runs task lifecycle commands through the real CLI path', async () => {
    await withTempDb(async (dbPath) => {
      const created = expectOk<Task>(
        await run([
          '--db',
          dbPath,
          'task',
          'add',
          'Build feature',
          '-d',
          'Do the thing',
          '-c',
          'recurring',
          '-p',
          'high',
          '-a',
          'alice',
          '--project',
          'Platform',
          '-m',
          '{"sprint":5}',
        ]),
      )
      expect(created.title).toBe('Build feature')
      expect(created.description).toBe('Do the thing')
      expect(created.priority).toBe('high')
      expect(created.assignee).toBe('alice')
      expect(created.project).toBe('Platform')
      expect(created.metadata).toBe('{"sprint":5}')

      const listed = expectOk<Task[]>(
        await run(['--db', dbPath, 'task', 'list', '-c', 'recurring']),
      )
      expect(listed).toHaveLength(1)
      expect(listed[0]!.id).toBe(created.id)

      const viewed = expectOk<Task>(await run(['--db', dbPath, 'task', 'view', created.id]))
      expect(viewed.id).toBe(created.id)

      const updated = expectOk<Task>(
        await run([
          '--db',
          dbPath,
          'task',
          'update',
          created.id,
          '--title',
          'Modified feature',
          '-d',
          'Ship it',
          '-p',
          'urgent',
          '-a',
          'bob',
          '--project',
          'Infra',
          '-m',
          '{"sprint":6}',
        ]),
      )
      expect(updated.title).toBe('Modified feature')
      expect(updated.description).toBe('Ship it')
      expect(updated.priority).toBe('urgent')
      expect(updated.assignee).toBe('bob')
      expect(updated.project).toBe('Infra')
      expect(updated.metadata).toBe('{"sprint":6}')

      const moved = expectOk<Task>(
        await run(['--db', dbPath, 'task', 'move', created.id, 'in-progress']),
      )
      expect(moved.column_id).toBeTruthy()

      const assigned = expectOk<Task>(
        await run(['--db', dbPath, 'task', 'assign', created.id, 'carol']),
      )
      expect(assigned.assignee).toBe('carol')

      const prioritized = expectOk<Task>(
        await run(['--db', dbPath, 'task', 'prioritize', created.id, 'low']),
      )
      expect(prioritized.priority).toBe('low')

      const deleted = expectOk<Task>(await run(['--db', dbPath, 'task', 'delete', created.id]))
      expect(deleted.id).toBe(created.id)

      await expectKanbanError(
        run(['--db', dbPath, 'task', 'view', created.id]),
        ErrorCode.TASK_NOT_FOUND,
      )
    })
  })

  test('lists and filters tasks through the CLI path', async () => {
    await withTempDb(async (dbPath) => {
      expectOk<Task>(await run(['--db', dbPath, 'task', 'add', 'A', '-c', 'recurring']))
      expectOk<Task>(await run(['--db', dbPath, 'task', 'add', 'B', '-c', 'done']))

      const allTasks = expectOk<Task[]>(await run(['--db', dbPath, 'task', 'list']))
      expect(allTasks).toHaveLength(2)

      const recurring = expectOk<Task[]>(
        await run(['--db', dbPath, 'task', 'list', '-c', 'recurring']),
      )
      expect(recurring).toHaveLength(1)
      expect(recurring[0]!.title).toBe('A')
    })
  })

  test('raises CLI errors for missing task arguments', async () => {
    await withTempDb(async (dbPath) => {
      const missingTitle = await expectKanbanError(
        run(['--db', dbPath, 'task', 'add']),
        ErrorCode.MISSING_ARGUMENT,
      )
      expect(missingTitle.message).toContain('Task title is required')

      const missingId = await expectKanbanError(
        run(['--db', dbPath, 'task', 'view']),
        ErrorCode.MISSING_ARGUMENT,
      )
      expect(missingId.message).toContain('Task ID is required')
    })
  })
})
