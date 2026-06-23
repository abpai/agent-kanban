import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ErrorCode, KanbanError, type ErrorCodeValue } from '../errors'
import { initSchema, seedDefaultColumns } from '../db'
import { run } from '../index'
import type { Task, TaskWithColumn } from '../types'

const CLI_ENTRY = fileURLToPath(new URL('../index.ts', import.meta.url))
const TEST_ENV_KEYS = [
  'KANBAN_PROVIDER',
  'KANBAN_STORAGE',
  'KANBAN_DB_PATH',
  'KANBAN_DEFAULT_COLUMNS',
  'KANBAN_DEFAULT_TASK_COLUMN',
  'HOME',
]

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function tempDir(prefix = 'kanban-cli-matrix-'): string {
  const dir = `${tmpdir()}/${prefix}${crypto.randomUUID()}`
  mkdirSync(dir, { recursive: true })
  tempDirs.push(dir)
  return dir
}

function tempDbPath(): string {
  return join(tempDir(), 'board.db')
}

async function withEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const previous = new Map<string, string | undefined>()
  for (const key of TEST_ENV_KEYS) previous.set(key, process.env[key])
  for (const key of TEST_ENV_KEYS) delete process.env[key]
  process.env['KANBAN_PROVIDER'] = 'local'
  process.env['KANBAN_STORAGE'] = 'sqlite'
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const key of TEST_ENV_KEYS) {
      const value = previous.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function withTempDb<T>(
  fn: (dbPath: string, dir: string) => Promise<T> | T,
  env: Record<string, string | undefined> = {},
): Promise<T> {
  const dir = tempDir()
  const dbPath = join(dir, 'board.db')
  return withEnv({ KANBAN_DB_PATH: dbPath, ...env }, () => fn(dbPath, dir))
}

function cliEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  for (const key of TEST_ENV_KEYS) delete env[key]
  return {
    ...env,
    KANBAN_PROVIDER: 'local',
    KANBAN_STORAGE: 'sqlite',
    // Force color off in the spawned CLI. An ambient FORCE_COLOR (e.g. from the
    // host terminal or CI) makes Bun wrap the error JSON on stderr in ANSI codes,
    // which breaks the JSON.parse(result.stderr) assertions. Pinning NO_COLOR /
    // FORCE_COLOR=0 here keeps stderr plain regardless of the host environment.
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    ...overrides,
  }
}

function cli(
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: options.cwd,
    env: options.env ?? cliEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout).trim(),
    stderr: new TextDecoder().decode(result.stderr).trim(),
  }
}

function initExistingDb(dbPath: string): void {
  mkdirSync(dbPath.slice(0, dbPath.lastIndexOf('/')), { recursive: true })
  const db = new Database(dbPath)
  try {
    db.run('PRAGMA foreign_keys = ON')
    initSchema(db)
    seedDefaultColumns(db)
  } finally {
    db.close()
  }
}

function readDb<T>(dbPath: string, read: (db: Database) => T): T {
  const db = new Database(dbPath)
  try {
    db.run('PRAGMA foreign_keys = ON')
    return read(db)
  } finally {
    db.close()
  }
}

function countRows(dbPath: string, table: string): number {
  return readDb(dbPath, (db) => {
    try {
      const row = db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
      return row.count
    } catch {
      return 0
    }
  })
}

function expectOk<T>(result: Awaited<ReturnType<typeof run>>): T {
  expect(result.exitCode).toBe(0)
  expect(result.output.ok).toBe(true)
  if (!result.output.ok) throw new Error('expected ok output')
  return result.output.data as T
}

async function expectRunError(
  promise: Promise<Awaited<ReturnType<typeof run>>>,
  code: ErrorCodeValue,
): Promise<KanbanError> {
  const err = await promise.then(
    () => null,
    (caught: unknown) => caught,
  )
  expect(err).toBeInstanceOf(KanbanError)
  expect((err as KanbanError).code).toBe(code)
  return err as KanbanError
}

async function addTask(
  dbPath: string,
  title: string,
  extra: string[] = [],
): Promise<TaskWithColumn> {
  return expectOk<TaskWithColumn>(await run(['--db', dbPath, 'task', 'add', title, ...extra]))
}

function activityCount(dbPath: string, where = ''): number {
  return readDb(dbPath, (db) => {
    const row = db.query(`SELECT COUNT(*) AS count FROM activity_log ${where}`).get() as {
      count: number
    }
    return row.count
  })
}

function columnTimeCount(dbPath: string, taskId: string): number {
  return readDb(dbPath, (db) => {
    const row = db
      .query('SELECT COUNT(*) AS count FROM column_time_tracking WHERE task_id = $taskId')
      .get({ $taskId: taskId }) as { count: number }
    return row.count
  })
}

