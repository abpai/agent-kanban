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
  const { filterAssignee, filterProject, setShowNewTaskModal } = useStore()

  const filteredTasks = column.tasks.filter((task) => {
    if (filterAssignee && task.assignee !== filterAssignee) return false
    if (filterProject && task.project !== filterProject) return false
    return true
  })

  const dotColor = COLUMN_COLORS[column.name.toLowerCase()] ?? 'var(--text-muted)'

  return (
    <div className="column">
      <div className="columnHeader">
        <div className="columnDot" style={{ background: dotColor }} />
        <span className="columnName">{column.name}</span>
        <span className="columnCount">{filteredTasks.length}</span>
        <button
          className="columnAddBtn"
          title="Add task to this column"
          onClick={() => setShowNewTaskModal(true, column.name)}
        >
          +
        </button>
      </div>
      <div className="columnBody">
        {filteredTasks.length === 0 ? (
          <div className="emptyColumn">No tasks</div>
        ) : (
          filteredTasks.map((task) => <TaskCard key={task.id} task={task} />)
        )}
      </div>
    </div>
  )
}
