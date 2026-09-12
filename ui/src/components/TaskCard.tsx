import { memo } from 'react'
import { useStore } from '../store'
import type { Task } from '../types'
import { relativeTime } from '../utils'

export const TaskCard = memo(function TaskCard({ task }: { task: Task }) {
  const isSelected = useStore((s) => s.selectedTaskId === task.id)
  const selectTask = useStore((s) => s.selectTask)
  return (
    <button
      type="button"
      className={`taskCard${isSelected ? ' selected' : ''}`}
      onClick={() => selectTask(isSelected ? null : task.id)}
      aria-pressed={isSelected}
    >
      <span className="taskCardHeader">
        <span className={`priorityDot ${task.priority}`} title={`${task.priority} priority`} />
        <span className="taskTitle">{task.title}</span>
      </span>
      {task.description && <span className="taskDescription">{task.description}</span>}
      {task.labels.length > 0 && (
        <span className="taskLabels">
          {task.labels.slice(0, 3).map((label) => (
            <span key={label} className="taskLabel">
              {label}
            </span>
          ))}
          {task.labels.length > 3 && <span className="taskLabel">+{task.labels.length - 3}</span>}
        </span>
      )}
      <span className="taskFooter">
        <span className="taskFooterLeft">
          {task.externalRef && task.externalRef !== task.id && (
            <span className="taskReference">{task.externalRef}</span>
          )}
          {task.project && <span className="projectTag">{task.project}</span>}
          {task.comment_count > 0 && (
            <span className="commentCount" title={`${task.comment_count} comments`}>
              {task.comment_count} comments
            </span>
          )}
        </span>
        <span className="taskFooterRight">
          <span className="timestamp" title={task.updated_at}>
            {relativeTime(task.updated_at)}
          </span>
          {task.assignee && (
            <span
              className="assigneeAvatar"
              title={task.assignee}
              aria-label={`Assigned to ${task.assignee}`}
            >
              {task.assignee[0]!.toUpperCase()}
            </span>
          )}
        </span>
      </span>
    </button>
  )
})
