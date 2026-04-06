import { useState } from 'react'
import { useStore } from '../store'
import { relativeTime } from '../utils'
import type { Priority } from '../types'

export function TaskDetail() {
  const {
    board,
    metrics,
    config,
    capabilities,
    selectedTaskId,
    selectTask,
    moveTask,
    removeTask,
    updateTask,
  } = useStore()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editingField, setEditingField] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')

  if (!board || !selectedTaskId) return null

  let task = null
  let columnName = ''
  for (const col of board.columns) {
    const found = col.tasks.find((t) => t.id === selectedTaskId)
    if (found) {
      task = found
      columnName = col.name
      break
    }
  }

  if (!task) return null

  const allAssignees = [
    ...new Set([...(metrics?.assignees ?? []), ...(config?.members?.map((m) => m.name) ?? [])]),
  ].sort()
  const allProjects = [
    ...new Set([...(metrics?.projects ?? []), ...(config?.projects ?? [])]),
  ].sort()

  const handleMove = async (newColumn: string) => {
    if (newColumn && newColumn !== columnName) {
      await moveTask(task!.id, newColumn)
    }
  }

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    await removeTask(task!.id)
    setConfirmDelete(false)
  }

  const startEdit = (field: string, currentValue: string) => {
    setEditingField(field)
    setEditValue(currentValue)
  }

  const saveEdit = async () => {
    if (!editingField) return
    const updates: {
      title?: string
      description?: string
      priority?: Priority
      assignee?: string
      project?: string
    } = {}
    if (editingField === 'title') updates.title = editValue.trim()
    if (editingField === 'description') updates.description = editValue
    if (editingField === 'priority') updates.priority = editValue as Priority
    if (editingField === 'assignee') updates.assignee = editValue
    if (editingField === 'project') updates.project = editValue
    await updateTask(task!.id, updates)
    setEditingField(null)
    setEditValue('')
  }

  const cancelEdit = () => {
    setEditingField(null)
    setEditValue('')
  }

  const editButtons = (
    <div style={{ display: 'flex', gap: 6 }}>
      <button
        className="btnPrimary"
        style={{ fontSize: 12, padding: '4px 12px' }}
        onClick={saveEdit}
      >
        Save
      </button>
      <button
        className="btnSecondary"
        style={{ fontSize: 12, padding: '4px 12px' }}
        onClick={cancelEdit}
      >
        Cancel
      </button>
    </div>
  )

  const editableProps = (field: string, value: string, extra?: React.CSSProperties) => ({
    style: {
      cursor: capabilities.taskUpdate ? 'pointer' : 'default',
      ...extra,
    } as React.CSSProperties,
    onClick: () => capabilities.taskUpdate && startEdit(field, value),
    title: capabilities.taskUpdate ? 'Click to edit' : undefined,
  })

  return (
    <>
      <div className="taskDetailOverlay" onClick={() => selectTask(null)} />
      <div className="taskDetail">
        <button className="closeBtn" onClick={() => selectTask(null)}>
          &times;
        </button>

        {editingField === 'title' ? (
          <div style={{ marginBottom: 20 }}>
            <input
              className="formInput"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              autoFocus
              style={{ marginBottom: 8 }}
            />
            {editButtons}
          </div>
        ) : (
          <div className="detailTitle" {...editableProps('title', task!.title)}>
            {task.title}
          </div>
        )}

        <div className="detailField">
          <div className="detailLabel">ID</div>
          <div className="detailValue" style={{ fontFamily: 'monospace', fontSize: 12 }}>
            {task.id}
          </div>
        </div>

        {task.externalRef && task.externalRef !== task.id && (
          <div className="detailField">
            <div className="detailLabel">Ref</div>
            <div className="detailValue" style={{ fontFamily: 'monospace', fontSize: 12 }}>
              {task.externalRef}
            </div>
          </div>
        )}

        <div className="detailField">
          <div className="detailLabel">Column</div>
          <div className="detailValue" style={{ textTransform: 'capitalize' }}>
            {columnName}
          </div>
        </div>

        <div className="detailField">
          <div className="detailLabel">Priority</div>
          {editingField === 'priority' ? (
            <div>
              <select
                className="formInput"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                style={{ marginBottom: 8 }}
              >
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="urgent">urgent</option>
              </select>
              {editButtons}
            </div>
          ) : (
            <div
              className="detailValue"
              {...editableProps('priority', task!.priority, {
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              })}
            >
              <div className={`priorityDot ${task.priority}`} />
              {task.priority}
            </div>
          )}
        </div>

        <div className="detailField">
          <div className="detailLabel">Assignee</div>
          {editingField === 'assignee' ? (
            <div>
              <select
                className="formInput"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                style={{ marginBottom: 8 }}
              >
                <option value="">Unassigned</option>
                {allAssignees.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              {editButtons}
            </div>
          ) : (
            <div
              className="detailValue"
              {...editableProps('assignee', task!.assignee, {
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              })}
            >
              {task.assignee ? (
                <>
                  <div
                    className="assigneeAvatar"
                    style={{
                      width: 24,
                      height: 24,
                      fontSize: 12,
                    }}
                  >
                    {task.assignee[0]!.toUpperCase()}
                  </div>
                  {task.assignee}
                </>
              ) : (
                <span style={{ color: 'var(--text-muted)' }}>Click to set assignee...</span>
              )}
            </div>
          )}
        </div>

        <div className="detailField">
          <div className="detailLabel">Project</div>
          {editingField === 'project' ? (
            <div>
              <select
                className="formInput"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                style={{ marginBottom: 8 }}
              >
                <option value="">No project</option>
                {allProjects.map((project) => (
                  <option key={project} value={project}>
                    {project}
                  </option>
                ))}
              </select>
              {editButtons}
            </div>
          ) : (
            <div className="detailValue" {...editableProps('project', task!.project)}>
              {task.project ? (
                <span className="projectTag">{task.project}</span>
              ) : (
                <span style={{ color: 'var(--text-muted)' }}>Click to set project...</span>
              )}
            </div>
          )}
        </div>

        <div className="detailField">
          <div className="detailLabel">Description</div>
          {editingField === 'description' ? (
            <div>
              <textarea
                className="formInput"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                autoFocus
                style={{ marginBottom: 8 }}
              />
              {editButtons}
            </div>
          ) : (
            <div
              className="detailValue"
              {...editableProps('description', task!.description || '', { minHeight: 20 })}
            >
              {task.description || (
                <span style={{ color: 'var(--text-muted)' }}>Click to add description...</span>
              )}
            </div>
          )}
        </div>

        {task.metadata && task.metadata !== '{}' && (
          <div className="detailField">
            <div className="detailLabel">Metadata</div>
            <div className="detailValue" style={{ fontFamily: 'monospace', fontSize: 12 }}>
              {task.metadata}
            </div>
          </div>
        )}

        <div className="detailField">
          <div className="detailLabel">Created</div>
          <div className="detailValue">{relativeTime(task.created_at)}</div>
        </div>

        <div className="detailField">
          <div className="detailLabel">Updated</div>
          <div className="detailValue">{relativeTime(task.updated_at)}</div>
        </div>

        {task.url && (
          <div className="detailField">
            <div className="detailLabel">Link</div>
            <a className="detailValue" href={task.url} target="_blank" rel="noreferrer">
              Open in provider
            </a>
          </div>
        )}

        <div className="detailActions">
          {capabilities.taskMove && (
            <select
              className="detailSelect"
              value={columnName}
              onChange={(e) => handleMove(e.target.value)}
            >
              {board.columns.map((col) => (
                <option key={col.id} value={col.name}>
                  {col.name}
                </option>
              ))}
            </select>
          )}
          {capabilities.taskDelete && (
            <button className="deleteBtn" onClick={handleDelete}>
              {confirmDelete ? 'Confirm Delete' : 'Delete'}
            </button>
          )}
        </div>
      </div>
    </>
  )
}
