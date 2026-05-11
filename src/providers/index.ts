import type { Database } from 'bun:sqlite'
import { getDbPath, initSchema, seedDefaultColumns } from '../db'
import { JiraProvider } from './jira'
import { LinearProvider } from './linear'
import { LocalProvider } from './local'
import type { TrackerConfig } from '../tracker-config'
import type { KanbanProvider } from './types'

export function createProvider(
  db: Database,
  config: TrackerConfig,
  dbPath = getDbPath(),
): KanbanProvider {
  if (config.provider === 'linear') {
    return new LinearProvider(db, config.teamId, config.apiKey, config.syncIntervalMs)
  }

  if (config.provider === 'jira') {
    return new JiraProvider(db, {
      baseUrl: config.baseUrl,
      email: config.email,
      apiToken: config.apiToken,
      projectKey: config.projectKey,
      ...(config.boardId !== undefined ? { boardId: config.boardId } : {}),
      defaultIssueType: config.defaultIssueType ?? 'Task',
      pollingSyncIntervalMs: config.syncIntervalMs,
    })
  }

  initSchema(db)
  seedDefaultColumns(db)
  return new LocalProvider(db, dbPath)
}
