import { useStore } from '../store'
import type { Task } from '../types'
import { relativeTime } from '../utils'

interface TaskCardProps {
  task: Task
}

export function TaskCard({ task }: TaskCardProps) {
  const { selectedTaskId, selectTask } = useStore()
  const isSelected = selectedTaskId === task.id

  return (
    <button
      type="button"
      className={`taskCard${isSelected ? ' selected' : ''}`}
      onClick={() => selectTask(isSelected ? null : task.id)}
      aria-pressed={isSelected}
    >
      <div className="taskCardHeader">
        <div className={`priorityDot ${task.priority}`} title={task.priority} />
        <div className="taskTitle">
          {task.externalRef && task.externalRef !== task.id ? `${task.externalRef} ` : ''}
          {task.title}
        </div>
      </div>
      {task.description && <div className="taskDescription">{task.description}</div>}
      {task.labels.length > 0 && (
        <div className="taskLabels">
          {task.labels.slice(0, 3).map((label) => (
            <span key={label} className="taskLabel">
              {label}
            </span>
          ))}
          {task.labels.length > 3 && <span className="taskLabel">+{task.labels.length - 3}</span>}
        </div>
      )}
      <div className="taskFooter">
        <div className="taskFooterLeft">
          {task.assignee && (
            <>
              <div className="assigneeAvatar" title={task.assignee}>
                {task.assignee[0]!.toUpperCase()}
              </div>
              <span className="assigneeName">{task.assignee}</span>
            </>
          )}
          {task.project && <span className="projectTag">{task.project}</span>}
          {task.comment_count > 0 && (
            <span className="commentCount" title={`${task.comment_count} comments`}>
              💬 {task.comment_count}
            </span>
          )}
        </div>
        <span className="timestamp">{relativeTime(task.updated_at)}</span>
      </div>
    </button>
  )
}
