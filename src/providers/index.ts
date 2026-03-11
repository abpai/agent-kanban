import type { Database } from 'bun:sqlite'
import { getDbPath, initSchema, seedDefaultColumns } from '../db.ts'
import { providerNotConfigured } from './errors.ts'
import { LinearProvider } from './linear.ts'
import { LocalProvider } from './local.ts'
import type { KanbanProvider } from './types.ts'

export function createProvider(db: Database, dbPath = getDbPath()): KanbanProvider {
  const providerType = (process.env['KANBAN_PROVIDER'] ?? 'local') as 'local' | 'linear'
  if (providerType === 'linear') {
    const apiKey = process.env['LINEAR_API_KEY']
    const teamId = process.env['LINEAR_TEAM_ID']
    if (!apiKey || !teamId) {
      providerNotConfigured(
        'LINEAR_API_KEY and LINEAR_TEAM_ID are required when KANBAN_PROVIDER=linear',
      )
    }
    return new LinearProvider(db, teamId!, apiKey!)
  }

  initSchema(db)
  seedDefaultColumns(db)
  return new LocalProvider(db, dbPath)
}
