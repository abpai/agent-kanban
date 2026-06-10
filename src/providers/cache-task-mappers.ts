import type { Task } from '../types'

export interface JiraTaskRow {
  id: string
  key: string
  summary: string
  description_text: string
  status_id: string
  priority_name: string
  issue_type_name: string
  assignee_account_id: string | null
  assignee_name: string
  labels: string
  comment_count: number
  project_key: string
  url: string | null
  created_at: string
  updated_at: string
}

export interface LinearTaskRow {
  id: string
  identifier: string
  title: string
  description: string
  state_id: string
  state_position: number
  priority: number
  assignee_name: string
  project_name: string
  labels: string
  comment_count: number
  url: string | null
  created_at: string
  updated_at: string
}

function parseTaskLabels(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : []
  } catch {
    return []
  }
}

function mapJiraPriorityNameToCanonical(name: string): Task['priority'] {
  switch (name.trim().toLowerCase()) {
    case 'highest':
      return 'urgent'
    case 'high':
      return 'high'
    case 'medium':
      return 'medium'
    default:
      return 'low'
  }
}

function mapLinearPriority(priority: number): Task['priority'] {
  switch (priority) {
    case 1:
      return 'urgent'
    case 2:
      return 'high'
    case 3:
      return 'medium'
    case 0:
    case 4:
    default:
      return 'low'
  }
}

export function jiraTaskFromRow(row: JiraTaskRow): Task {
  return {
    id: `jira:${row.id}`,
    providerId: row.id,
    externalRef: row.key,
    url: row.url,
    title: row.summary,
    description: row.description_text,
    column_id: row.status_id,
    position: 0,
    priority: mapJiraPriorityNameToCanonical(row.priority_name),
    assignee: row.assignee_name,
    assignees: row.assignee_name ? [row.assignee_name] : [],
    labels: parseTaskLabels(row.labels),
    comment_count: row.comment_count,
    project: row.project_key,
    metadata: '{}',
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: row.updated_at,
    source_updated_at: row.updated_at,
  }
}

export function linearTaskFromRow(row: LinearTaskRow): Task {
  return {
    id: `linear:${row.id}`,
    providerId: row.id,
    externalRef: row.identifier,
    url: row.url,
    title: row.title,
    description: row.description,
    column_id: row.state_id,
    position: row.state_position,
    priority: mapLinearPriority(row.priority),
    assignee: row.assignee_name,
    assignees: row.assignee_name ? [row.assignee_name] : [],
    labels: parseTaskLabels(row.labels),
    comment_count: row.comment_count,
    project: row.project_name,
    metadata: '{}',
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: row.updated_at,
    source_updated_at: row.updated_at,
  }
}
