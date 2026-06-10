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
  resolveJiraColumnId,
  saveJiraSyncMeta,
  upsertJiraIssues,
  upsertJiraUsers,
} from '../providers/jira-cache'
import type { JiraColumnRow } from '../providers/jira-cache'

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

  test('catalog replace prune=false upserts without deleting obsolete rows', () => {
    // Seed a full catalog (prune defaults to true → full replace).
    replaceJiraColumns(db, [
      { id: 'status:1', name: 'To Do', position: 0, statusIds: ['1'], source: 'status' },
      { id: 'status:2', name: 'Done', position: 1, statusIds: ['2'], source: 'status' },
    ])
    replaceJiraPriorities(db, [
      { id: 'p1', name: 'High' },
      { id: 'p2', name: 'Low' },
    ])
    replaceJiraIssueTypes(db, [
      { id: 't1', name: 'Bug' },
      { id: 't2', name: 'Task' },
    ])

    // A delta sync (prune=false) carries a partial snapshot: it should upsert the
    // rows it sees and leave the others in place (self-healing), not delete them.
    replaceJiraColumns(
      db,
      [
        {
          id: 'status:1',
          name: 'To Do (renamed)',
          position: 0,
          statusIds: ['1'],
          source: 'status',
        },
      ],
      false,
    )
    replaceJiraPriorities(db, [{ id: 'p1', name: 'Highest' }], false)
    replaceJiraIssueTypes(db, [{ id: 't1', name: 'Defect' }], false)

    const columns = getCachedColumns(db)
    expect(columns.map((c) => c.id).sort()).toEqual(['status:1', 'status:2'])
    expect(columns.find((c) => c.id === 'status:1')?.name).toBe('To Do (renamed)')

    const { priorities, issueTypes } = getCachedConfig(db)
    expect(priorities.map((p) => p.id).sort()).toEqual(['p1', 'p2'])
    expect(priorities.find((p) => p.id === 'p1')?.name).toBe('Highest')
    expect(issueTypes.map((t) => t.id).sort()).toEqual(['t1', 't2'])
    expect(issueTypes.find((t) => t.id === 't1')?.name).toBe('Defect')
  })

  test('catalog replace prune=true (default) removes obsolete rows', () => {
    replaceJiraColumns(db, [
      { id: 'status:1', name: 'To Do', position: 0, statusIds: ['1'], source: 'status' },
      { id: 'status:2', name: 'Done', position: 1, statusIds: ['2'], source: 'status' },
    ])
    // A full reconcile (prune=true) replaces the catalog: status:2 is gone.
    replaceJiraColumns(db, [
      { id: 'status:1', name: 'To Do', position: 0, statusIds: ['1'], source: 'status' },
    ])
    expect(getCachedColumns(db).map((c) => c.id)).toEqual(['status:1'])
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

describe('resolveJiraColumnId', () => {
  const col = (id: string, name: string, statusIds: string[] = []): JiraColumnRow => ({
    id,
    name,
    position: 0,
    status_ids: JSON.stringify(statusIds),
    source: 'status',
  })

  test('matches by exact id first', () => {
    const columns = [col('status:12136', 'To Do'), col('status:12137', 'In Progress')]
    expect(resolveJiraColumnId(columns, 'status:12137')).toBe('status:12137')
  })

  test('matches by case-insensitive name', () => {
    const columns = [col('status:12136', 'To Do')]
    expect(resolveJiraColumnId(columns, 'to do')).toBe('status:12136')
  })

  test("resolves a separator-collapsed trigger string ('Todo') to the 'To Do' status column", () => {
    const columns = [col('status:12136', 'To Do'), col('status:12137', 'In Progress')]
    expect(resolveJiraColumnId(columns, 'Todo')).toBe('status:12136')
    expect(resolveJiraColumnId(columns, 'ToDo')).toBe('status:12136')
    expect(resolveJiraColumnId(columns, 'In-Progress')).toBe('status:12137')
  })

  test('exact case-insensitive name wins over a separator-insensitive collision', () => {
    // 'To Do' and 'Todo' both normalize to 'todo'; an exact lowercase hit must
    // not be derailed into the ambiguity branch.
    const columns = [col('status:1', 'To Do'), col('status:2', 'Todo')]
    expect(resolveJiraColumnId(columns, 'todo')).toBe('status:2')
  })

  test('rejects a separator-insensitive match that collapses two distinct columns', () => {
    const columns = [col('status:1', 'To Do'), col('status:2', 'To-Do')]
    expect(() => resolveJiraColumnId(columns, 'Todo')).toThrow(/ambiguous/)
  })

  test('falls back to raw status id containment', () => {
    const columns = [col('board:1:Backlog', 'Backlog', ['10001', '10002'])]
    expect(resolveJiraColumnId(columns, '10002')).toBe('board:1:Backlog')
  })

  test('raw status id wins over a column whose name normalizes to that id', () => {
    // A numeric status-id reference must resolve by containment, not be hijacked
    // by a column whose name only matches after the fuzzy normalized pass
    // ('1-0-0-0-3' → '10003').
    const columns = [
      col('status:1', '1-0-0-0-3', ['99999']),
      col('board:1:Backlog', 'Backlog', ['10003']),
    ]
    expect(resolveJiraColumnId(columns, '10003')).toBe('board:1:Backlog')
  })

  test('empty / separator-only input does not match a separator-only column name', () => {
    const columns = [col('status:1', '---'), col('status:2', 'To Do')]
    expect(() => resolveJiraColumnId(columns, '   ')).toThrow(/No Jira column matching/)
    expect(() => resolveJiraColumnId(columns, '!!!')).toThrow(/No Jira column matching/)
  })

  test('throws COLUMN_NOT_FOUND when nothing matches', () => {
    const columns = [col('status:12136', 'To Do')]
    expect(() => resolveJiraColumnId(columns, 'Done')).toThrow(/No Jira column matching/)
  })
})
