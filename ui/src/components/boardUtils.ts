import type { Task } from '../types'

export const COLUMN_COLORS: Record<string, string> = {
  recurring: 'var(--col-recurring)',
  backlog: 'var(--col-backlog)',
  'in-progress': 'var(--col-in-progress)',
  review: 'var(--col-review)',
  done: 'var(--col-done)',
}

export function filterVisibleTasks(
  tasks: Task[],
  filterAssignee: string | null,
  filterProject: string | null,
  filterActivityDays: number | null = null,
): Task[] {
  return tasks.filter((task) => {
    if (filterAssignee && task.assignee !== filterAssignee) return false
    if (filterProject && task.project !== filterProject) return false
    if (filterActivityDays !== null) {
      const updatedAtMs = Date.parse(task.updated_at)
      if (!Number.isNaN(updatedAtMs)) {
        const cutoffMs = Date.now() - filterActivityDays * 24 * 60 * 60 * 1000
        if (updatedAtMs < cutoffMs) return false
      }
    }
    return true
  })
}

export function getColumnColor(name: string): string {
  return COLUMN_COLORS[name.toLowerCase()] ?? 'var(--text-secondary)'
}
