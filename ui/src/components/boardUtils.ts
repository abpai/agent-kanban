import type { BoardView, Task } from '../types'

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

export function findTask(board: BoardView, id: string): { task: Task; columnId: string } | null {
  for (const column of board.columns) {
    const task = column.tasks.find((t) => t.id === id)
    if (task) return { task, columnId: column.id }
  }
  return null
}

export function patchTask(board: BoardView, id: string, patch: Partial<Task>): BoardView {
  return {
    columns: board.columns.map((column) => ({
      ...column,
      tasks: column.tasks.map((task) => (task.id === id ? { ...task, ...patch } : task)),
    })),
  }
}

export function replaceTask(board: BoardView, oldId: string, next: Task): BoardView {
  return {
    columns: board.columns.map((column) => ({
      ...column,
      tasks: column.tasks.map((task) => (task.id === oldId ? next : task)),
    })),
  }
}

export function moveTaskInBoard(board: BoardView, id: string, toColumnName: string): BoardView {
  const target = board.columns.find((c) => c.name.toLowerCase() === toColumnName.toLowerCase())
  if (!target) return board
  let moving: Task | null = null
  const stripped = board.columns.map((column) => {
    const idx = column.tasks.findIndex((t) => t.id === id)
    if (idx === -1) return column
    moving = column.tasks[idx]!
    return { ...column, tasks: column.tasks.filter((t) => t.id !== id) }
  })
  if (!moving) return board
  return {
    columns: stripped.map((column) =>
      column.id === target.id ? { ...column, tasks: [...column.tasks, moving!] } : column,
    ),
  }
}

export function insertTask(board: BoardView, task: Task, columnName: string): BoardView {
  const targetIdx = board.columns.findIndex(
    (c) => c.name.toLowerCase() === columnName.toLowerCase(),
  )
  if (targetIdx === -1) return board
  return {
    columns: board.columns.map((column, i) =>
      i === targetIdx ? { ...column, tasks: [...column.tasks, task] } : column,
    ),
  }
}

export function removeTaskById(board: BoardView, id: string): BoardView {
  return {
    columns: board.columns.map((column) => ({
      ...column,
      tasks: column.tasks.filter((t) => t.id !== id),
    })),
  }
}

export function upsertTaskInColumn(board: BoardView, task: Task, columnName: string): BoardView {
  const withoutTask = removeTaskById(board, task.id)
  return insertTask(withoutTask, task, columnName)
}

export function makeTempId(): string {
  return `tmp_${Math.random().toString(36).slice(2, 10)}`
}
