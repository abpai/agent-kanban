import { useEffect, useMemo, useState, type TouchEvent } from 'react'

type BoardTouchEvent = TouchEvent<HTMLElement>
import { useStore } from '../store'
import { Column } from './Column'

const MOBILE_BREAKPOINT = 720
const SWIPE_THRESHOLD = 48

export function Board() {
  const board = useStore((s) => s.board)
  const filterAssignee = useStore((s) => s.filterAssignee)
  const filterProject = useStore((s) => s.filterProject)
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.innerWidth <= MOBILE_BREAKPOINT
  })
  const [activeColumnId, setActiveColumnId] = useState<string | null>(null)
  const [touchStartX, setTouchStartX] = useState<number | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return

    const media = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`)
    const update = () => setIsMobile(media.matches)

    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (!board?.columns.length) {
      setActiveColumnId(null)
      return
    }

    setActiveColumnId((current) => {
      if (current && board.columns.some((column) => column.id === current)) return current
      return board.columns[0]?.id ?? null
    })
  }, [board])

  const columnSummaries = useMemo(() => {
    if (!board) return []

    return board.columns.map((column) => ({
      ...column,
      visibleCount: column.tasks.filter((task) => {
        if (filterAssignee && task.assignee !== filterAssignee) return false
        if (filterProject && task.project !== filterProject) return false
        return true
      }).length,
    }))
  }, [board, filterAssignee, filterProject])

  if (!board) return null

  const activeIndex = Math.max(
    0,
    columnSummaries.findIndex((column) => column.id === activeColumnId),
  )
  const activeColumn = columnSummaries[activeIndex] ?? columnSummaries[0]

  const moveColumn = (direction: -1 | 1) => {
    const nextIndex = activeIndex + direction
    if (nextIndex < 0 || nextIndex >= columnSummaries.length) return
    setActiveColumnId(columnSummaries[nextIndex]!.id)
  }

  const handleTouchStart = (event: BoardTouchEvent) => {
    setTouchStartX(event.touches[0]?.clientX ?? null)
  }

  const handleTouchEnd = (event: BoardTouchEvent) => {
    if (touchStartX === null) return
    const endX = event.changedTouches[0]?.clientX ?? touchStartX
    const deltaX = endX - touchStartX
    setTouchStartX(null)

    if (Math.abs(deltaX) < SWIPE_THRESHOLD) return
    moveColumn(deltaX < 0 ? 1 : -1)
  }

  if (isMobile && activeColumn) {
    return (
      <div className="boardShell mobileBoardShell">
        <div className="mobileBoardNav">
          <div className="mobileBoardNavTop">
            <div>
              <div className="mobileBoardEyebrow">Board</div>
              <div className="mobileBoardTitleRow">
                <h2>{activeColumn.name}</h2>
                <span className="mobileBoardCount">{activeColumn.visibleCount} tasks</span>
              </div>
            </div>
            <div className="mobileBoardStepper" aria-label="Column navigation">
              <button
                type="button"
                className="mobileNavBtn"
                onClick={() => moveColumn(-1)}
                disabled={activeIndex === 0}
                aria-label="Previous column"
              >
                ←
              </button>
              <span className="mobileBoardProgress">
                {activeIndex + 1}/{columnSummaries.length}
              </span>
              <button
                type="button"
                className="mobileNavBtn"
                onClick={() => moveColumn(1)}
                disabled={activeIndex === columnSummaries.length - 1}
                aria-label="Next column"
              >
                →
              </button>
            </div>
          </div>

          <div className="mobileColumnTabs" aria-label="Columns">
            {columnSummaries.map((column) => {
              const isActive = column.id === activeColumn.id
              return (
                <button
                  key={column.id}
                  type="button"
                  className={`mobileColumnTab${isActive ? ' active' : ''}`}
                  onClick={() => setActiveColumnId(column.id)}
                  aria-pressed={isActive}
                >
                  <span className="mobileColumnTabName">{column.name}</span>
                  <span className="mobileColumnTabCount">{column.visibleCount}</span>
                </button>
              )
            })}
          </div>
        </div>

        <div
          className="mobileBoardViewport"
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
          aria-label={`${activeColumn.name} column`}
        >
          <Column column={activeColumn} />
        </div>
      </div>
    )
  }

  return (
    <div className="boardShell">
      <div className="boardHint">Swipe sideways to move across columns</div>
      <div className="board" aria-label="Kanban board">
        {board.columns.map((col) => (
          <Column key={col.id} column={col} />
        ))}
      </div>
    </div>
  )
}
