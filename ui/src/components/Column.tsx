import type { Column as ColumnType, Task } from '../types'
import { TaskCard } from './TaskCard'
import { useStore } from '../store'

interface ColumnProps {
  column: ColumnType & { tasks: Task[] }
}

const COLUMN_COLORS: Record<string, string> = {
  recurring: 'var(--col-recurring)',
  backlog: 'var(--col-backlog)',
  'in-progress': 'var(--col-in-progress)',
  review: 'var(--col-review)',
  done: 'var(--col-done)',
}

export function Column({ column }: ColumnProps) {
  const { filterAssignee, filterProject, setShowNewTaskModal, capabilities } = useStore()

  const filteredTasks = column.tasks.filter((task) => {
    if (filterAssignee && task.assignee !== filterAssignee) return false
    if (filterProject && task.project !== filterProject) return false
    return true
  })

  const dotColor = COLUMN_COLORS[column.name.toLowerCase()] ?? 'var(--text-muted)'

  return (
    <section className="column" aria-label={`${column.name} column`}>
      <div className="columnHeader">
        <div className="columnHeaderMain">
          <div className="columnDot" style={{ background: dotColor }} />
          <span className="columnName">{column.name}</span>
        </div>
        <div className="columnHeaderActions">
          <span className="columnCount">{filteredTasks.length}</span>
          {capabilities.taskCreate && (
            <button
              className="columnAddBtn"
              title={`Add task to ${column.name}`}
              aria-label={`Add task to ${column.name}`}
              onClick={() => setShowNewTaskModal(true, column.name)}
            >
              +
            </button>
          )}
        </div>
      </div>
      <div className="columnBody">
        {filteredTasks.length === 0 ? (
          <div className="emptyColumn">No tasks</div>
        ) : (
          filteredTasks.map((task) => <TaskCard key={task.id} task={task} />)
        )}
      </div>
    </section>
  )
}
