import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { run } from '../index.ts'

describe('run', () => {
  test('applies schema migration before task commands', async () => {
    process.env['KANBAN_PROVIDER'] = 'local'
    const dir = mkdtempSync(join(tmpdir(), 'kanban-run-'))
    const dbPath = join(dir, 'board.db')

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

    try {
      const result = await run(['--db', dbPath, 'task', 'add', 'Migrated task'])
      expect(result.exitCode).toBe(0)
      expect(result.output.ok).toBe(true)

      const verify = new Database(dbPath)
      const columns = verify.query('PRAGMA table_info(tasks)').all() as { name: string }[]
      expect(columns.some((column) => column.name === 'project')).toBe(true)
      verify.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
