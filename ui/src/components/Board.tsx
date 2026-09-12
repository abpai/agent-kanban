import { useDeferredValue, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import { filterVisibleTasks } from './boardUtils'
import { Column } from './Column'

export function Board() {
  const { board, filterAssignee, filterProject, filterActivityDays, searchQuery } = useStore(
    useShallow((s) => ({
      board: s.board,
      filterAssignee: s.filterAssignee,
      filterProject: s.filterProject,
      filterActivityDays: s.filterActivityDays,
      searchQuery: s.searchQuery,
    })),
  )
  const query = useDeferredValue(searchQuery)
  const columns = useMemo(
    () =>
      board?.columns.map((column) => ({
        ...column,
        tasks: filterVisibleTasks(
          column.tasks,
          filterAssignee,
          filterProject,
          filterActivityDays,
          query,
        ),
      })) ?? [],
    [board, filterAssignee, filterProject, filterActivityDays, query],
  )
  if (!board) return null
  const hasFilters = Boolean(filterAssignee || filterProject || filterActivityDays || query.trim())
  const visibleCount = columns.reduce((total, column) => total + column.tasks.length, 0)

  return (
    <main className="boardShell" aria-label="Kanban board" aria-busy={query !== searchQuery}>
      {hasFilters && (
        <p className="filterResults" role="status">
          {visibleCount} matching {visibleCount === 1 ? 'task' : 'tasks'}
        </p>
      )}
      <div className="board">
        {columns.map((column) => (
          <Column key={column.id} column={column} filtered={hasFilters} />
        ))}
      </div>
    </main>
  )
}
