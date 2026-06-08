import type { Database } from 'bun:sqlite'
import type { BoardView, ProviderTeamInfo, Task } from '../types'
import type { JiraClient } from './jira-client'
import {
  adjustJiraIssueCommentCount,
  deleteJiraIssue,
  getCachedActivity,
  getCachedBoard,
  getCachedColumns,
  getCachedConfig,
  getCachedTask,
  getCachedTasks,
  initJiraCacheSchema,
  loadJiraSyncMeta,
  loadTeamInfo,
  pruneJiraIssuesMissingUpstream,
  replaceJiraColumns,
  replaceJiraIssueTypes,
  replaceJiraPriorities,
  saveJiraActivity,
  saveJiraSyncMeta,
  saveTeamInfo,
  upsertJiraIssues,
  upsertJiraUsers,
  type JiraActivityRow,
  type JiraCacheConfig,
  type JiraColumnRow,
  type JiraSyncMeta,
} from './jira-cache'
import { JiraProviderCore, type JiraCachePort, type JiraProviderConfig } from './jira-core'

export type { JiraProviderConfig } from './jira-core'

/**
 * SQLite implementation of the JiraCachePort. Wraps the synchronous bun:sqlite
 * free functions in jira-cache.ts as awaitable methods so the shared
 * JiraProviderCore can drive both SQLite and Postgres uniformly.
 */
class SqliteJiraCache implements JiraCachePort {
  readonly ready = Promise.resolve()

  constructor(private readonly db: Database) {}

  async loadSyncMeta(): Promise<JiraSyncMeta> {
    return loadJiraSyncMeta(this.db)
  }

  async saveSyncMeta(meta: Partial<JiraSyncMeta>): Promise<void> {
    saveJiraSyncMeta(this.db, meta)
  }

  async loadTeamInfo(): Promise<ProviderTeamInfo | null> {
    return loadTeamInfo(this.db)
  }

  async saveTeamInfo(team: ProviderTeamInfo | null): Promise<void> {
    saveTeamInfo(this.db, team)
  }

  async replaceColumns(
    columns: Array<{
      id: string
      name: string
      position: number
      statusIds: string[]
      source: 'board' | 'status'
    }>,
    prune: boolean,
  ): Promise<void> {
    replaceJiraColumns(this.db, columns, prune)
  }

  async upsertUsers(
    users: Array<{ accountId: string; displayName: string; active?: boolean }>,
  ): Promise<void> {
    upsertJiraUsers(this.db, users)
  }

  async replacePriorities(
    priorities: Array<{ id: string; name: string }>,
    prune: boolean,
  ): Promise<void> {
    replaceJiraPriorities(this.db, priorities, prune)
  }

  async replaceIssueTypes(
    types: Array<{ id: string; name: string }>,
    prune: boolean,
  ): Promise<void> {
    replaceJiraIssueTypes(this.db, types, prune)
  }

  async upsertIssues(issues: Parameters<JiraCachePort['upsertIssues']>[0]): Promise<void> {
    upsertJiraIssues(this.db, issues)
  }

  async deleteIssue(idOrKey: string): Promise<void> {
    deleteJiraIssue(this.db, idOrKey)
  }

  async pruneIssuesMissingUpstream(projectKey: string, upstreamIssueIds: string[]): Promise<void> {
    pruneJiraIssuesMissingUpstream(this.db, projectKey, upstreamIssueIds)
  }

  async adjustIssueCommentCount(idOrKey: string, delta: number): Promise<void> {
    adjustJiraIssueCommentCount(this.db, idOrKey, delta)
  }

  async saveActivity(rows: JiraActivityRow[]): Promise<void> {
    saveJiraActivity(this.db, rows)
  }

  async getCachedActivity(params?: {
    issueId?: string
    limit?: number
  }): Promise<JiraActivityRow[]> {
    return getCachedActivity(this.db, params)
  }

  async getColumns(): Promise<JiraColumnRow[]> {
    return getCachedColumns(this.db)
  }

  async getCachedBoard(): Promise<BoardView> {
    return getCachedBoard(this.db)
  }

  async getCachedTask(lookup: string): Promise<Task | null> {
    return getCachedTask(this.db, lookup)
  }

  async getCachedTasks(params?: { columnId?: string }): Promise<Task[]> {
    return getCachedTasks(this.db, params)
  }

  async getCachedConfig(): Promise<JiraCacheConfig> {
    return getCachedConfig(this.db)
  }

  async getDiscoveredAssignees(): Promise<string[]> {
    return (
      this.db
        .query("SELECT DISTINCT assignee_name FROM jira_issues WHERE assignee_name != ''")
        .all() as { assignee_name: string }[]
    )
      .map((r) => r.assignee_name)
      .sort()
  }

  async findPriorityName(wanted: string): Promise<string | null> {
    const row = this.db
      .query('SELECT name FROM jira_priorities WHERE LOWER(name) = LOWER($name) LIMIT 1')
      .get({ $name: wanted }) as { name: string } | null
    return row?.name ?? null
  }

  async getPriorityNames(): Promise<string[]> {
    return (
      this.db.query('SELECT name FROM jira_priorities ORDER BY name').all() as { name: string }[]
    ).map((r) => r.name)
  }

  async findActiveAssigneeAccountId(displayName: string): Promise<string | null> {
    const row = this.db
      .query(
        'SELECT account_id FROM jira_users WHERE active = 1 AND LOWER(display_name) = LOWER($name) LIMIT 1',
      )
      .get({ $name: displayName }) as { account_id: string } | null
    return row?.account_id ?? null
  }

  async findIssueTypeId(name: string): Promise<string | null> {
    const row = this.db
      .query('SELECT id FROM jira_issue_types WHERE LOWER(name) = LOWER($name) LIMIT 1')
      .get({ $name: name }) as { id: string } | null
    return row?.id ?? null
  }

  async getIssueTypeNames(): Promise<string[]> {
    return (
      this.db.query('SELECT name FROM jira_issue_types ORDER BY name').all() as { name: string }[]
    ).map((r) => r.name)
  }

  async resolveIssueId(lookup: string): Promise<string | null> {
    const normalized = lookup.startsWith('jira:') ? lookup.slice('jira:'.length) : lookup
    const row = this.db
      .query<
        { id: string },
        Record<string, string>
      >('SELECT id FROM jira_issues WHERE id = $lookup OR key = $lookup LIMIT 1')
      .get({ $lookup: normalized })
    return row?.id ?? null
  }
}

export class JiraProvider extends JiraProviderCore {
  constructor(db: Database, config: JiraProviderConfig, client?: JiraClient) {
    initJiraCacheSchema(db)
    super(new SqliteJiraCache(db), config, client)
  }
}
