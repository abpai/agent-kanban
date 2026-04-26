import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ErrorCode, KanbanError } from '../errors'
import { run } from '../index'
import { createProvider } from '../providers/index'

const ENV_KEYS = [
  'KANBAN_PROVIDER',
  'JIRA_BASE_URL',
  'JIRA_EMAIL',
  'JIRA_API_TOKEN',
  'JIRA_PROJECT_KEY',
  'JIRA_BOARD_ID',
  'JIRA_ISSUE_TYPE',
  'LINEAR_API_KEY',
  'LINEAR_TEAM_ID',
] as const

const tempRoot = mkdtempSync(join(tmpdir(), 'jira-wiring-'))
const dbs: Database[] = []

function makeDb(): { db: Database; dbPath: string } {
  const dir = mkdtempSync(join(tempRoot, 'case-'))
  const dbPath = join(dir, 'board.db')
  const db = new Database(dbPath)
  dbs.push(db)
  return { db, dbPath }
}

function setJiraRequiredEnv(): void {
  process.env['KANBAN_PROVIDER'] = 'jira'
  process.env['JIRA_BASE_URL'] = 'https://example.atlassian.net'
  process.env['JIRA_EMAIL'] = 'a@example.com'
  process.env['JIRA_API_TOKEN'] = 'tok-test'
  process.env['JIRA_PROJECT_KEY'] = 'ENG'
}

describe('jira-wiring', () => {
  let snapshot: Record<string, string | undefined>

  beforeEach(() => {
    snapshot = {}
    for (const key of ENV_KEYS) {
      snapshot[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const prev = snapshot[key]
      if (prev === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = prev
      }
    }
  })

  afterAll(() => {
    for (const db of dbs) {
      try {
        db.close()
      } catch {
        // ignore
      }
    }
    try {
      rmSync(tempRoot, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  test('createProvider throws PROVIDER_NOT_CONFIGURED listing missing JIRA_API_TOKEN', () => {
    const { db, dbPath } = makeDb()
    process.env['KANBAN_PROVIDER'] = 'jira'
    process.env['JIRA_BASE_URL'] = 'https://example.atlassian.net'
    process.env['JIRA_EMAIL'] = 'a@example.com'
    delete process.env['JIRA_API_TOKEN']
    process.env['JIRA_PROJECT_KEY'] = 'ENG'

    expect(() => createProvider(db, dbPath)).toThrow(KanbanError)
    try {
      createProvider(db, dbPath)
    } catch (err) {
      expect((err as KanbanError).code).toBe(ErrorCode.PROVIDER_NOT_CONFIGURED)
      expect((err as Error).message).toContain('JIRA_API_TOKEN')
      expect((err as Error).message).toContain('KANBAN_PROVIDER=jira')
    }
  })

  test('createProvider throws PROVIDER_NOT_CONFIGURED listing multiple missing vars', () => {
    const { db, dbPath } = makeDb()
    process.env['KANBAN_PROVIDER'] = 'jira'
    process.env['JIRA_BASE_URL'] = 'https://example.atlassian.net'
    delete process.env['JIRA_EMAIL']
    delete process.env['JIRA_API_TOKEN']
    process.env['JIRA_PROJECT_KEY'] = 'ENG'

    let msg = ''
    let code: string | undefined
    try {
      createProvider(db, dbPath)
    } catch (err) {
      msg = (err as Error).message
      code = (err as KanbanError).code
    }
    expect(code).toBe(ErrorCode.PROVIDER_NOT_CONFIGURED)
    expect(msg).toContain('JIRA_EMAIL')
    expect(msg).toContain('JIRA_API_TOKEN')
    expect(msg).toContain('are required')
    expect(msg).toContain('KANBAN_PROVIDER=jira')
  })

  test('createProvider builds JiraProvider when all four required vars are set', () => {
    const { db, dbPath } = makeDb()
    setJiraRequiredEnv()
    const provider = createProvider(db, dbPath)
    expect(provider.type).toBe('jira')
  })

  test('JIRA_BOARD_ID non-numeric falls back to undefined', () => {
    const { db, dbPath } = makeDb()
    setJiraRequiredEnv()
    process.env['JIRA_BOARD_ID'] = 'notanumber'
    const provider = createProvider(db, dbPath)
    expect(provider.type).toBe('jira')
  })

  test('kanban column add under KANBAN_PROVIDER=jira exits with UNSUPPORTED_OPERATION', async () => {
    const { dbPath } = makeDb()
    setJiraRequiredEnv()
    const result = await run(['--db', dbPath, 'column', 'add', 'NewColumn']).catch(
      (err: unknown) => ({ error: err as KanbanError }),
    )
    expect('error' in result).toBe(true)
    const err = (result as { error: KanbanError }).error
    expect(err).toBeInstanceOf(KanbanError)
    expect(err.code).toBe(ErrorCode.UNSUPPORTED_OPERATION)
    expect(err.message).toContain('Column commands')
  })

  test('kanban bulk move-all under KANBAN_PROVIDER=jira exits with UNSUPPORTED_OPERATION', async () => {
    const { dbPath } = makeDb()
    setJiraRequiredEnv()
    const result = await run(['--db', dbPath, 'bulk', 'move-all', 'a', 'b']).catch(
      (err: unknown) => ({ error: err as KanbanError }),
    )
    expect('error' in result).toBe(true)
    const err = (result as { error: KanbanError }).error
    expect(err).toBeInstanceOf(KanbanError)
    expect(err.code).toBe(ErrorCode.UNSUPPORTED_OPERATION)
    expect(err.message).toContain('Bulk commands')
  })

  test('kanban config set-member under KANBAN_PROVIDER=jira exits with UNSUPPORTED_OPERATION', async () => {
    const { dbPath } = makeDb()
    setJiraRequiredEnv()
    const result = await run([
      '--db',
      dbPath,
      'config',
      'set-member',
      'alice',
      '--role',
      'human',
    ]).catch((err: unknown) => ({ error: err as KanbanError }))
    expect('error' in result).toBe(true)
    const err = (result as { error: KanbanError }).error
    expect(err).toBeInstanceOf(KanbanError)
    expect(err.code).toBe(ErrorCode.UNSUPPORTED_OPERATION)
    expect(err.message).toContain('Config mutation')
  })

  test('KANBAN_PROVIDER=linear still builds LinearProvider (regression guard)', () => {
    const { db, dbPath } = makeDb()
    process.env['KANBAN_PROVIDER'] = 'linear'
    process.env['LINEAR_API_KEY'] = 'lin_api_test'
    process.env['LINEAR_TEAM_ID'] = 'team-test'
    const provider = createProvider(db, dbPath)
    expect(provider.type).toBe('linear')
  })
})
