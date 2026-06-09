import type { ActivityEntry, BoardMetrics } from './types'
import {
  type ClassifiableColumn,
  selectDoneColumnIds,
  selectInProgressColumnIds,
} from './column-roles'

// One source of truth for how raw board aggregates become BoardMetrics. The
// SQLite (metrics.ts) and Postgres (postgres-local.ts) backends each gather the
// primitive rows with their own dialect, then feed them through this assembler
// so the derived fields — done/in-progress classification, completion math, and
// priority ordering — can never drift between backends.

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 }

/** A column plus how many tasks currently sit in it. */
export interface MetricsColumnCount extends ClassifiableColumn {
  count: number
}

export interface MetricsInputs {
  /** Every column with its live task count, in display (position) order. */
  columnCounts: MetricsColumnCount[]
  /** Raw per-priority counts; ordering is normalized here. */
  priorityCounts: Array<{ priority: string; count: number }>
  totalTasks: number
  tasksCreatedThisWeek: number
  /** Average creation→Done hours, or null when no Done column / no completions. */
  avgCompletionHours: number | null
  recentActivity: ActivityEntry[]
  assignees: string[]
  projects: string[]
}

/**
 * Classify a board's columns into done / in-progress roles. Backends call this
 * to scope their average-completion SQL (which needs the done column ids before
 * querying column_time_tracking); assembleBoardMetrics() reclassifies from the
 * same column set so the two never disagree.
 */
export function classifyColumnRoles(columns: ClassifiableColumn[]): {
  doneColumnIds: string[]
  inProgressColumnIds: string[]
} {
  return {
    doneColumnIds: selectDoneColumnIds(columns),
    inProgressColumnIds: selectInProgressColumnIds(columns),
  }
}

export function assembleBoardMetrics(inputs: MetricsInputs): BoardMetrics {
  const { doneColumnIds, inProgressColumnIds } = classifyColumnRoles(inputs.columnCounts)
  const done = new Set(doneColumnIds)
  const inProgress = new Set(inProgressColumnIds)

  const tasksByColumn = inputs.columnCounts.map((column) => ({
    column_name: column.name,
    count: column.count,
  }))
  const completedTasks = inputs.columnCounts
    .filter((column) => done.has(column.id))
    .reduce((sum, column) => sum + column.count, 0)
  const inProgressCount = inputs.columnCounts
    .filter((column) => inProgress.has(column.id))
    .reduce((sum, column) => sum + column.count, 0)

  const tasksByPriority = [...inputs.priorityCounts].sort(
    (a, b) => (PRIORITY_RANK[a.priority] ?? 99) - (PRIORITY_RANK[b.priority] ?? 99),
  )

  const completionPercent =
    inputs.totalTasks > 0 ? Math.round((completedTasks / inputs.totalTasks) * 100) : 0

  return {
    tasksByColumn,
    tasksByPriority,
    totalTasks: inputs.totalTasks,
    completedTasks,
    avgCompletionHours: inputs.avgCompletionHours,
    recentActivity: inputs.recentActivity,
    tasksCreatedThisWeek: inputs.tasksCreatedThisWeek,
    inProgressCount,
    completionPercent,
    assignees: inputs.assignees,
    projects: inputs.projects,
  }
}
