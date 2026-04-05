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
  filterAssignee: string,
  filterProject: string,
): Task[] {
  return tasks.filter((task) => {
    if (filterAssignee && task.assignee !== filterAssignee) return false
    if (filterProject && task.project !== filterProject) return false
    return true
  })
}

export function getColumnColor(name: string): string {
  return COLUMN_COLORS[name.toLowerCase()] ?? 'var(--text-secondary)'
}
