import { ErrorCode, KanbanError } from './errors'
import { providerNotConfigured } from './providers/errors'
import { resolvePollingSyncIntervalMs } from './sync-config'

export type TrackerProvider = 'local' | 'linear' | 'jira'

/**
 * Single source of truth for which env var holds each provider's webhook signing
 * secret (`null` = the provider has no webhook ingestion). Typed as
 * `Record<TrackerProvider, …>`, so adding a new provider to the union is a
 * compile error here until its secret env is declared — preventing a new
 * webhook-capable provider from silently slipping past the tunnel-security gate
 * (assertTunnelSecurity) with no secret enforced.
 */
export const WEBHOOK_SECRET_ENV: Record<TrackerProvider, string | null> = {
  local: null,
  linear: 'LINEAR_WEBHOOK_SECRET',
  jira: 'JIRA_WEBHOOK_SECRET',
}

/**
 * Normalize the raw `KANBAN_PROVIDER` env value to a known `TrackerProvider`,
 * falling back to `'local'` for anything unset/unrecognized — matching how
 * trackerConfigFromEnv resolves the provider. Centralized so the security gate
 * and the config loader agree on a single derivation.
 */
export function trackerProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
): TrackerProvider {
  const raw = (env['KANBAN_PROVIDER'] ?? 'local').trim().toLowerCase()
  // Recognize exactly the providers declared in WEBHOOK_SECRET_ENV — own keys
  // only, so inherited names like "constructor"/"toString" don't match — and
  // fall back to local otherwise. Deriving from the map keeps this normalizer in
  // lockstep with it, so a newly-added provider is picked up here automatically.
  return Object.prototype.hasOwnProperty.call(WEBHOOK_SECRET_ENV, raw)
    ? (raw as TrackerProvider)
    : 'local'
}

export interface LocalTrackerConfig {
  provider: 'local'
  defaultColumns?: string[]
  defaultTaskColumn?: string
  syncIntervalMs?: number
}

export interface LinearTrackerConfig {
  provider: 'linear'
  apiKey: string
  teamId: string
  syncIntervalMs?: number
}

export interface JiraTrackerConfig {
  provider: 'jira'
  baseUrl: string
  email: string
  apiToken: string
  projectKey: string
  boardId?: number
  defaultIssueType?: string
  syncIntervalMs?: number
}

export type TrackerConfig = LocalTrackerConfig | LinearTrackerConfig | JiraTrackerConfig

export function trackerConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): TrackerConfig {
  const provider = trackerProviderFromEnv(env)

  if (provider === 'linear') {
    const apiKey = env['LINEAR_API_KEY']
    const teamId = env['LINEAR_TEAM_ID']
    const missing: string[] = []
    if (!apiKey) missing.push('LINEAR_API_KEY')
    if (!teamId) missing.push('LINEAR_TEAM_ID')
    if (missing.length > 0) {
      providerNotConfigured(
        `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required when KANBAN_PROVIDER=linear`,
      )
    }
    return {
      provider,
      apiKey: apiKey!,
      teamId: teamId!,
      syncIntervalMs: resolvePollingSyncIntervalMs(env['KANBAN_SYNC_INTERVAL_MS']),
    }
  }

  if (provider === 'jira') {
    const baseUrl = env['JIRA_BASE_URL']
    const email = env['JIRA_EMAIL']
    const apiToken = env['JIRA_API_TOKEN']
    const projectKey = env['JIRA_PROJECT_KEY']
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
    const boardIdRaw = env['JIRA_BOARD_ID']
    const boardId = boardIdRaw ? Number.parseInt(boardIdRaw, 10) : undefined
    return {
      provider,
      baseUrl: baseUrl!,
      email: email!,
      apiToken: apiToken!,
      projectKey: projectKey!,
      ...(Number.isFinite(boardId) ? { boardId } : {}),
      defaultIssueType: env['JIRA_ISSUE_TYPE'] ?? 'Task',
      syncIntervalMs: resolvePollingSyncIntervalMs(env['KANBAN_SYNC_INTERVAL_MS']),
    }
  }

  const defaultColumns = defaultColumnsFromEnv(env)
  return {
    provider: 'local',
    ...(defaultColumns ? { defaultColumns } : {}),
    ...(env['KANBAN_DEFAULT_TASK_COLUMN']?.trim()
      ? { defaultTaskColumn: env['KANBAN_DEFAULT_TASK_COLUMN']!.trim() }
      : {}),
  }
}

function defaultColumnsFromEnv(env: Record<string, string | undefined>): string[] | undefined {
  const raw = env['KANBAN_DEFAULT_COLUMNS']?.trim()
  if (!raw) return undefined
  const columns = raw
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  if (columns.length === 0) return undefined
  // Column resolution is case-insensitive (LOWER(name)), and interactive column
  // creation rejects case-insensitive duplicates. Reject them here too so the
  // config path can't seed an ambiguous board state the interactive path forbids.
  const seen = new Set<string>()
  for (const name of columns) {
    const key = name.toLowerCase()
    if (seen.has(key)) {
      throw new KanbanError(
        ErrorCode.INVALID_CONFIG,
        `KANBAN_DEFAULT_COLUMNS contains a duplicate column name (case-insensitive): '${name}'`,
      )
    }
    seen.add(key)
  }
  return columns
}
