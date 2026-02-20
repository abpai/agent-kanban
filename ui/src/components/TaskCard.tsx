import { useStore } from '../store'
import type { Task } from '../types'
import { relativeTime, getAvatarColor } from '../utils'

interface TaskCardProps {
  task: Task
}

export function TaskCard({ task }: TaskCardProps) {
  const { selectedTaskId, selectTask } = useStore()

  return (
    <div
      className={`taskCard${selectedTaskId === task.id ? ' selected' : ''}`}
      onClick={() => selectTask(selectedTaskId === task.id ? null : task.id)}
    >
      <div className="taskCardHeader">
        <div className={`priorityDot ${task.priority}`} title={task.priority} />
        <div className="taskTitle">{task.title}</div>
      </div>
      {task.description && <div className="taskDescription">{task.description}</div>}
      <div className="taskFooter">
        <div className="taskFooterLeft">
          {task.assignee && (
            <>
              <div
                className="assigneeAvatar"
                style={{ background: getAvatarColor(task.assignee) }}
                title={task.assignee}
              >
                {task.assignee[0]!.toUpperCase()}
              </div>
              <span className="assigneeName">{task.assignee}</span>
            </>
          )}
          {task.project && <span className="projectTag">{task.project}</span>}
        </div>
        <span className="timestamp">{relativeTime(task.updated_at)}</span>
      </div>
    </div>
  )
}
