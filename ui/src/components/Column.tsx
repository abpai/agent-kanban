import { memo, useId, useState } from 'react'
import type { Column as ColumnType, Task } from '../types'
import { useStore } from '../store'
import { TaskCard } from './TaskCard'
import { getColumnColor } from './boardUtils'

export const Column = memo(function Column({
  column,
  filtered,
}: {
  column: ColumnType & { tasks: Task[] }
  filtered: boolean
}) {
  const canCreate = useStore((s) => s.capabilities.taskCreate)
  const setShowNewTaskModal = useStore((s) => s.setShowNewTaskModal)
  const [collapsed, setCollapsed] = useState(false)
  const bodyId = useId()
  return (
    <section className="column" aria-label={`${column.name} column`}>
      <div className="columnHeader">
        <button
          className="columnToggle"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={() => setCollapsed(!collapsed)}
        >
          <span className={`columnChevron${collapsed ? ' collapsed' : ''}`} aria-hidden="true">
            ⌄
          </span>
          <span
            className="columnDot"
            style={{ background: column.color || getColumnColor(column.name) }}
          />
          <span className="columnName">{column.name.replace(/-/g, ' ')}</span>
          <span className="columnCount">{column.tasks.length}</span>
        </button>
        {canCreate && (
          <button
            className="columnAddBtn"
            aria-label={`Add task to ${column.name}`}
            onClick={() => setShowNewTaskModal(true, column.id)}
          >
            +
          </button>
        )}
      </div>
      <div id={bodyId} className="columnBody" hidden={collapsed}>
        {column.tasks.length ? (
          column.tasks.map((task) => <TaskCard key={task.id} task={task} />)
        ) : (
          <div className="emptyColumn">{filtered ? 'No matching tasks' : 'No tasks yet'}</div>
        )}
      </div>
    </section>
  )
})
