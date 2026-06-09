import { Database } from 'bun:sqlite'
import type { ActivityEntry, BoardMetrics } from './types'
import { assembleBoardMetrics, classifyColumnRoles } from './metrics-spec'

function getDistinctTaskFieldValues(db: Database, field: 'assignee' | 'project'): string[] {
  return (
    db
      .query(`SELECT DISTINCT ${field} as value FROM tasks WHERE ${field} != '' ORDER BY ${field}`)
      .all() as { value: string }[]
  ).map((row) => row.value)
}

function getCount(db: Database, sql: string): number {
  return (db.query(sql).get() as { count: number }).count
}

export function getDiscoveredAssignees(db: Database): string[] {
  return getDistinctTaskFieldValues(db, 'assignee')
}

export function getDiscoveredProjects(db: Database): string[] {
  return getDistinctTaskFieldValues(db, 'project')
}

export function getBoardMetrics(db: Database): BoardMetrics {
  const columnCounts = (
    db
      .query(
        `SELECT c.id as id, c.name as name, c.position as position, COUNT(t.id) as count
         FROM columns c LEFT JOIN tasks t ON t.column_id = c.id
         GROUP BY c.id ORDER BY c.position`,
      )
      .all() as { id: string; name: string; position: number; count: number }[]
  ).map((row) => ({ id: row.id, name: row.name, position: row.position, count: row.count }))

  // Done/in-progress classification and all derived fields live in metrics-spec;
  // here we only gather the raw aggregates this backend's SQL produces. The done
  // ids are needed up front to scope the average-completion query.
  const { doneColumnIds } = classifyColumnRoles(columnCounts)

  const priorityCounts = db
    .query(`SELECT priority, COUNT(*) as count FROM tasks GROUP BY priority`)
    .all() as { priority: string; count: number }[]

  const totalTasks = getCount(db, 'SELECT COUNT(*) as count FROM tasks')

  // Average completion time = first time a task was tracked (creation) until the
  // first time it entered a Done column. Measuring the Done *entry* (not exit)
  // means tasks that reach Done and stay there are counted; MIN() over Done rows
  // handles tasks that re-enter Done.
  const donePlaceholders = doneColumnIds.map(() => '?').join(', ')
  const avgResult =
    doneColumnIds.length === 0
      ? { avg_hours: null }
      : (db
          .query(
            `SELECT AVG(
        (julianday(done_enter.entered_at) - julianday(first_enter.entered_at)) * 24
       ) as avg_hours
       FROM (
         SELECT ct.task_id, MIN(ct.entered_at) as entered_at
         FROM column_time_tracking ct
         WHERE ct.column_id IN (${donePlaceholders})
         GROUP BY ct.task_id
       ) done_enter
       JOIN (
         SELECT task_id, MIN(entered_at) as entered_at
         FROM column_time_tracking GROUP BY task_id
       ) first_enter ON first_enter.task_id = done_enter.task_id`,
          )
          .get(...doneColumnIds) as { avg_hours: number | null })

  const recentActivity = db
    .query('SELECT * FROM activity_log ORDER BY timestamp DESC, rowid DESC LIMIT 20')
    .all() as ActivityEntry[]

  const tasksCreatedThisWeek = getCount(
    db,
    "SELECT COUNT(*) as count FROM tasks WHERE created_at >= datetime('now', '-7 days')",
  )

  return assembleBoardMetrics({
    columnCounts,
    priorityCounts,
    totalTasks,
    tasksCreatedThisWeek,
    avgCompletionHours: avgResult.avg_hours,
    recentActivity,
    assignees: getDiscoveredAssignees(db),
    projects: getDiscoveredProjects(db),
  })
}
