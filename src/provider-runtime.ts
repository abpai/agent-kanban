import { Database } from 'bun:sqlite'
import postgres from 'postgres'

import { getDbPath, migrateSchema, openDb } from './db'
import { unsupportedOperation } from './providers/errors'
import { createProvider } from './providers/index'
import { PostgresJiraProvider } from './providers/postgres-jira'
import { PostgresLinearProvider } from './providers/postgres-linear'
import { PostgresLocalProvider } from './providers/postgres-local'
import type { KanbanProvider } from './providers/types'
import { resolveKanbanStorageConfig } from './storage-config'
import type { KanbanStorageConfig } from './storage-config'
import { trackerConfigFromEnv, type TrackerConfig } from './tracker-config'

export interface KanbanRuntime {
  provider: KanbanProvider
  dbPath: string
  trackerConfig: TrackerConfig
  sqliteDb?: Database
  syncIntervalMs?: number
  close(): Promise<void>
}

export async function openKanbanRuntime(
  opts: {
    dbPath?: string
    storage?: KanbanStorageConfig
    tracker?: TrackerConfig
    seedLocalColumns?: boolean
  } = {},
): Promise<KanbanRuntime> {
  const dbPath = opts.dbPath ?? getDbPath()
  const storage =
    opts.storage ?? resolveKanbanStorageConfig(process.env, { defaultSqlitePath: dbPath })
  const trackerConfig = opts.tracker ?? trackerConfigFromEnv(process.env)

  if (storage.mode === 'postgres') {
    const sql = postgres(storage.databaseUrl, { max: 5, onnotice: () => {} })
    if (trackerConfig.provider === 'local') {
      const provider = new PostgresLocalProvider(sql, trackerConfig)
      await provider.initialize()
      return {
        provider,
        dbPath,
        trackerConfig,
        syncIntervalMs: trackerConfig.syncIntervalMs,
        async close() {
          await sql.end({ timeout: 1 })
        },
      }
    }
    if (trackerConfig.provider === 'jira') {
      const provider = new PostgresJiraProvider(sql, {
        baseUrl: trackerConfig.baseUrl,
        email: trackerConfig.email,
        apiToken: trackerConfig.apiToken,
        projectKey: trackerConfig.projectKey,
        ...(trackerConfig.boardId !== undefined ? { boardId: trackerConfig.boardId } : {}),
        defaultIssueType: trackerConfig.defaultIssueType ?? 'Task',
        pollingSyncIntervalMs: trackerConfig.syncIntervalMs,
      })
      await provider.initialize()
      return {
        provider,
        dbPath,
        trackerConfig,
        syncIntervalMs: trackerConfig.syncIntervalMs,
        async close() {
          await sql.end({ timeout: 1 })
        },
      }
    }
    if (trackerConfig.provider === 'linear') {
      const provider = new PostgresLinearProvider(
        sql,
        trackerConfig.teamId,
        trackerConfig.apiKey,
        trackerConfig.syncIntervalMs,
      )
      await provider.initialize()
      return {
        provider,
        dbPath,
        trackerConfig,
        syncIntervalMs: trackerConfig.syncIntervalMs,
        async close() {
          await sql.end({ timeout: 1 })
        },
      }
    }
    try {
      const _exhaustive: never = trackerConfig
      unsupportedOperation(
        `KANBAN_STORAGE=postgres currently supports KANBAN_PROVIDER=local, linear, or jira in agent-kanban.`,
      )
      void _exhaustive
    } catch (err) {
      await sql.end({ timeout: 1 })
      throw err
    }
  }

  const db = openDb(storage.sqlitePath)
  migrateSchema(db)
  return {
    provider: createProvider(db, trackerConfig, storage.sqlitePath, {
      seedLocalColumns: opts.seedLocalColumns,
    }),
    dbPath: storage.sqlitePath,
    trackerConfig,
    sqliteDb: db,
    syncIntervalMs: trackerConfig.syncIntervalMs,
    async close() {
      db.close()
    },
  }
}
