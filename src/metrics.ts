import { Database } from 'bun:sqlite'
import type { ActivityEntry, BoardMetrics } from './types.ts'

export function getDiscoveredAssignees(db: Database): string[] {
  return (
    db
      .query("SELECT DISTINCT assignee FROM tasks WHERE assignee != '' ORDER BY assignee")
      .all() as { assignee: string }[]
  ).map((r) => r.assignee)
}

export function getDiscoveredProjects(db: Database): string[] {
  return (
    db.query("SELECT DISTINCT project FROM tasks WHERE project != '' ORDER BY project").all() as {
      project: string
    }[]
  ).map((r) => r.project)
}

export function getBoardMetrics(db: Database): BoardMetrics {
  const tasksByColumn = db
    .query(
      `SELECT c.name as column_name, COUNT(t.id) as count
       FROM columns c LEFT JOIN tasks t ON t.column_id = c.id
       GROUP BY c.id ORDER BY c.position`,
    )
    .all() as { column_name: string; count: number }[]

  const tasksByPriority = db
    .query(
      `SELECT priority, COUNT(*) as count FROM tasks
       GROUP BY priority ORDER BY CASE priority
         WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
         WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END`,
    )
    .all() as { priority: string; count: number }[]

  const totalTasks = (db.query('SELECT COUNT(*) as count FROM tasks').get() as { count: number })
    .count

  const completedTasks = (
    db
      .query(
        `SELECT COUNT(*) as count FROM tasks t
         JOIN columns c ON t.column_id = c.id WHERE LOWER(c.name) = 'done'`,
      )
      .get() as { count: number }
  ).count

  const avgResult = db
    .query(
      `SELECT AVG(
        (julianday(ct.exited_at) - julianday(first_enter.entered_at)) * 24
       ) as avg_hours
       FROM column_time_tracking ct
       JOIN columns c ON ct.column_id = c.id
       JOIN (
         SELECT task_id, MIN(entered_at) as entered_at
         FROM column_time_tracking GROUP BY task_id
       ) first_enter ON first_enter.task_id = ct.task_id
       WHERE LOWER(c.name) = 'done' AND ct.exited_at IS NOT NULL`,
    )
    .get() as { avg_hours: number | null }

  const recentActivity = db
    .query('SELECT * FROM activity_log ORDER BY timestamp DESC, rowid DESC LIMIT 20')
    .all() as ActivityEntry[]

  const tasksCreatedThisWeek = (
    db
      .query("SELECT COUNT(*) as count FROM tasks WHERE created_at >= datetime('now', '-7 days')")
      .get() as { count: number }
  ).count

  const inProgressCount = (
    db
      .query(
        `SELECT COUNT(*) as count FROM tasks t
         JOIN columns c ON t.column_id = c.id WHERE LOWER(c.name) = 'in-progress'`,
      )
      .get() as { count: number }
  ).count

  const completionPercent = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0

  const assignees = getDiscoveredAssignees(db)
  const projects = getDiscoveredProjects(db)

  return {
    tasksByColumn,
    tasksByPriority,
    totalTasks,
    completedTasks,
    avgCompletionHours: avgResult.avg_hours,
    recentActivity,
    tasksCreatedThisWeek,
    inProgressCount,
    completionPercent,
    assignees,
    projects,
  }
}
