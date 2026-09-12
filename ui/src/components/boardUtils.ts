import { selectDoneColumnIds, selectInProgressColumnIds } from '../../../src/column-roles'
import type { BoardMetrics, BoardView, Task } from '../types'

const COLUMN_COLORS = new Map([
  ['recurring', 'var(--col-recurring)'],
  ['backlog', 'var(--col-backlog)'],
  ['in-progress', 'var(--col-in-progress)'],
  ['review', 'var(--col-review)'],
  ['done', 'var(--col-done)'],
])

export function filterVisibleTasks(
  tasks: Task[],
  filterAssignee: string | null,
  filterProject: string | null,
  filterActivityDays: number | null = null,
  searchQuery = '',
): Task[] {
  const query = searchQuery.trim().toLowerCase()
  if (!filterAssignee && !filterProject && filterActivityDays === null && !query) return tasks
  const cutoffMs = filterActivityDays === null ? null : Date.now() - filterActivityDays * 86_400_000
  return tasks.filter((task) => {
    if (filterAssignee && task.assignee !== filterAssignee) return false
    if (filterProject && task.project !== filterProject) return false
    if (
      query &&
      ![
        task.id,
        task.externalRef,
        task.title,
        task.description,
        task.assignee,
        task.project,
        ...task.labels,
      ].some((value) => value?.toLowerCase().includes(query))
    )
      return false
    if (cutoffMs !== null) {
      const updatedAtMs = Date.parse(task.updated_at)
      if (!Number.isNaN(updatedAtMs)) {
        if (updatedAtMs < cutoffMs) return false
      }
    }
    return true
  })
}

export function getColumnColor(name: string): string {
  return COLUMN_COLORS.get(name.toLowerCase()) ?? 'var(--text-secondary)'
}

const PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const

/** Keep the bootstrap metrics coherent with optimistic and realtime board mutations. */
export function reconcileMetricsWithBoard(
  metrics: BoardMetrics | null,
  board: BoardView,
): BoardMetrics | null {
  if (!metrics) return null
  const tasks = board.columns.flatMap((column) => column.tasks)
  const doneColumnIds = new Set(selectDoneColumnIds(board.columns))
  const inProgressColumnIds = new Set(selectInProgressColumnIds(board.columns))
  const completedTasks = board.columns
    .filter((column) => doneColumnIds.has(column.id))
    .reduce((count, column) => count + column.tasks.length, 0)
  const inProgressCount = board.columns
    .filter((column) => inProgressColumnIds.has(column.id))
    .reduce((count, column) => count + column.tasks.length, 0)
  const totalTasks = tasks.length
  const cutoffMs = Date.now() - 7 * 86_400_000

  return {
    ...metrics,
    tasksByColumn: board.columns.map((column) => ({
      column_name: column.name,
      count: column.tasks.length,
    })),
    tasksByPriority: PRIORITIES.map((priority) => ({
      priority,
      count: tasks.filter((task) => task.priority === priority).length,
    })).filter(({ count }) => count > 0),
    totalTasks,
    completedTasks,
    tasksCreatedThisWeek: tasks.filter((task) => {
      const createdAt = Date.parse(
        task.created_at + (/Z$|[+-]\d{2}:\d{2}$/.test(task.created_at) ? '' : 'Z'),
      )
      return !Number.isNaN(createdAt) && createdAt >= cutoffMs
    }).length,
    inProgressCount,
    completionPercent: totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0,
    assignees: [...new Set(tasks.map((task) => task.assignee).filter(Boolean))].sort(),
    projects: [...new Set(tasks.map((task) => task.project).filter(Boolean))].sort(),
  }
}

export function findTask(
  board: BoardView,
  id: string,
): { task: Task; columnId: string; columnName: string } | null {
  for (const column of board.columns) {
    const task = column.tasks.find((t) => t.id === id)
    if (task) return { task, columnId: column.id, columnName: column.name }
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

export function moveTaskInBoard(board: BoardView, id: string, toColumn: string): BoardView {
  const lower = toColumn.toLowerCase()
  const target = board.columns.find((c) => c.id === toColumn || c.name.toLowerCase() === lower)
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

export function insertTask(board: BoardView, task: Task, column: string): BoardView {
  const lower = column.toLowerCase()
  const targetIdx = board.columns.findIndex(
    (c) => c.id === column || c.name.toLowerCase() === lower,
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

// Returns null when the target column is not present in the client's board
// (e.g. a provider whose task.column_id differs from the board column id, or a
// column added since the last fetch). Callers should treat null as "cannot place
// locally" and fall back to a full refresh.
export function upsertTaskInColumn(
  board: BoardView,
  task: Task,
  columnId: string,
): BoardView | null {
  const targetIdx = board.columns.findIndex((c) => c.id === columnId)
  if (targetIdx === -1) return null

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
