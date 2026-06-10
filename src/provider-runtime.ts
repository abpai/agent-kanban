import { Database } from 'bun:sqlite'
import postgres from 'postgres'

import { getDbPath, migrateSchema, openDb } from './db'
import { createPostgresProvider, createSqliteProvider } from './providers/factory'
import type { KanbanProvider } from './providers/types'
import type { ProviderCapabilities } from './types'
import { resolveKanbanStorageConfig } from './storage-config'
import type { KanbanStorageConfig } from './storage-config'
import { trackerConfigFromEnv, type TrackerConfig } from './tracker-config'

export interface KanbanRuntime {
  provider: KanbanProvider
  capabilities: ProviderCapabilities
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
    try {
      const { provider, capabilities } = createPostgresProvider(sql, trackerConfig)
      await provider.initialize()
      return {
        provider,
        capabilities,
        dbPath,
        trackerConfig,
        syncIntervalMs: trackerConfig.syncIntervalMs,
        async close() {
          await sql.end({ timeout: 1 })
        },
      }
    } catch (err) {
      await sql.end({ timeout: 1 })
      throw err
    }
  }

  const db = openDb(storage.sqlitePath)
  migrateSchema(db)
  const { provider, capabilities } = createSqliteProvider(db, trackerConfig, {
    dbPath: storage.sqlitePath,
    seedLocalColumns: opts.seedLocalColumns,
  })
  return {
    provider,
    capabilities,
    dbPath: storage.sqlitePath,
    trackerConfig,
    sqliteDb: db,
    syncIntervalMs: trackerConfig.syncIntervalMs,
    async close() {
      db.close()
    },
  }
}
