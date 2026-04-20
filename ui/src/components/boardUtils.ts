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

function insertAtIndex<T>(items: T[], index: number, item: T): T[] {
  return [...items.slice(0, index), item, ...items.slice(index)]
}

function hasMeaningfulPositions(tasks: Task[], task: Task): boolean {
  const positions = new Set(tasks.map((candidate) => candidate.position))
  positions.add(task.position)
  return positions.size > 1
}

function insertTaskWithOrder(tasks: Task[], task: Task, fallbackIndex?: number): Task[] {
  if (!hasMeaningfulPositions(tasks, task)) {
    if (fallbackIndex !== undefined) {
      const boundedIndex = Math.max(0, Math.min(fallbackIndex, tasks.length))
      return insertAtIndex(tasks, boundedIndex, task)
    }
    return [...tasks, task]
  }

  const insertIndex = tasks.findIndex((candidate) => candidate.position > task.position)
  if (insertIndex === -1) return [...tasks, task]
  return insertAtIndex(tasks, insertIndex, task)
}

export function replaceTask(board: BoardView, oldId: string, next: Task): BoardView {
  let fallbackColumnIdx: number | undefined
  let fallbackTaskIdx: number | undefined

  const strippedColumns = board.columns.map((column, columnIdx) => {
    const tasks = column.tasks.filter((task, taskIdx) => {
      const shouldStrip = task.id === oldId || task.id === next.id
      if (!shouldStrip) return true
      if (fallbackColumnIdx === undefined || task.id === oldId) {
        fallbackColumnIdx = columnIdx
        fallbackTaskIdx = taskIdx
      }
      return false
    })
    return tasks.length === column.tasks.length ? column : { ...column, tasks }
  })

  const targetColumnIdx = strippedColumns.findIndex((column) => column.id === next.column_id)
  const resolvedColumnIdx = targetColumnIdx !== -1 ? targetColumnIdx : (fallbackColumnIdx ?? -1)
  if (resolvedColumnIdx === -1) return board

  const fallbackIndex = resolvedColumnIdx === fallbackColumnIdx ? fallbackTaskIdx : undefined
  return {
    columns: strippedColumns.map((column, columnIdx) =>
      columnIdx === resolvedColumnIdx
        ? { ...column, tasks: insertTaskWithOrder(column.tasks, next, fallbackIndex) }
        : column,
    ),
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
  const targetIdx = board.columns.findIndex(
    (c) => c.name.toLowerCase() === columnName.toLowerCase(),
  )
  if (targetIdx === -1) return board

  let fallbackColumnIdx: number | undefined
  let fallbackTaskIdx: number | undefined
  const strippedColumns = board.columns.map((column, columnIdx) => {
    const existingIdx = column.tasks.findIndex((candidate) => candidate.id === task.id)
    if (existingIdx === -1) return column
    fallbackColumnIdx = columnIdx
    fallbackTaskIdx = existingIdx
    return { ...column, tasks: column.tasks.filter((candidate) => candidate.id !== task.id) }
  })

  const fallbackIndex = fallbackColumnIdx === targetIdx ? fallbackTaskIdx : undefined
  return {
    columns: strippedColumns.map((column, columnIdx) =>
      columnIdx === targetIdx
        ? { ...column, tasks: insertTaskWithOrder(column.tasks, task, fallbackIndex) }
        : column,
    ),
  }
}

export function makeTempId(): string {
  return `tmp_${Math.random().toString(36).slice(2, 10)}`
}
