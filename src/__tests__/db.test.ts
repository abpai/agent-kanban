import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getDbPath,
  initSchema,
  seedDefaultColumns,
  isInitialized,
  listColumns,
  resolveColumn,
  addColumn,
  renameColumn,
  reorderColumn,
  deleteColumn,
  addTask,
  getTask,
  listTasks,
  updateTask,
  deleteTask,
  moveTask,
  getBoardView,
  bulkMoveAll,
  bulkClearDone,
  resetBoard,
  migrateSchema,
} from '../db'
import { KanbanError } from '../errors'

let db: Database
let originalCwd: string
let originalHome: string | undefined
let tempDirsToRemove: string[]

beforeEach(() => {
  originalCwd = process.cwd()
  originalHome = process.env['HOME']
  tempDirsToRemove = []
})

beforeEach(() => {
  db = new Database(':memory:')
  db.run('PRAGMA foreign_keys = ON')
  initSchema(db)
  seedDefaultColumns(db)
})

afterEach(() => {
  process.chdir(originalCwd)

  if (originalHome === undefined) {
    delete process.env['HOME']
  } else {
    process.env['HOME'] = originalHome
  }

  for (const dir of tempDirsToRemove) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('schema', () => {
  test('isInitialized returns true after init', () => {
    expect(isInitialized(db)).toBe(true)
  })

  test('isInitialized returns false on fresh db', () => {
    const fresh = new Database(':memory:')
    expect(isInitialized(fresh)).toBe(false)
  })

  test('seeds 5 default columns', () => {
    expect(listColumns(db)).toHaveLength(5)
  })

  test('seedDefaultColumns is idempotent', () => {
    seedDefaultColumns(db)
    expect(listColumns(db)).toHaveLength(5)
  })

  test('migrateSchema adds project column and index to legacy tasks table', () => {
    const legacy = new Database(':memory:')
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

    migrateSchema(legacy)

    const columns = legacy.query('PRAGMA table_info(tasks)').all() as { name: string }[]
    const indexes = legacy.query('PRAGMA index_list(tasks)').all() as { name: string }[]

    expect(columns.some((c) => c.name === 'project')).toBe(true)
    expect(indexes.some((i) => i.name === 'idx_tasks_project')).toBe(true)
  })

  test('getDbPath prefers local board when present', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'agent-kanban-local-'))
    tempDirsToRemove.push(tempRoot)
    const projectDir = join(tempRoot, 'project')
    mkdirSync(join(projectDir, '.kanban'), { recursive: true })
    writeFileSync(join(projectDir, '.kanban', 'board.db'), '')

    const fakeHome = join(tempRoot, 'home')
    mkdirSync(join(fakeHome, '.kanban'), { recursive: true })
    writeFileSync(join(fakeHome, '.kanban', 'board.db'), '')

    process.chdir(projectDir)
    process.env['HOME'] = fakeHome
    delete process.env['KANBAN_DB_PATH']

    expect(getDbPath()).toBe('.kanban/board.db')
  })

  test('getDbPath falls back to global board when local board is absent', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'agent-kanban-global-'))
    tempDirsToRemove.push(tempRoot)
    const projectDir = join(tempRoot, 'project')
    mkdirSync(projectDir, { recursive: true })

    const fakeHome = join(tempRoot, 'home')
    mkdirSync(join(fakeHome, '.kanban'), { recursive: true })
    const globalBoard = join(fakeHome, '.kanban', 'board.db')
    writeFileSync(globalBoard, '')

    process.chdir(projectDir)
    process.env['HOME'] = fakeHome
    delete process.env['KANBAN_DB_PATH']

    expect(getDbPath()).toBe(globalBoard)
  })
})

describe('columns', () => {
  test('resolveColumn by name (case-insensitive)', () => {
    const col = resolveColumn(db, 'BACKLOG')
    expect(col.name).toBe('backlog')
  })

  test('resolveColumn by id', () => {
    const cols = listColumns(db)
    const col = resolveColumn(db, cols[0]!.id)
    expect(col.name).toBe('recurring')
  })

  test('resolveColumn throws for unknown', () => {
    expect(() => resolveColumn(db, 'nonexistent')).toThrow(KanbanError)
  })

  test('addColumn appends at end', () => {
    const col = addColumn(db, 'testing')
    expect(col.name).toBe('testing')
    expect(col.position).toBe(5)
  })

  test('addColumn at specific position shifts others', () => {
    addColumn(db, 'testing', { position: 1 })
    const cols = listColumns(db)
    expect(cols.find((c) => c.name === 'testing')!.position).toBe(1)
    expect(cols.find((c) => c.name === 'backlog')!.position).toBe(2)
  })

  test('addColumn rejects duplicate name', () => {
    expect(() => addColumn(db, 'recurring')).toThrow(KanbanError)
  })

  test('renameColumn works', () => {
    const col = renameColumn(db, 'recurring', 'weekly')
    expect(col.name).toBe('weekly')
  })

  test('reorderColumn moves column', () => {
    const col = reorderColumn(db, 'done', 0)
    expect(col.position).toBe(0)
    const cols = listColumns(db)
    expect(cols[0]!.name).toBe('done')
  })

  test('deleteColumn removes empty column', () => {
    const col = deleteColumn(db, 'review')
    expect(col.name).toBe('review')
    expect(listColumns(db)).toHaveLength(4)
  })

  test('deleteColumn fails if tasks exist', () => {
    addTask(db, 'Test', { column: 'recurring' })
    expect(() => deleteColumn(db, 'recurring')).toThrow(KanbanError)
  })
})

