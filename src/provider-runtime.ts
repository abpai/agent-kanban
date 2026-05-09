import { Database } from 'bun:sqlite'
import postgres from 'postgres'

import { getDbPath, migrateSchema, openDb } from './db'
import { providerNotConfigured, unsupportedOperation } from './providers/errors'
import { createProvider } from './providers/index'
import { PostgresJiraProvider } from './providers/postgres-jira'
import { PostgresLinearProvider } from './providers/postgres-linear'
import { PostgresLocalProvider } from './providers/postgres-local'
import type { KanbanProvider } from './providers/types'
import { resolveKanbanStorageConfig } from './storage-config'
import { resolvePollingSyncIntervalMs } from './sync-config'

export interface KanbanRuntime {
  provider: KanbanProvider
  dbPath: string
  sqliteDb?: Database
  close(): Promise<void>
}

export async function openKanbanRuntime(opts: { dbPath?: string } = {}): Promise<KanbanRuntime> {
  const dbPath = opts.dbPath ?? getDbPath()
  const storage = resolveKanbanStorageConfig(process.env, { defaultSqlitePath: dbPath })

  if (storage.mode === 'postgres') {
    const providerType = (process.env['KANBAN_PROVIDER'] ?? 'local').trim().toLowerCase()
    const sql = postgres(storage.databaseUrl, { max: 5, onnotice: () => {} })
    if (providerType === 'local') {
      const provider = new PostgresLocalProvider(sql)
      await provider.initialize()
      return {
        provider,
        dbPath,
        async close() {
          await sql.end({ timeout: 1 })
        },
      }
    }
    if (providerType === 'jira') {
      const baseUrl = process.env['JIRA_BASE_URL']
      const email = process.env['JIRA_EMAIL']
      const apiToken = process.env['JIRA_API_TOKEN']
      const projectKey = process.env['JIRA_PROJECT_KEY']
      const missing: string[] = []
      if (!baseUrl) missing.push('JIRA_BASE_URL')
      if (!email) missing.push('JIRA_EMAIL')
      if (!apiToken) missing.push('JIRA_API_TOKEN')
      if (!projectKey) missing.push('JIRA_PROJECT_KEY')
      if (missing.length > 0) {
        providerNotConfigured(
          `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required when KANBAN_PROVIDER=jira`,
        )
      }
      const boardIdRaw = process.env['JIRA_BOARD_ID']
      const boardId = boardIdRaw ? Number.parseInt(boardIdRaw, 10) : undefined
      const defaultIssueType = process.env['JIRA_ISSUE_TYPE'] ?? 'Task'
      const provider = new PostgresJiraProvider(sql, {
        baseUrl: baseUrl!,
        email: email!,
        apiToken: apiToken!,
        projectKey: projectKey!,
        boardId: Number.isFinite(boardId) ? boardId : undefined,
        defaultIssueType,
        pollingSyncIntervalMs: resolvePollingSyncIntervalMs(),
      })
      await provider.initialize()
      return {
        provider,
        dbPath,
        async close() {
          await sql.end({ timeout: 1 })
        },
      }
    }
    if (providerType === 'linear') {
      const apiKey = process.env['LINEAR_API_KEY']
      const teamId = process.env['LINEAR_TEAM_ID']
      const missing: string[] = []
      if (!apiKey) missing.push('LINEAR_API_KEY')
      if (!teamId) missing.push('LINEAR_TEAM_ID')
      if (missing.length > 0) {
        providerNotConfigured(
          `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required when KANBAN_PROVIDER=linear`,
        )
      }
      const provider = new PostgresLinearProvider(
        sql,
        teamId!,
        apiKey!,
        resolvePollingSyncIntervalMs(),
      )
      await provider.initialize()
      return {
        provider,
        dbPath,
        async close() {
          await sql.end({ timeout: 1 })
        },
      }
    }
    try {
      unsupportedOperation(
        `KANBAN_STORAGE=postgres currently supports KANBAN_PROVIDER=local, linear, or jira in agent-kanban. ${providerType} support is the next storage slice.`,
      )
    } catch (err) {
      await sql.end({ timeout: 1 })
      throw err
    }
  }

  const db = openDb(storage.sqlitePath)
  migrateSchema(db)
  return {
    provider: createProvider(db, storage.sqlitePath),
    dbPath: storage.sqlitePath,
    sqliteDb: db,
    async close() {
      db.close()
    },
  }
}
