import type { Database } from 'bun:sqlite'
import type { BoardConfig, BoardView, Task } from '../types'
import {
  adjustLinearIssueCommentCount,
  deleteLinearIssue,
  getCachedBoard,
  getCachedColumns,
  getCachedConfig,
  getCachedLinearActivity,
  getCachedTask,
  getCachedTasks,
  initLinearCacheSchema,
  loadSyncMeta,
  pruneLinearIssues,
  replaceStates,
  saveLinearActivity,
  saveSyncMeta,
  upsertIssues,
  upsertProjects,
  upsertUsers,
  type LinearActivityRow,
  type LinearStateRow,
  type LinearSyncMeta,
} from './linear-cache'
import { LinearClient } from './linear-client'
import { LinearProviderCore, type LinearCachePort } from './linear-core'
import { DEFAULT_POLLING_SYNC_INTERVAL_MS } from '../sync-config'

/**
 * SQLite implementation of the LinearCachePort. Wraps the synchronous
 * bun:sqlite free functions in linear-cache.ts as awaitable methods so the
 * shared LinearProviderCore can drive both SQLite and Postgres uniformly.
 */
class SqliteLinearCache implements LinearCachePort {
  readonly ready = Promise.resolve()

  constructor(private readonly db: Database) {}

  async loadSyncMeta(): Promise<LinearSyncMeta> {
    return loadSyncMeta(this.db)
  }

  async saveSyncMeta(meta: Partial<LinearSyncMeta>): Promise<void> {
    saveSyncMeta(this.db, meta)
  }

  async replaceStates(states: Parameters<LinearCachePort['replaceStates']>[0]): Promise<void> {
    replaceStates(this.db, states)
  }

  async upsertUsers(users: Parameters<LinearCachePort['upsertUsers']>[0]): Promise<void> {
    upsertUsers(this.db, users)
  }

  async upsertProjects(projects: Parameters<LinearCachePort['upsertProjects']>[0]): Promise<void> {
    upsertProjects(this.db, projects)
  }

  async upsertIssues(issues: Parameters<LinearCachePort['upsertIssues']>[0]): Promise<void> {
    upsertIssues(this.db, issues)
  }

  async deleteIssue(idOrIdentifier: string): Promise<void> {
    deleteLinearIssue(this.db, idOrIdentifier)
  }

  async pruneIssues(liveIssueIds: string[]): Promise<void> {
    pruneLinearIssues(this.db, liveIssueIds)
  }

  async adjustIssueCommentCount(idOrIdentifier: string, delta: number): Promise<void> {
    adjustLinearIssueCommentCount(this.db, idOrIdentifier, delta)
  }

  async saveActivity(rows: LinearActivityRow[]): Promise<void> {
    saveLinearActivity(this.db, rows)
  }

  async getCachedActivity(params?: {
    issueId?: string
    limit?: number
  }): Promise<LinearActivityRow[]> {
    return getCachedLinearActivity(this.db, params)
  }

  async getCachedColumns(): Promise<LinearStateRow[]> {
    return getCachedColumns(this.db)
  }

  async getCachedBoard(): Promise<BoardView> {
    return getCachedBoard(this.db)
  }

  async getCachedTask(lookup: string): Promise<Task | null> {
    return getCachedTask(this.db, lookup)
  }

  async getCachedTasks(): Promise<Task[]> {
    return getCachedTasks(this.db)
  }

  async getCachedConfig(): Promise<BoardConfig> {
    return getCachedConfig(this.db)
  }

  async findUserIdByName(name: string): Promise<string | null> {
    const row = this.db
      .query('SELECT id FROM linear_users WHERE LOWER(name) = LOWER($name) LIMIT 1')
      .get({ $name: name }) as { id: string } | null
    return row?.id ?? null
  }

  async findProjectIdByName(name: string): Promise<string | null> {
    const row = this.db
      .query('SELECT id FROM linear_projects WHERE LOWER(name) = LOWER($name) LIMIT 1')
      .get({ $name: name }) as { id: string } | null
    return row?.id ?? null
  }

  async resolveIssueId(lookup: string): Promise<string | null> {
    const normalized = lookup.startsWith('linear:') ? lookup.slice('linear:'.length) : lookup
    const row = this.db
      .query<
        { id: string },
        Record<string, string>
      >('SELECT id FROM linear_issues WHERE id = $lookup OR identifier = $lookup LIMIT 1')
      .get({ $lookup: normalized })
    return row?.id ?? null
  }
}

export class LinearProvider extends LinearProviderCore {
  constructor(
    db: Database,
    teamId: string,
    apiKey: string,
    pollingSyncIntervalMs = DEFAULT_POLLING_SYNC_INTERVAL_MS,
  ) {
    initLinearCacheSchema(db)
    super(new SqliteLinearCache(db), teamId, new LinearClient(apiKey), pollingSyncIntervalMs)
  }
}