describe('tasks', () => {
  test('addTask creates task in specified column', () => {
    const task = addTask(db, 'My task', { column: 'recurring', priority: 'high' })
    expect(task.title).toBe('My task')
    expect(task.column_name).toBe('recurring')
    expect(task.priority).toBe('high')
    expect(task.id).toMatch(/^t_/)
  })

  test('addTask defaults to backlog', () => {
    const task = addTask(db, 'My task')
    expect(task.column_name).toBe('backlog')
  })

  test('addTask validates priority', () => {
    expect(() => addTask(db, 'Bad', { priority: 'critical' as 'high' })).toThrow(KanbanError)
  })

  test('addTask validates metadata', () => {
    expect(() => addTask(db, 'Bad', { metadata: 'not json' })).toThrow(KanbanError)
  })

  test('getTask returns task with column_name', () => {
    const created = addTask(db, 'Find me')
    const found = getTask(db, created.id)
    expect(found.title).toBe('Find me')
    expect(found.column_name).toBeDefined()
  })

  test('getTask throws for unknown id', () => {
    expect(() => getTask(db, 't_nonexist')).toThrow(KanbanError)
  })

  test('listTasks filters by column', () => {
    addTask(db, 'Task A', { column: 'recurring' })
    addTask(db, 'Task B', { column: 'backlog' })
    const tasks = listTasks(db, { column: 'recurring' })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.title).toBe('Task A')
  })

  test('listTasks filters by priority', () => {
    addTask(db, 'Urgent!', { priority: 'urgent' })
    addTask(db, 'Chill', { priority: 'low' })
    const tasks = listTasks(db, { priority: 'urgent' })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.title).toBe('Urgent!')
  })

  test('listTasks filters by assignee', () => {
    addTask(db, 'Mine', { assignee: 'alice' })
    addTask(db, 'Theirs', { assignee: 'bob' })
    const tasks = listTasks(db, { assignee: 'alice' })
    expect(tasks).toHaveLength(1)
  })

  test('listTasks respects limit', () => {
    addTask(db, 'A')
    addTask(db, 'B')
    addTask(db, 'C')
    expect(listTasks(db, { limit: 2 })).toHaveLength(2)
  })

  test('updateTask modifies fields', () => {
    const task = addTask(db, 'Original')
    const updated = updateTask(db, task.id, {
      title: 'Updated',
      priority: 'urgent',
      assignee: 'bob',
    })
    expect(updated.title).toBe('Updated')
    expect(updated.priority).toBe('urgent')
    expect(updated.assignee).toBe('bob')
  })

  test('deleteTask removes task', () => {
    const task = addTask(db, 'Doomed')
    deleteTask(db, task.id)
    expect(() => getTask(db, task.id)).toThrow(KanbanError)
  })

  test('moveTask changes column', () => {
    const task = addTask(db, 'Mobile', { column: 'recurring' })
    const moved = moveTask(db, task.id, 'in-progress')
    expect(moved.column_name).toBe('in-progress')
  })
})

describe('board view', () => {
  test('returns all columns with tasks', () => {
    addTask(db, 'Task A', { column: 'recurring' })
    const view = getBoardView(db)
    expect(view.columns).toHaveLength(5)
    const recurringCol = view.columns.find((c) => c.name === 'recurring')!
    expect(recurringCol.tasks).toHaveLength(1)
  })
})

describe('bulk operations', () => {
  test('bulkMoveAll moves all tasks between columns', () => {
    addTask(db, 'A', { column: 'recurring' })
    addTask(db, 'B', { column: 'recurring' })
    const result = bulkMoveAll(db, 'recurring', 'in-progress')
    expect(result.moved).toBe(2)
    expect(listTasks(db, { column: 'in-progress' })).toHaveLength(2)
    expect(listTasks(db, { column: 'recurring' })).toHaveLength(0)
  })

  test('bulkClearDone removes tasks in done column', () => {
    addTask(db, 'Finished', { column: 'done' })
    addTask(db, 'Also done', { column: 'done' })
    addTask(db, 'Still going', { column: 'recurring' })
    const result = bulkClearDone(db)
    expect(result.deleted).toBe(2)
    expect(listTasks(db)).toHaveLength(1)
  })
})

describe('resetBoard', () => {
  test('clears all data and re-seeds', () => {
    addTask(db, 'Gone soon')
    resetBoard(db)
    expect(listColumns(db)).toHaveLength(5)
    expect(listTasks(db)).toHaveLength(0)
  })
})
