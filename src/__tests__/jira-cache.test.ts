import { beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  decodeColumnStatusIds,
  getCachedBoard,
  getCachedColumns,
  getCachedConfig,
  getCachedTask,
  getCachedTasks,
  initJiraCacheSchema,
  loadJiraSyncMeta,
  replaceJiraColumns,
  replaceJiraIssueTypes,
  replaceJiraPriorities,
  saveJiraSyncMeta,
  upsertJiraIssues,
  upsertJiraUsers,
} from '../providers/jira-cache.ts'

let db: Database

beforeEach(() => {
  db = new Database(':memory:')
  initJiraCacheSchema(db)
})

describe('jira-cache', () => {
  test('initJiraCacheSchema is idempotent', () => {
    saveJiraSyncMeta(db, { projectKey: 'SENTINEL' })
    expect(() => initJiraCacheSchema(db)).not.toThrow()
    expect(loadJiraSyncMeta(db).projectKey).toBe('SENTINEL')
  })

  test('sync meta round-trips each key', () => {
    saveJiraSyncMeta(db, {
      projectKey: 'ENG',
      boardId: 42,
      lastSyncAt: '2026-01-01T00:00:00Z',
      lastIssueUpdatedAt: '2026-01-02T00:00:00Z',
    })
    const loaded = loadJiraSyncMeta(db)
    expect(loaded.projectKey).toBe('ENG')
    expect(loaded.boardId).toBe(42)
    expect(loaded.lastSyncAt).toBe('2026-01-01T00:00:00Z')
    expect(loaded.lastIssueUpdatedAt).toBe('2026-01-02T00:00:00Z')
  })

  test('replaceJiraColumns preserves status_ids ordering and source', () => {
    replaceJiraColumns(db, [
      {
        id: 'board:1:To Do',
        name: 'To Do',
        position: 0,
        statusIds: ['10001', '10002', '10003'],
        source: 'board',
      },
    ])
    const columns = getCachedColumns(db)
    expect(columns).toHaveLength(1)
    const col = columns[0]!
    expect(col.source).toBe('board')
    expect(decodeColumnStatusIds(col)).toEqual(['10001', '10002', '10003'])
  })

  test('decodeColumnStatusIds handles 3-element array without ordering loss', () => {
    expect(decodeColumnStatusIds({ status_ids: JSON.stringify(['c', 'a', 'b']) })).toEqual([
      'c',
      'a',
      'b',
    ])
  })

  test('upsertJiraUsers round-trip and active filter', () => {
    upsertJiraUsers(db, [
      { accountId: 'a1', displayName: 'Alice', active: true },
      { accountId: 'a2', displayName: 'Bob', active: true },
      { accountId: 'a3', displayName: 'Zara', active: false },
    ])
    const { users } = getCachedConfig(db)
    expect(users).toHaveLength(2)
    expect(users.map((u) => u.displayName).sort()).toEqual(['Alice', 'Bob'])
    expect(users.every((u) => typeof u.accountId === 'string')).toBe(true)
  })

  test('upsertJiraIssues round-trip with full Task shape', () => {
    upsertJiraIssues(db, [
      {
        id: '10001',
        key: 'ENG-1',
        summary: 'Fix login',
        descriptionText: 'hello world',
        statusId: '30',
        priorityName: 'High',
        issueTypeName: 'Bug',
        assigneeAccountId: 'a1',
        assigneeName: 'Alice',
        projectKey: 'ENG',
        url: 'https://jira/browse/ENG-1',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      },
    ])
    const viaKey = getCachedTask(db, 'ENG-1')
    expect(viaKey).not.toBeNull()
    expect(viaKey).toMatchObject({
      id: 'jira:10001',
      providerId: '10001',
      externalRef: 'ENG-1',
      title: 'Fix login',
      description: 'hello world',
      column_id: '30',
      position: 0,
      priority: 'high',
      assignee: 'Alice',
      project: 'ENG',
      url: 'https://jira/browse/ENG-1',
      metadata: '{}',
    })
    expect(getCachedTask(db, 'jira:10001')).not.toBeNull()
    expect(getCachedTask(db, '10001')).not.toBeNull()
  })

  test('getCachedBoard groups issues by many-to-one column-to-status mapping', () => {
    replaceJiraColumns(db, [
      {
        id: 'board:1:In Progress',
        name: 'In Progress',
        position: 0,
        statusIds: ['10001', '10002'],
        source: 'board',
      },
    ])
    upsertJiraIssues(db, [
      {
        id: '1',
        key: 'ENG-1',
        summary: 'a',
        descriptionText: '',
        statusId: '10001',
        projectKey: 'ENG',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-03T00:00:00Z',
      },
      {
        id: '2',
        key: 'ENG-2',
        summary: 'b',
        descriptionText: '',
        statusId: '10002',
        projectKey: 'ENG',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      },
      {
        id: '3',
        key: 'ENG-3',
        summary: 'c',
        descriptionText: '',
        statusId: '99999',
        projectKey: 'ENG',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ])
    const board = getCachedBoard(db)
    expect(board.columns).toHaveLength(1)
    const col = board.columns[0]!
    expect(col.tasks).toHaveLength(2)
    const refs = new Set(col.tasks.map((t) => t.externalRef))
    expect(refs).toEqual(new Set(['ENG-1', 'ENG-2']))
  })

  test('getCachedTasks({ columnId }) filters to the column status_ids', () => {
    const columnId = 'board:1:In Progress'
    replaceJiraColumns(db, [
      {
        id: columnId,
        name: 'In Progress',
        position: 0,
        statusIds: ['10001', '10002'],
        source: 'board',
      },
    ])
    upsertJiraIssues(db, [
      {
        id: '1',
        key: 'ENG-1',
        summary: 'a',
        descriptionText: '',
        statusId: '10001',
        projectKey: 'ENG',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-03T00:00:00Z',
      },
      {
        id: '2',
        key: 'ENG-2',
        summary: 'b',
        descriptionText: '',
        statusId: '10002',
        projectKey: 'ENG',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      },
      {
        id: '3',
        key: 'ENG-3',
        summary: 'c',
        descriptionText: '',
        statusId: '99999',
        projectKey: 'ENG',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ])
    expect(getCachedTasks(db, { columnId })).toHaveLength(2)
    expect(getCachedTasks(db)).toHaveLength(3)
  })

  test('priority name mapping is case-insensitive with urgent/high/medium/low fallback', () => {
    const samples: Array<{ key: string; priority: string; expected: string }> = [
      { key: 'ENG-1', priority: 'Highest', expected: 'urgent' },
      { key: 'ENG-2', priority: 'high', expected: 'high' },
      { key: 'ENG-3', priority: 'MEDIUM', expected: 'medium' },
      { key: 'ENG-4', priority: 'weird', expected: 'low' },
      { key: 'ENG-5', priority: '', expected: 'low' },
    ]
    upsertJiraIssues(
      db,
      samples.map((s, i) => ({
        id: String(1000 + i),
        key: s.key,
        summary: s.key,
        descriptionText: '',
        statusId: '10',
        priorityName: s.priority,
        projectKey: 'ENG',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: `2026-01-0${i + 1}T00:00:00Z`,
      })),
    )
    for (const s of samples) {
      const task = getCachedTask(db, s.key)
      expect(task).not.toBeNull()
      expect(task?.priority as string).toBe(s.expected)
    }
  })

  test('saveJiraSyncMeta partial does not clobber prior values; omit=preserve, null=clear', () => {
    saveJiraSyncMeta(db, { projectKey: 'ENG', boardId: 42 })
    saveJiraSyncMeta(db, { lastSyncAt: '2026-01-01T00:00:00Z' })
    let loaded = loadJiraSyncMeta(db)
    expect(loaded.projectKey).toBe('ENG')
    expect(loaded.boardId).toBe(42)
    expect(loaded.lastSyncAt).toBe('2026-01-01T00:00:00Z')

    saveJiraSyncMeta(db, { projectKey: null })
    loaded = loadJiraSyncMeta(db)
    expect(loaded.projectKey).toBeNull()
    expect(loaded.boardId).toBe(42)
    expect(loaded.lastSyncAt).toBe('2026-01-01T00:00:00Z')
  })

  test('getCachedConfig returns internal shape, not BoardConfig', () => {
    upsertJiraUsers(db, [{ accountId: 'a1', displayName: 'Alice' }])
    replaceJiraPriorities(db, [{ id: '1', name: 'High' }])
    replaceJiraIssueTypes(db, [{ id: '10000', name: 'Bug' }])
    saveJiraSyncMeta(db, { projectKey: 'ENG' })
    const config = getCachedConfig(db)
    expect(config.projectKey).toBe('ENG')
    expect(Array.isArray(config.users)).toBe(true)
    expect(config.users.length).toBeGreaterThan(0)
    expect(config.users[0]).toEqual({ accountId: 'a1', displayName: 'Alice' })
    expect(config.priorities.length).toBeGreaterThan(0)
    expect(config.issueTypes.length).toBeGreaterThan(0)
    const keys = Object.keys(config)
    expect(keys).not.toContain('members')
    expect(keys).not.toContain('discoveredAssignees')
    expect(keys).not.toContain('discoveredProjects')
    expect(keys).not.toContain('provider')
  })

  test('empty status_ids array short-circuits with no SQL error', () => {
    const columnId = 'board:1:Empty'
    replaceJiraColumns(db, [
      { id: columnId, name: 'Empty', position: 0, statusIds: [], source: 'board' },
    ])
    upsertJiraIssues(db, [
      {
        id: '1',
        key: 'ENG-1',
        summary: 'a',
        descriptionText: '',
        statusId: '10001',
        projectKey: 'ENG',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-03T00:00:00Z',
      },
    ])
    const board = getCachedBoard(db)
    expect(board.columns[0]!.tasks).toEqual([])
    expect(getCachedTasks(db, { columnId })).toEqual([])
  })
})
