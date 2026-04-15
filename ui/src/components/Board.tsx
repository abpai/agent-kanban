import { useEffect, useMemo, useState } from 'react'

import { useStore } from '../store'
import { filterVisibleTasks, getColumnColor } from './boardUtils'
import { Column } from './Column'

const MOBILE_BREAKPOINT = 720

export function Board() {
  const board = useStore((s) => s.board)
  const filterAssignee = useStore((s) => s.filterAssignee)
  const filterProject = useStore((s) => s.filterProject)
  const filterActivityDays = useStore((s) => s.filterActivityDays)
  const { selectedTaskId, selectTask, setShowNewTaskModal, capabilities } = useStore()

  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.innerWidth <= MOBILE_BREAKPOINT
  })
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (typeof window === 'undefined') return
    const media = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`)
    const update = () => setIsMobile(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  const columnSummaries = useMemo(() => {
    if (!board) return []
    return board.columns.map((column) => ({
      ...column,
      filteredTasks: filterVisibleTasks(
        column.tasks,
        filterAssignee,
        filterProject,
        filterActivityDays,
      ),
    }))
  }, [board, filterActivityDays, filterAssignee, filterProject])

  if (!board) return null

  const toggleGroup = (id: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (isMobile) {
    return (
      <div className="mobileList">
        {columnSummaries.map((col) => {
          const isCollapsed = collapsedGroups.has(col.id)
          const dotColor = getColumnColor(col.name)

          return (
            <section key={col.id} className="mobileGroup" aria-label={`${col.name} group`}>
              <div className="mobileGroupHeader">
                <button
                  type="button"
                  className="mobileGroupToggle"
                  onClick={() => toggleGroup(col.id)}
                  aria-expanded={!isCollapsed}
                >
                  <span
                    className={`mobileGroupChevron${isCollapsed ? ' collapsed' : ''}`}
                    aria-hidden
                  >
                    ▾
                  </span>
                  <span className="mobileGroupDot" style={{ background: dotColor }} />
                  <span className="mobileGroupName">{col.name}</span>
                  <span className="mobileGroupCount">{col.filteredTasks.length}</span>
                </button>
                {capabilities.taskCreate && (
                  <button
                    type="button"
                    className="mobileGroupAdd"
                    aria-label={`Add task to ${col.name}`}
                    onClick={() => setShowNewTaskModal(true, col.name)}
                  >
                    +
                  </button>
                )}
              </div>

              {!isCollapsed && (
                <div className="mobileGroupBody">
                  {col.filteredTasks.length === 0 ? (
                    <div className="mobileGroupEmpty">No tasks</div>
                  ) : (
                    col.filteredTasks.map((task) => {
                      const isSelected = selectedTaskId === task.id
                      return (
                        <button
                          key={task.id}
                          type="button"
                          className={`mobileTaskRow${isSelected ? ' selected' : ''}`}
                          onClick={() => selectTask(isSelected ? null : task.id)}
                          aria-pressed={isSelected}
                        >
                          <span className={`priorityDot ${task.priority}`} title={task.priority} />
                          <span className="mobileTaskTitle">{task.title}</span>
                          {task.project && (
                            <span className="mobileTaskProject">{task.project}</span>
                          )}
                          {task.assignee && (
                            <span className="mobileTaskAvatar" title={task.assignee}>
                              {task.assignee[0]!.toUpperCase()}
                            </span>
                          )}
                        </button>
                      )
                    })
                  )}
                </div>
              )}
            </section>
          )
        })}
      </div>
    )
  }

  return (
    <div className="boardShell">
      <div className="board" aria-label="Kanban board">
        {board.columns.map((col) => (
          <Column key={col.id} column={col} />
        ))}
      </div>
    </div>
  )
}
