import type { Database } from 'bun:sqlite'
import { getDbPath, initSchema, seedDefaultColumns } from '../db.ts'
import { providerNotConfigured } from './errors.ts'
import { JiraProvider } from './jira.ts'
import { LinearProvider } from './linear.ts'
import { LocalProvider } from './local.ts'
import type { KanbanProvider } from './types.ts'

export function createProvider(db: Database, dbPath = getDbPath()): KanbanProvider {
  const providerType = (process.env['KANBAN_PROVIDER'] ?? 'local') as 'local' | 'linear' | 'jira'

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
    return new JiraProvider(db, {
      baseUrl: baseUrl!,
      email: email!,
      apiToken: apiToken!,
      projectKey: projectKey!,
      boardId: Number.isFinite(boardId) ? boardId : undefined,
      defaultIssueType,
    })
  }

  initSchema(db)
  seedDefaultColumns(db)
  return new LocalProvider(db, dbPath)
}
