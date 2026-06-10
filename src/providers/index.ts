import type { Database } from 'bun:sqlite'
import { getDbPath } from '../db'
import type { TrackerConfig } from '../tracker-config'
import type { KanbanProvider } from './types'
import { createSqliteProvider } from './factory'

export function createProvider(
  db: Database,
  config: TrackerConfig,
  dbPath = getDbPath(),
  options: { seedLocalColumns?: boolean } = {},
): KanbanProvider {
  return createSqliteProvider(db, config, { dbPath, seedLocalColumns: options.seedLocalColumns })
    .provider
}
