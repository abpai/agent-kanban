import type { Database } from 'bun:sqlite'
import type { Sql } from 'postgres'

import { initSchema, seedDefaultColumns } from '../db'
import type { ProviderCapabilities } from '../types'
import type { TrackerConfig } from '../tracker-config'
import {
  JIRA_CAPABILITIES,
  LINEAR_CAPABILITIES,
  LOCAL_CAPABILITIES,
  POSTGRES_LOCAL_CAPABILITIES,
} from './capabilities'
import { JiraProvider, type JiraProviderConfig } from './jira'
import { LinearProvider } from './linear'
import { LocalProvider } from './local'
import { PostgresJiraProvider } from './postgres-jira'
import { PostgresLinearProvider } from './postgres-linear'
import { PostgresLocalProvider } from './postgres-local'
import type { KanbanProvider } from './types'

export interface InitializableKanbanProvider extends KanbanProvider {
  initialize(): Promise<void>
}

export interface ProviderBundle<TProvider extends KanbanProvider = KanbanProvider> {
  provider: TProvider
  capabilities: ProviderCapabilities
}

export interface SqliteProviderOptions {
  dbPath: string
  seedLocalColumns?: boolean
}

function jiraProviderConfig(
  config: Extract<TrackerConfig, { provider: 'jira' }>,
): JiraProviderConfig {
  return {
    baseUrl: config.baseUrl,
    email: config.email,
    apiToken: config.apiToken,
    projectKey: config.projectKey,
    ...(config.boardId !== undefined ? { boardId: config.boardId } : {}),
    defaultIssueType: config.defaultIssueType ?? 'Task',
    pollingSyncIntervalMs: config.syncIntervalMs,
  }
}

export function createSqliteProvider(
  db: Database,
  config: TrackerConfig,
  options: SqliteProviderOptions,
): ProviderBundle {
  switch (config.provider) {
    case 'linear':
      return {
        provider: new LinearProvider(db, config.teamId, config.apiKey, config.syncIntervalMs),
        capabilities: LINEAR_CAPABILITIES,
      }
    case 'jira':
      return {
        provider: new JiraProvider(db, jiraProviderConfig(config)),
        capabilities: JIRA_CAPABILITIES,
      }
    case 'local':
      initSchema(db)
      if (options.seedLocalColumns !== false) {
        seedDefaultColumns(db, config.defaultColumns)
      }
      return {
        provider: new LocalProvider(db, options.dbPath, config.defaultTaskColumn),
        capabilities: LOCAL_CAPABILITIES,
      }
  }
}

export function createPostgresProvider(
  sql: Sql,
  config: TrackerConfig,
): ProviderBundle<InitializableKanbanProvider> {
  switch (config.provider) {
    case 'linear':
      return {
        provider: new PostgresLinearProvider(
          sql,
          config.teamId,
          config.apiKey,
          config.syncIntervalMs,
        ),
        capabilities: LINEAR_CAPABILITIES,
      }
    case 'jira':
      return {
        provider: new PostgresJiraProvider(sql, jiraProviderConfig(config)),
        capabilities: JIRA_CAPABILITIES,
      }
    case 'local':
      return {
        provider: new PostgresLocalProvider(sql, config),
        capabilities: POSTGRES_LOCAL_CAPABILITIES,
      }
  }
}
