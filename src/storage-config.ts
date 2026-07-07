import { getDbPath } from './db'

interface SqliteKanbanStorageConfig {
  mode: 'sqlite'
  sqlitePath: string
}

interface PostgresKanbanStorageConfig {
  mode: 'postgres'
  databaseUrl: string
}

export type KanbanStorageConfig = SqliteKanbanStorageConfig | PostgresKanbanStorageConfig

export interface ResolveKanbanStorageOptions {
  defaultSqlitePath?: string
}

export function resolveKanbanStorageConfig(
  env: Record<string, string | undefined> = process.env,
  options: ResolveKanbanStorageOptions = {},
): KanbanStorageConfig {
  const rawMode = (env['KANBAN_STORAGE'] ?? 'sqlite').trim().toLowerCase()
  if (rawMode !== 'sqlite' && rawMode !== 'postgres') {
    throw new Error(
      "Unsupported KANBAN_STORAGE '" + rawMode + "'. Expected 'sqlite' or 'postgres'.",
    )
  }

  if (rawMode === 'postgres') {
    const databaseUrl = env['KANBAN_DATABASE_URL']?.trim()
    if (!databaseUrl) {
      throw new Error('KANBAN_DATABASE_URL is required when KANBAN_STORAGE=postgres')
    }
    return { mode: 'postgres', databaseUrl }
  }

  return { mode: 'sqlite', sqlitePath: options.defaultSqlitePath ?? getDbPath() }
}
