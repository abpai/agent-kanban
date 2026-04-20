import type { Column as ColumnType, Task } from '../types'
import { useStore } from '../store'
import { TaskCard } from './TaskCard'
import { filterVisibleTasks, getColumnColor } from './boardUtils'

interface ColumnProps {
  column: ColumnType & { tasks: Task[] }
}

export function Column({ column }: ColumnProps) {
  const { filterAssignee, filterProject, filterActivityDays, setShowNewTaskModal, capabilities } =
    useStore()

  const filteredTasks = filterVisibleTasks(
    column.tasks,
    filterAssignee,
    filterProject,
    filterActivityDays,
  )
  const dotColor = getColumnColor(column.name)

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
