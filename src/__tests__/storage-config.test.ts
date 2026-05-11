import { describe, expect, test } from 'bun:test'

import { resolveKanbanStorageConfig } from '../storage-config'

describe('resolveKanbanStorageConfig', () => {
  test('defaults to sqlite using the resolved board path', () => {
    const config = resolveKanbanStorageConfig(
      { HOME: '/tmp/kanban-home' },
      { defaultSqlitePath: '/tmp/board.db' },
    )

    expect(config).toEqual({ mode: 'sqlite', sqlitePath: '/tmp/board.db' })
  })

  test('accepts uppercase postgres mode and requires a database URL', () => {
    expect(() =>
      resolveKanbanStorageConfig({ KANBAN_STORAGE: 'POSTGRES' }, { defaultSqlitePath: 'ignored' }),
    ).toThrow('KANBAN_DATABASE_URL is required when KANBAN_STORAGE=postgres')

    expect(
      resolveKanbanStorageConfig(
        {
          KANBAN_STORAGE: 'POSTGRES',
          KANBAN_DATABASE_URL: 'postgres://garage:garage@localhost:5432/garage',
        },
        { defaultSqlitePath: 'ignored' },
      ),
    ).toEqual({
      mode: 'postgres',
      databaseUrl: 'postgres://garage:garage@localhost:5432/garage',
    })
  })

  test('rejects unknown storage modes', () => {
    expect(() =>
      resolveKanbanStorageConfig({ KANBAN_STORAGE: 'mysql' }, { defaultSqlitePath: 'ignored' }),
    ).toThrow("Unsupported KANBAN_STORAGE 'mysql'")
  })
})