describe('Phase 3 CLI task lifecycle execution matrix', () => {
  test('TC-001-01 uses isolated KANBAN_DB_PATH on a fresh local SQLite Cache', async () => {
    await withTempDb(async (dbPath, dir) => {
      const home = join(dir, 'home')
      mkdirSync(home, { recursive: true })
      const task = expectOk<TaskWithColumn>(await run(['task', 'add', 'Isolated task']))

      expect(existsSync(dbPath)).toBe(true)
      expect(task.title).toBe('Isolated task')
      expect(task.column_name).toBe('backlog')
      expect(countRows(dbPath, 'columns')).toBe(5)
      expect(countRows(dbPath, 'tasks')).toBe(1)
      expect(readDb(dbPath, (db) => db.query('PRAGMA journal_mode').get())).toEqual({
        journal_mode: 'wal',
      })
      expect(existsSync(join(home, '.kanban', 'board.db'))).toBe(false)
    })
  })

  test('TC-001-02 --db selects explicit SQLite path over KANBAN_DB_PATH', async () => {
    await withTempDb(async (envDbPath, dir) => {
      const flagDbPath = join(dir, 'flag.db')
      await addTask(flagDbPath, 'Flag path task')

      expect(countRows(flagDbPath, 'tasks')).toBe(1)
      expect(existsSync(envDbPath)).toBe(false)
    })
  })

  test('TC-001-03 KANBAN_DEFAULT_COLUMNS bootstraps custom Columns', async () => {
    await withTempDb(
      async (dbPath) => {
        const created = await addTask(dbPath, 'Custom column task', ['-c', 'Todo'])
        const listed = expectOk<Task[]>(await run(['--db', dbPath, 'task', 'list', '-c', 'Todo']))
        const columns = readDb(dbPath, (db) =>
          db.query('SELECT name, position FROM columns ORDER BY position').all(),
        )

        expect(created.column_name).toBe('Todo')
        expect(listed.map((task) => task.id)).toEqual([created.id])
        expect(columns).toEqual([
          { name: 'Todo', position: 0 },
          { name: 'Doing', position: 1 },
          { name: 'Done', position: 2 },
        ])
      },
      { KANBAN_DEFAULT_COLUMNS: 'Todo,Doing,Done' },
    )
  })

  test('TC-001-04 duplicate KANBAN_DEFAULT_COLUMNS names are rejected', async () => {
    await withTempDb(
      async (dbPath) => {
        await expectRunError(
          run(['--db', dbPath, 'task', 'add', 'Duplicate config']),
          ErrorCode.INVALID_CONFIG,
        )
        expect(existsSync(dbPath)).toBe(false)
      },
      { KANBAN_DEFAULT_COLUMNS: 'Todo,todo' },
    )
  })

  test('TC-001-05 unknown top-level CLI option is rejected before runtime work', async () => {
    await withTempDb(async (dbPath) => {
      await expectRunError(run(['--bogus']), ErrorCode.INVALID_ARGUMENT)
      expect(existsSync(dbPath)).toBe(false)
    })
  })

  test('TC-001-06 default path creates local ./.kanban/board.db when no DB exists', () => {
    const cwd = tempDir()
    const home = tempDir()
    const result = cli(['task', 'add', 'Auto local path'], {
      cwd,
      env: cliEnv({ HOME: home }),
    })

    expect(result.exitCode).toBe(0)
    expect(countRows(join(cwd, '.kanban', 'board.db'), 'tasks')).toBe(1)
    expect(existsSync(join(home, '.kanban', 'board.db'))).toBe(false)
  })

  test('TC-001-07 default path prefers existing local DB over existing HOME DB', () => {
    const cwd = tempDir()
    const home = tempDir()
    const localDbPath = join(cwd, '.kanban', 'board.db')
    const homeDbPath = join(home, '.kanban', 'board.db')
    initExistingDb(localDbPath)
    initExistingDb(homeDbPath)

    const result = cli(['task', 'add', 'Prefer local path'], {
      cwd,
      env: cliEnv({ HOME: home }),
    })

    expect(result.exitCode).toBe(0)
    expect(countRows(localDbPath, 'tasks')).toBe(1)
    expect(countRows(homeDbPath, 'tasks')).toBe(0)
  })

  test('TC-001-08 default path uses existing HOME DB when local DB is absent', () => {
    const cwd = tempDir()
    const home = tempDir()
    const homeDbPath = join(home, '.kanban', 'board.db')
    initExistingDb(homeDbPath)

    const result = cli(['task', 'add', 'Use home path'], {
      cwd,
      env: cliEnv({ HOME: home }),
    })

    expect(result.exitCode).toBe(0)
    expect(countRows(homeDbPath, 'tasks')).toBe(1)
    expect(existsSync(join(cwd, '.kanban', 'board.db'))).toBe(false)
  })

  test('TC-002-01 minimal task add creates a Task with defaults', async () => {
    await withTempDb(async (dbPath) => {
      const task = await addTask(dbPath, 'Minimal task')

      expect(task.id).toMatch(/^t_/)
      expect(task.title).toBe('Minimal task')
      expect(task.column_name).toBe('backlog')
      expect(task.priority).toBe('medium')
      expect(task.description).toBe('')
      expect(task.assignee).toBe('')
      expect(task.project).toBe('')
      expect(task.labels).toEqual([])
      expect(task.metadata).toBe('{}')
      expect(task.revision).toBe(0)
      expect(activityCount(dbPath, "WHERE action = 'created'")).toBe(1)
      expect(columnTimeCount(dbPath, task.id)).toBe(1)
    })
  })

  test('TC-002-02 task add preserves all structured flags', async () => {
    await withTempDb(async (dbPath) => {
      const task = await addTask(dbPath, 'Full task', [
        '-d',
        'Do work',
        '-c',
        'recurring',
        '-p',
        'high',
        '-a',
        'alice',
        '--project',
        'Platform',
        '--label',
        'garage-smoke',
        '--label',
        'owner-local,smoke-run',
        '-m',
        '{"sprint":5}',
      ])

      expect(task.description).toBe('Do work')
      expect(task.column_name).toBe('recurring')
      expect(task.priority).toBe('high')
      expect(task.assignee).toBe('alice')
      expect(task.project).toBe('Platform')
      expect(task.labels).toEqual(['garage-smoke', 'owner-local', 'smoke-run'])
      expect(task.metadata).toBe('{"sprint":5}')
    })
  })

  test('TC-002-03 label normalization trims, splits, ignores empty labels, and de-duplicates', async () => {
    await withTempDb(async (dbPath) => {
      const task = await addTask(dbPath, 'Label task', [
        '--label',
        'alpha, beta',
        '--labels',
        ' beta,,gamma ',
        '--label',
        'alpha',
      ])

      expect(task.labels).toEqual(['alpha', 'beta', 'gamma'])
    })
  })

  test('TC-002-09 public help documents both label flag spellings', async () => {
    await withTempDb(async (dbPath) => {
      const help = expectOk<{ message: string }>(await run(['--db', dbPath, '--help']))

      expect(help.message).toContain('--label name')
      expect(help.message).toContain('--labels names')
    })
  })

  test('TC-002-04 task add without title is rejected', async () => {
    await withTempDb(async (dbPath) => {
      const err = await expectRunError(
        run(['--db', dbPath, 'task', 'add']),
        ErrorCode.MISSING_ARGUMENT,
      )
      expect(err.message).toContain('Task title is required')
    })
  })

  test('TC-002-05 invalid create priority is rejected', async () => {
    await withTempDb(async (dbPath) => {
      await expectRunError(
        run(['--db', dbPath, 'task', 'add', 'Bad priority', '-p', 'critical']),
        ErrorCode.INVALID_PRIORITY,
      )
      expect(countRows(dbPath, 'tasks')).toBe(0)
    })
  })

  test('TC-002-06 invalid create metadata JSON is rejected', async () => {
    await withTempDb(async (dbPath) => {
      await expectRunError(
        run(['--db', dbPath, 'task', 'add', 'Bad metadata', '-m', 'not json']),
        ErrorCode.INVALID_METADATA,
      )
      expect(countRows(dbPath, 'tasks')).toBe(0)
    })
  })

  test('TC-002-07 unknown target Column is rejected on create', async () => {
    await withTempDb(async (dbPath) => {
      await expectRunError(
        run(['--db', dbPath, 'task', 'add', 'Bad column', '-c', 'missing-column']),
        ErrorCode.COLUMN_NOT_FOUND,
      )
      expect(countRows(dbPath, 'tasks')).toBe(0)
    })
  })

  test('TC-002-08 KANBAN_DEFAULT_TASK_COLUMN controls created-task Column for SQLite', async () => {
    await withTempDb(
      async (dbPath) => {
        const task = await addTask(dbPath, 'Default task column check')
        expect(task.column_name).toBe('review')
      },
      { KANBAN_DEFAULT_TASK_COLUMN: 'review' },
    )
  })

  test('TC-003-01 task list returns all Tasks in position order', async () => {
    await withTempDb(async (dbPath) => {
      await addTask(dbPath, 'A', ['-c', 'backlog'])
      await addTask(dbPath, 'B', ['-c', 'recurring'])
      await addTask(dbPath, 'C', ['-c', 'done'])

      const tasks = expectOk<Task[]>(await run(['--db', dbPath, 'task', 'list']))

      expect(tasks).toHaveLength(3)
      expect(tasks.map((task) => task.position)).toEqual(
        [...tasks].map((task) => task.position).sort((a, b) => a - b),
      )
    })
  })

  test('TC-003-02 task list filters by Column, priority, assignee, and project', async () => {
    await withTempDb(async (dbPath) => {
      const target = await addTask(dbPath, 'Target', [
        '-c',
        'recurring',
        '-p',
        'urgent',
        '-a',
        'alice',
        '--project',
        'Platform',
      ])
      await addTask(dbPath, 'Other', ['-c', 'done', '-p', 'low', '-a', 'bob', '--project', 'Ops'])

      for (const args of [
        ['-c', 'recurring'],
        ['-p', 'urgent'],
        ['-a', 'alice'],
        ['--project', 'Platform'],
        ['-c', 'recurring', '-p', 'urgent', '-a', 'alice', '--project', 'Platform'],
      ]) {
        const tasks = expectOk<Task[]>(await run(['--db', dbPath, 'task', 'list', ...args]))
        expect(tasks.map((task) => task.id)).toEqual([target.id])
      }
    })
  })

  test('TC-003-03 supported sort fields order Tasks as documented by code', async () => {
    await withTempDb(async (dbPath) => {
      const low = await addTask(dbPath, 'Zulu', ['-p', 'low'])
      const urgent = await addTask(dbPath, 'Alpha', ['-p', 'urgent'])
      const high = await addTask(dbPath, 'Mike', ['-p', 'high'])
      readDb(dbPath, (db) => {
        db.query(
          "UPDATE tasks SET created_at = CASE id WHEN $low THEN '2026-01-03 00:00:00' WHEN $urgent THEN '2026-01-01 00:00:00' ELSE '2026-01-02 00:00:00' END",
        ).run({ $low: low.id, $urgent: urgent.id })
        db.query(
          "UPDATE tasks SET updated_at = CASE id WHEN $low THEN '2026-01-02 00:00:00' WHEN $urgent THEN '2026-01-03 00:00:00' ELSE '2026-01-01 00:00:00' END",
        ).run({ $low: low.id, $urgent: urgent.id })
      })

      const byPriority = expectOk<Task[]>(
        await run(['--db', dbPath, 'task', 'list', '--sort', 'priority']),
      )
      const byTitle = expectOk<Task[]>(
        await run(['--db', dbPath, 'task', 'list', '--sort', 'title']),
      )
      const byPosition = expectOk<Task[]>(
        await run(['--db', dbPath, 'task', 'list', '--sort', 'position']),
      )
      const byCreated = expectOk<Task[]>(
        await run(['--db', dbPath, 'task', 'list', '--sort', 'created']),
      )
      const byUpdated = expectOk<Task[]>(
        await run(['--db', dbPath, 'task', 'list', '--sort', 'updated']),
      )

      expect(byPriority.map((task) => task.priority)).toEqual(['urgent', 'high', 'low'])
      expect(byTitle.map((task) => task.title)).toEqual(['Alpha', 'Mike', 'Zulu'])
      expect(byPosition.map((task) => task.id)).toEqual([low.id, urgent.id, high.id])
      expect(byCreated.map((task) => task.id)).toEqual([urgent.id, high.id, low.id])
      expect(byUpdated.map((task) => task.id)).toEqual([high.id, low.id, urgent.id])
    })
  })

  test('TC-003-04 positive integer limit caps returned rows', async () => {
    await withTempDb(async (dbPath) => {
      await addTask(dbPath, 'A')
      await addTask(dbPath, 'B')
      await addTask(dbPath, 'C')

      const tasks = expectOk<Task[]>(await run(['--db', dbPath, 'task', 'list', '-l', '2']))

      expect(tasks).toHaveLength(2)
    })
  })

  test('TC-003-05 invalid limits are rejected consistently', async () => {
    await withTempDb(async (dbPath) => {
      for (const value of ['0', '-1', '3.5', '1e3', '5abc', '9007199254740992']) {
        await expectRunError(
          run(['--db', dbPath, 'task', 'list', '-l', value]),
          ErrorCode.INVALID_ARGUMENT,
        )
      }
    })
  })

  test('TC-003-06 unknown Column filter is rejected', async () => {
    await withTempDb(async (dbPath) => {
      await expectRunError(
        run(['--db', dbPath, 'task', 'list', '-c', 'missing-column']),
        ErrorCode.COLUMN_NOT_FOUND,
      )
    })
  })

  test('TC-003-07 invalid priority filter returns no matches without mutation', async () => {
    await withTempDb(async (dbPath) => {
      await addTask(dbPath, 'Valid', ['-p', 'high'])

      const tasks = expectOk<Task[]>(await run(['--db', dbPath, 'task', 'list', '-p', 'critical']))

      expect(tasks).toEqual([])
      expect(countRows(dbPath, 'tasks')).toBe(1)
    })
  })

  test('TC-003-08 list with sort and limit remains responsive on a modest local board', async () => {
    await withTempDb(async (dbPath) => {
      for (let i = 0; i < 100; i += 1) {
        await addTask(dbPath, `Task ${String(i).padStart(3, '0')}`, [
          '-p',
          i % 2 === 0 ? 'high' : 'low',
        ])
      }
      const start = Date.now()

      const tasks = expectOk<Task[]>(
        await run(['--db', dbPath, 'task', 'list', '--sort', 'priority', '-l', '10']),
      )
      const elapsed = Date.now() - start

      expect(tasks).toHaveLength(10)
      expect(elapsed).toBeLessThan(2000)
    })
  })

  test('TC-003-09 updated-time sorting reflects Task mutation time', async () => {
    await withTempDb(async (dbPath) => {
      const older = await addTask(dbPath, 'Older')
      const newer = await addTask(dbPath, 'Newer')
      readDb(dbPath, (db) => {
        db.query(
          "UPDATE tasks SET updated_at = CASE id WHEN $older THEN '2026-01-01 00:00:00' ELSE '2026-01-02 00:00:00' END",
        ).run({ $older: older.id })
      })

      const tasks = expectOk<Task[]>(
        await run(['--db', dbPath, 'task', 'list', '--sort', 'updated']),
      )

      expect(tasks.map((task) => task.id)).toEqual([older.id, newer.id])
    })
  })

  test('TC-003-10 unknown --sort falls back to position and does not error', async () => {
    await withTempDb(async (dbPath) => {
      await addTask(dbPath, 'A')
      await addTask(dbPath, 'B')
      await addTask(dbPath, 'C')

      const byPosition = expectOk<Task[]>(
        await run(['--db', dbPath, 'task', 'list', '--sort', 'position']),
      )
      const byUnknown = expectOk<Task[]>(
        await run(['--db', dbPath, 'task', 'list', '--sort', 'not-a-field']),
      )

      expect(byUnknown.map((task) => task.id)).toEqual(byPosition.map((task) => task.id))
    })
  })

  test('TC-004-01 task view returns a created Task with enriched local fields', async () => {
    await withTempDb(async (dbPath) => {
      const created = await addTask(dbPath, 'View me', ['--label', 'x', '-m', '{"a":1}'])

      const viewed = expectOk<TaskWithColumn>(
        await run(['--db', dbPath, 'task', 'view', created.id]),
      )

      expect(viewed.id).toBe(created.id)
      expect(viewed.column_name).toBe('backlog')
      expect(viewed.labels).toEqual(['x'])
      expect(viewed.providerId).toBe(created.id)
      expect(viewed.externalRef).toBe(created.id)
      expect(viewed.url).toBeNull()
      expect(viewed.comment_count).toBe(0)
      expect(viewed.version).toBe('0')
      expect(viewed.source_updated_at).toBeNull()
    })
  })

  test('TC-004-02 task view without id is rejected', async () => {
    await withTempDb(async (dbPath) => {
      const err = await expectRunError(
        run(['--db', dbPath, 'task', 'view']),
        ErrorCode.MISSING_ARGUMENT,
      )
      expect(err.message).toContain('Task ID is required')
    })
  })

  test('TC-004-03 task view for unknown id is rejected', async () => {
    await withTempDb(async (dbPath) => {
      await expectRunError(
        run(['--db', dbPath, 'task', 'view', 't_missing']),
        ErrorCode.TASK_NOT_FOUND,
      )
    })
  })

  test('TC-004-04 pretty task view includes only non-empty optional fields', () => {
    const dbPath = tempDbPath()
    const full = cli(
      [
        '--db',
        dbPath,
        'task',
        'add',
        'Pretty full',
        '-d',
        'Details',
        '-a',
        'alice',
        '--project',
        'Platform',
        '-m',
        '{"ok":true}',
      ],
      { env: cliEnv() },
    )
    const fullId = JSON.parse(full.stdout).data.id as string
    const minimal = cli(['--db', dbPath, 'task', 'add', 'Pretty minimal'], { env: cliEnv() })
    const minimalId = JSON.parse(minimal.stdout).data.id as string

    const fullView = cli(['--db', dbPath, 'task', 'view', fullId, '--pretty'], { env: cliEnv() })
    const minimalView = cli(['--db', dbPath, 'task', 'view', minimalId, '--pretty'], {
      env: cliEnv(),
    })

    expect(fullView.stdout).toContain('Assignee: alice')
    expect(fullView.stdout).toContain('Project: Platform')
    expect(fullView.stdout).toContain('Description: Details')
    expect(fullView.stdout).toContain('Metadata: {"ok":true}')
    expect(minimalView.stdout).not.toContain('Assignee:')
    expect(minimalView.stdout).not.toContain('Project:')
    expect(minimalView.stdout).not.toContain('Description:')
    expect(minimalView.stdout).not.toContain('Metadata:')
  })

  test('TC-005-01 task update changes every supported field', async () => {
    await withTempDb(async (dbPath) => {
      const created = await addTask(dbPath, 'Original')

      const updated = expectOk<Task>(
        await run([
          '--db',
          dbPath,
          'task',
          'update',
          created.id,
          '--title',
          'Updated',
          '-d',
          'New desc',
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

      expect(updated.title).toBe('Updated')
      expect(updated.description).toBe('New desc')
      expect(updated.priority).toBe('urgent')
      expect(updated.assignee).toBe('bob')
      expect(updated.project).toBe('Infra')
      expect(updated.metadata).toBe('{"sprint":6}')
      expect(updated.revision).toBe((created.revision ?? 0) + 1)
    })
  })

  test('TC-005-02 task update changes only supplied fields', async () => {
    await withTempDb(async (dbPath) => {
      const created = await addTask(dbPath, 'Original', ['-d', 'Keep', '-p', 'high', '-a', 'alice'])

      const updated = expectOk<Task>(
        await run(['--db', dbPath, 'task', 'update', created.id, '--title', 'New title']),
      )

      expect(updated.title).toBe('New title')
      expect(updated.description).toBe('Keep')
      expect(updated.priority).toBe('high')
      expect(updated.assignee).toBe('alice')
      expect(updated.revision).toBe((created.revision ?? 0) + 1)
    })
  })

  test('TC-005-03 task update with no field flags follows current code behavior', async () => {
    await withTempDb(async (dbPath) => {
      const created = await addTask(dbPath, 'No-op update')

      const updated = expectOk<Task>(await run(['--db', dbPath, 'task', 'update', created.id]))

      expect(updated.title).toBe(created.title)
      expect(updated.revision).toBe((created.revision ?? 0) + 1)
    })
  })

  test('TC-005-04 task update requires an existing Task id', async () => {
    await withTempDb(async (dbPath) => {
      await expectRunError(run(['--db', dbPath, 'task', 'update']), ErrorCode.MISSING_ARGUMENT)
      await expectRunError(
        run(['--db', dbPath, 'task', 'update', 't_missing', '--title', 'X']),
        ErrorCode.TASK_NOT_FOUND,
      )
    })
  })

  test('TC-005-05 invalid update priority is rejected without mutation', async () => {
    await withTempDb(async (dbPath) => {
      const created = await addTask(dbPath, 'Priority update', ['-p', 'high'])

      await expectRunError(
        run(['--db', dbPath, 'task', 'update', created.id, '-p', 'critical']),
        ErrorCode.INVALID_PRIORITY,
      )
      const viewed = expectOk<Task>(await run(['--db', dbPath, 'task', 'view', created.id]))
      expect(viewed.priority).toBe('high')
    })
  })

  test('TC-005-06 invalid update metadata is rejected without mutation', async () => {
    await withTempDb(async (dbPath) => {
      const created = await addTask(dbPath, 'Metadata update', ['-m', '{"a":1}'])

      await expectRunError(
        run(['--db', dbPath, 'task', 'update', created.id, '-m', 'not json']),
        ErrorCode.INVALID_METADATA,
      )
      const viewed = expectOk<Task>(await run(['--db', dbPath, 'task', 'view', created.id]))
      expect(viewed.metadata).toBe('{"a":1}')
    })
  })

  test('TC-005-07 changed fields write activity and unchanged fields do not duplicate shortcut activity', async () => {
    await withTempDb(async (dbPath) => {
      const task = await addTask(dbPath, 'Activity task')

      expectOk<Task>(
        await run([
          '--db',
          dbPath,
          'task',
          'update',
          task.id,
          '--title',
          'Activity updated',
          '-d',
          'desc',
          '-p',
          'urgent',
          '-a',
          'alice',
          '--project',
          'Platform',
          '-m',
          '{"a":1}',
        ]),
      )
      const assignedBefore = activityCount(dbPath, "WHERE action = 'assigned'")
      const prioritizedBefore = activityCount(dbPath, "WHERE action = 'prioritized'")
      expect(assignedBefore).toBe(1)
      expect(prioritizedBefore).toBe(1)
      expect(
        activityCount(
          dbPath,
          "WHERE action = 'updated' AND field_changed IN ('project','title','description','metadata')",
        ),
      ).toBe(4)

      expectOk<Task>(
        await run(['--db', dbPath, 'task', 'update', task.id, '-a', 'alice', '-p', 'urgent']),
      )

      expect(activityCount(dbPath, "WHERE action = 'assigned'")).toBe(assignedBefore)
      expect(activityCount(dbPath, "WHERE action = 'prioritized'")).toBe(prioritizedBefore)
    })
  })

  test('TC-006-01 task move changes Column and appends to target Column', async () => {
    await withTempDb(async (dbPath) => {
      await addTask(dbPath, 'Existing target', ['-c', 'in-progress'])
      const task = await addTask(dbPath, 'Move me')
      const beforeTime = columnTimeCount(dbPath, task.id)

      const moved = expectOk<TaskWithColumn>(
        await run(['--db', dbPath, 'task', 'move', task.id, 'in-progress']),
      )

      expect(moved.column_name).toBe('in-progress')
      expect(moved.position).toBe(1)
      expect(moved.revision).toBe((task.revision ?? 0) + 1)
      expect(activityCount(dbPath, "WHERE action = 'moved'")).toBe(1)
      expect(columnTimeCount(dbPath, task.id)).toBe(beforeTime + 1)
    })
  })

  test('TC-006-02 moving a Task to its current Column is a no-op', async () => {
    await withTempDb(async (dbPath) => {
      const task = await addTask(dbPath, 'Stay put')
      const activityBefore = activityCount(dbPath)
      const timeBefore = columnTimeCount(dbPath, task.id)

      const moved = expectOk<TaskWithColumn>(
        await run(['--db', dbPath, 'task', 'move', task.id, 'backlog']),
      )

      expect(moved.column_name).toBe('backlog')
      expect(moved.revision).toBe(task.revision)
      expect(activityCount(dbPath)).toBe(activityBefore)
      expect(columnTimeCount(dbPath, task.id)).toBe(timeBefore)
    })
  })

  test('TC-006-03 task move requires id and Column', async () => {
    await withTempDb(async (dbPath) => {
      await expectRunError(run(['--db', dbPath, 'task', 'move']), ErrorCode.MISSING_ARGUMENT)
      await expectRunError(run(['--db', dbPath, 'task', 'move', 't_1']), ErrorCode.MISSING_ARGUMENT)
    })
  })

  test('TC-006-04 task move rejects unknown Task id', async () => {
    await withTempDb(async (dbPath) => {
      await expectRunError(
        run(['--db', dbPath, 'task', 'move', 't_missing', 'backlog']),
        ErrorCode.TASK_NOT_FOUND,
      )
    })
  })

  test('TC-006-05 task move rejects unknown target Column without moving the Task', async () => {
    await withTempDb(async (dbPath) => {
      const task = await addTask(dbPath, 'Bad move')

      await expectRunError(
        run(['--db', dbPath, 'task', 'move', task.id, 'missing-column']),
        ErrorCode.COLUMN_NOT_FOUND,
      )
      const viewed = expectOk<TaskWithColumn>(await run(['--db', dbPath, 'task', 'view', task.id]))
      expect(viewed.column_name).toBe('backlog')
    })
  })

  test('TC-007-01 task assign sets the assignee shortcut', async () => {
    await withTempDb(async (dbPath) => {
      const task = await addTask(dbPath, 'Assign me')

      const assigned = expectOk<Task>(
        await run(['--db', dbPath, 'task', 'assign', task.id, 'carol']),
      )

      expect(assigned.assignee).toBe('carol')
      expect(assigned.revision).toBe((task.revision ?? 0) + 1)
      expect(activityCount(dbPath, "WHERE action = 'assigned'")).toBe(1)
    })
  })

  test('TC-007-02 assigning the same assignee does not duplicate assigned activity', async () => {
    await withTempDb(async (dbPath) => {
      const task = await addTask(dbPath, 'Already assigned', ['-a', 'carol'])
      const assignedBefore = activityCount(dbPath, "WHERE action = 'assigned'")

      const assigned = expectOk<Task>(
        await run(['--db', dbPath, 'task', 'assign', task.id, 'carol']),
      )

      expect(assigned.assignee).toBe('carol')
      expect(assigned.revision).toBe((task.revision ?? 0) + 1)
      expect(activityCount(dbPath, "WHERE action = 'assigned'")).toBe(assignedBefore)
    })
  })

  test('TC-007-03 task assign requires id and assignee', async () => {
    await withTempDb(async (dbPath) => {
      await expectRunError(run(['--db', dbPath, 'task', 'assign']), ErrorCode.MISSING_ARGUMENT)
      await expectRunError(
        run(['--db', dbPath, 'task', 'assign', 't_1']),
        ErrorCode.MISSING_ARGUMENT,
      )
    })
  })

  test('TC-007-04 task assign rejects unknown Task id', async () => {
    await withTempDb(async (dbPath) => {
      await expectRunError(
        run(['--db', dbPath, 'task', 'assign', 't_missing', 'alice']),
        ErrorCode.TASK_NOT_FOUND,
      )
    })
  })

  test('TC-008-01 task prioritize sets a valid priority shortcut', async () => {
    await withTempDb(async (dbPath) => {
      const task = await addTask(dbPath, 'Prioritize me')

      const prioritized = expectOk<Task>(
        await run(['--db', dbPath, 'task', 'prioritize', task.id, 'urgent']),
      )

      expect(prioritized.priority).toBe('urgent')
      expect(prioritized.revision).toBe((task.revision ?? 0) + 1)
      expect(activityCount(dbPath, "WHERE action = 'prioritized'")).toBe(1)
    })
  })

  test('TC-008-02 prioritizing to the same level does not duplicate prioritized activity', async () => {
    await withTempDb(async (dbPath) => {
      const task = await addTask(dbPath, 'Same priority', ['-p', 'high'])
      const prioritizedBefore = activityCount(dbPath, "WHERE action = 'prioritized'")

      const prioritized = expectOk<Task>(
        await run(['--db', dbPath, 'task', 'prioritize', task.id, 'high']),
      )

      expect(prioritized.priority).toBe('high')
      expect(prioritized.revision).toBe((task.revision ?? 0) + 1)
      expect(activityCount(dbPath, "WHERE action = 'prioritized'")).toBe(prioritizedBefore)
    })
  })

  test('TC-008-03 task prioritize requires id and level', async () => {
    await withTempDb(async (dbPath) => {
      await expectRunError(run(['--db', dbPath, 'task', 'prioritize']), ErrorCode.MISSING_ARGUMENT)
      await expectRunError(
        run(['--db', dbPath, 'task', 'prioritize', 't_1']),
        ErrorCode.MISSING_ARGUMENT,
      )
    })
  })

  test('TC-008-04 task prioritize rejects invalid priority without mutation', async () => {
    await withTempDb(async (dbPath) => {
      const task = await addTask(dbPath, 'Bad priority shortcut', ['-p', 'medium'])

      await expectRunError(
        run(['--db', dbPath, 'task', 'prioritize', task.id, 'critical']),
        ErrorCode.INVALID_PRIORITY,
      )
      const viewed = expectOk<Task>(await run(['--db', dbPath, 'task', 'view', task.id]))
      expect(viewed.priority).toBe('medium')
    })
  })

  test('TC-008-05 task prioritize rejects unknown Task id for valid priority input', async () => {
    await withTempDb(async (dbPath) => {
      await expectRunError(
        run(['--db', dbPath, 'task', 'prioritize', 't_missing', 'high']),
        ErrorCode.TASK_NOT_FOUND,
      )
    })
  })

  test('TC-009-01 task delete removes a Task and returns the deleted Task', async () => {
    await withTempDb(async (dbPath) => {
      const task = await addTask(dbPath, 'Delete me')

      const deleted = expectOk<Task>(await run(['--db', dbPath, 'task', 'delete', task.id]))

      expect(deleted.id).toBe(task.id)
      await expectRunError(run(['--db', dbPath, 'task', 'view', task.id]), ErrorCode.TASK_NOT_FOUND)
      expect(activityCount(dbPath, "WHERE action = 'deleted'")).toBe(1)
    })
  })

  test('TC-009-02 deleting a Task renumbers remaining Tasks in the old Column', async () => {
    await withTempDb(async (dbPath) => {
      const first = await addTask(dbPath, 'First')
      const middle = await addTask(dbPath, 'Middle')
      const last = await addTask(dbPath, 'Last')

      expectOk<Task>(await run(['--db', dbPath, 'task', 'delete', middle.id]))
      const tasks = expectOk<Task[]>(await run(['--db', dbPath, 'task', 'list', '-c', 'backlog']))

      expect(tasks.map((task) => [task.id, task.position])).toEqual([
        [first.id, 0],
        [last.id, 1],
      ])
    })
  })

  test('TC-009-03 task delete requires an existing id', async () => {
    await withTempDb(async (dbPath) => {
      await expectRunError(run(['--db', dbPath, 'task', 'delete']), ErrorCode.MISSING_ARGUMENT)
      await expectRunError(
        run(['--db', dbPath, 'task', 'delete', 't_missing']),
        ErrorCode.TASK_NOT_FOUND,
      )
    })
  })

  test('TC-009-04 deleting a Task cascades directly seeded dependent comments', async () => {
    await withTempDb(async (dbPath) => {
      const task = await addTask(dbPath, 'Cascade delete')
      readDb(dbPath, (db) => {
        db.query(
          "INSERT INTO comments (id, task_id, body, author) VALUES ('cm_direct', $taskId, 'body', NULL)",
        ).run({ $taskId: task.id })
      })

      expectOk<Task>(await run(['--db', dbPath, 'task', 'delete', task.id]))

      expect(
        readDb(dbPath, (db) => {
          const row = db
            .query('SELECT COUNT(*) AS count FROM comments WHERE task_id = $taskId')
            .get({ $taskId: task.id }) as { count: number }
          return row.count
        }),
      ).toBe(0)
    })
  })

  test('TC-010-01 default CLI output is compact JSON success envelope', () => {
    const dbPath = tempDbPath()

    const result = cli(['--db', dbPath, 'task', 'add', 'JSON output'], { env: cliEnv() })

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, data: { title: 'JSON output' } })
    expect(result.stdout).not.toContain('Task:')
  })

  test('TC-010-02 --pretty formats task list and task detail for humans', () => {
    const dbPath = tempDbPath()
    const created = cli(
      [
        '--db',
        dbPath,
        'task',
        'add',
        'Pretty task',
        '-p',
        'high',
        '-a',
        'alice',
        '--project',
        'Platform',
      ],
      { env: cliEnv() },
    )
    const taskId = JSON.parse(created.stdout).data.id as string

    const list = cli(['--db', dbPath, 'task', 'list', '--pretty'], { env: cliEnv() })
    const view = cli(['--db', dbPath, 'task', 'view', taskId, '--pretty'], { env: cliEnv() })

    expect(list.stdout).toContain('[!! ]')
    expect(list.stdout).toContain(taskId)
    expect(list.stdout).toContain('@alice')
    expect(list.stdout).toContain('[Platform]')
    expect(view.stdout).toContain(`Task: ${taskId}`)
    expect(view.stdout).toContain('Priority: high')
  })

  test('TC-010-03 pretty empty arrays render as No items found.', () => {
    const dbPath = tempDbPath()

    const result = cli(['--db', dbPath, 'task', 'list', '-p', 'urgent', '--pretty'], {
      env: cliEnv(),
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('No items found.')
  })

  test('TC-010-04 unknown task action reports UNKNOWN_COMMAND', async () => {
    await withTempDb(async (dbPath) => {
      await expectRunError(run(['--db', dbPath, 'task', 'frobnicate']), ErrorCode.UNKNOWN_COMMAND)
      const result = cli(['--db', dbPath, 'task', 'frobnicate'], { env: cliEnv() })
      expect(result.exitCode).toBe(1)
      expect(JSON.parse(result.stderr)).toMatchObject({
        ok: false,
        error: { code: 'UNKNOWN_COMMAND' },
      })
    })
  })

  test('TC-010-05 KanbanError process exits 1 and formats errors', () => {
    const dbPath = tempDbPath()
    const badDbPath = tempDir()

    const json = cli(['--db', dbPath, 'task', 'view', 't_missing'], { env: cliEnv() })
    const pretty = cli(['--db', dbPath, 'task', 'view', 't_missing', '--pretty'], {
      env: cliEnv(),
    })
    const unexpected = cli(['--db', badDbPath, 'task', 'list'], { env: cliEnv() })

    expect(json.exitCode).toBe(1)
    expect(JSON.parse(json.stderr)).toMatchObject({
      ok: false,
      error: { code: 'TASK_NOT_FOUND' },
    })
    expect(pretty.exitCode).toBe(1)
    expect(pretty.stderr).toContain('Error [TASK_NOT_FOUND]')
    expect(unexpected.exitCode).toBe(2)
    expect(JSON.parse(unexpected.stderr)).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR' },
    })
    expect(unexpected.stderr).toContain('unable to open database file')
  })

  test('JRN-001 full local Task lifecycle from creation to deletion', async () => {
    await withTempDb(async (dbPath) => {
      const created = await addTask(dbPath, 'Journey task', [
        '-d',
        'Journey details',
        '-p',
        'high',
        '-a',
        'agent',
        '--project',
        'Slice',
        '-m',
        '{"journey":1}',
      ])

      expectOk<Task[]>(await run(['--db', dbPath, 'task', 'list', '-c', 'backlog']))
      expectOk<Task[]>(await run(['--db', dbPath, 'task', 'list', '--project', 'Slice']))
      expectOk<Task>(await run(['--db', dbPath, 'task', 'view', created.id]))
      const updated = expectOk<Task>(
        await run(['--db', dbPath, 'task', 'update', created.id, '--title', 'Journey updated']),
      )
      const assigned = expectOk<Task>(
        await run(['--db', dbPath, 'task', 'assign', updated.id, 'reviewer']),
      )
      const prioritized = expectOk<Task>(
        await run(['--db', dbPath, 'task', 'prioritize', assigned.id, 'urgent']),
      )
      for (const column of ['in-progress', 'review', 'done']) {
        expectOk<Task>(await run(['--db', dbPath, 'task', 'move', prioritized.id, column]))
      }
      const deleted = expectOk<Task>(await run(['--db', dbPath, 'task', 'delete', prioritized.id]))

      expect(deleted.id).toBe(created.id)
      await expectRunError(
        run(['--db', dbPath, 'task', 'view', created.id]),
        ErrorCode.TASK_NOT_FOUND,
      )
      expect(activityCount(dbPath, "WHERE action = 'moved'")).toBe(3)
      expect(activityCount(dbPath, "WHERE action = 'deleted'")).toBe(1)
    })
  })

  test('JRN-002 automation JSON capture and reuse', () => {
    const dbPath = tempDbPath()

    const created = cli(['--db', dbPath, 'task', 'add', 'Automation task'], { env: cliEnv() })
    const parsed = JSON.parse(created.stdout) as { ok: true; data: { id: string } }
    const viewed = cli(['--db', dbPath, 'task', 'view', parsed.data.id], { env: cliEnv() })
    const viewedParsed = JSON.parse(viewed.stdout) as { ok: true; data: { id: string } }

    expect(created.exitCode).toBe(0)
    expect(viewed.exitCode).toBe(0)
    expect(parsed.ok).toBe(true)
    expect(viewedParsed.ok).toBe(true)
    expect(viewedParsed.data.id).toBe(parsed.data.id)
    expect(created.stdout).not.toContain('Task:')
    expect(viewed.stdout).not.toContain('Task:')
  })

  test('JRN-003 human review workflow with pretty output', () => {
    const dbPath = tempDbPath()
    const created = cli(
      [
        '--db',
        dbPath,
        'task',
        'add',
        'Human review',
        '-d',
        'Reviewable',
        '-p',
        'high',
        '-a',
        'alice',
        '--project',
        'Docs',
      ],
      { env: cliEnv() },
    )
    const taskId = JSON.parse(created.stdout).data.id as string

    const list = cli(['--db', dbPath, 'task', 'list', '--pretty'], { env: cliEnv() })
    const view = cli(['--db', dbPath, 'task', 'view', taskId, '--pretty'], { env: cliEnv() })
    const empty = cli(['--db', dbPath, 'task', 'list', '-p', 'urgent', '--pretty'], {
      env: cliEnv(),
    })

    expect(list.stdout).toContain('Human review')
    expect(view.stdout).toContain(`Task: ${taskId}`)
    expect(view.stdout).toContain('Description: Reviewable')
    expect(empty.stdout).toBe('No items found.')
    expect(list.stdout).not.toContain('"ok"')
    expect(view.stdout).not.toContain('"ok"')
  })
})
