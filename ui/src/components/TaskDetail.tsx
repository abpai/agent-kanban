import { type CSSProperties, type ReactNode, useState } from 'react'
import { useStore } from '../store'
import { relativeTime } from '../utils'
import type { Priority } from '../types'

type EditableField = 'title' | 'description' | 'priority' | 'assignee' | 'project'

type SelectOption = {
  value: string
  label: string
}

const PRIORITY_OPTIONS: SelectOption[] = [
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'urgent', label: 'urgent' },
]

function EditableSelectField({
  label,
  field,
  value,
  options,
  editingField,
  editValue,
  editButtons,
  canEdit,
  valueStyle,
  onStartEdit,
  onEditValueChange,
  children,
}: {
  label: string
  field: EditableField
  value: string
  options: SelectOption[]
  editingField: EditableField | null
  editValue: string
  editButtons: ReactNode
  canEdit: boolean
  valueStyle?: CSSProperties
  onStartEdit: (field: EditableField, value: string) => void
  onEditValueChange: (value: string) => void
  children: ReactNode
}) {
  return (
    <div className="detailField">
      <div className="detailLabel">{label}</div>
      {editingField === field ? (
        <div>
          <select
            className="formInput"
            value={editValue}
            onChange={(e) => onEditValueChange(e.target.value)}
            style={{ marginBottom: 8 }}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {editButtons}
        </div>
      ) : (
        <div
          className="detailValue"
          style={{
            cursor: canEdit ? 'pointer' : 'default',
            ...valueStyle,
          }}
          onClick={() => canEdit && onStartEdit(field, value)}
          title={canEdit ? 'Click to edit' : undefined}
        >
          {children}
        </div>
      )}
    </div>
  )
}

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
  const [editingField, setEditingField] = useState<EditableField | null>(null)
  const [editValue, setEditValue] = useState('')

  if (!board || !selectedTaskId) return null

  let task = null
  let columnName = ''
  let columnId = ''
  for (const col of board.columns) {
    const found = col.tasks.find((t) => t.id === selectedTaskId)
    if (found) {
      task = found
      columnName = col.name
      columnId = col.id
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
    if (newColumn && newColumn !== columnId) {
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

  const startEdit = (field: EditableField, currentValue: string) => {
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
    await updateTask(task!.id, updates, { expectedVersion: task!.version })
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

  const editableProps = (field: EditableField, value: string, extra?: CSSProperties) => ({
    style: {
      cursor: capabilities.taskUpdate ? 'pointer' : 'default',
      ...extra,
    } as CSSProperties,
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

        <EditableSelectField
          label="Priority"
          field="priority"
          value={task.priority}
          options={PRIORITY_OPTIONS}
          editingField={editingField}
          editValue={editValue}
          editButtons={editButtons}
          canEdit={capabilities.taskUpdate}
          valueStyle={{ display: 'flex', alignItems: 'center', gap: 8 }}
          onStartEdit={startEdit}
          onEditValueChange={setEditValue}
        >
          <div className={`priorityDot ${task.priority}`} />
          {task.priority}
        </EditableSelectField>

        <EditableSelectField
          label="Assignee"
          field="assignee"
          value={task.assignee}
          options={[
            { value: '', label: 'Unassigned' },
            ...allAssignees.map((name) => ({ value: name, label: name })),
          ]}
          editingField={editingField}
          editValue={editValue}
          editButtons={editButtons}
          canEdit={capabilities.taskUpdate}
          valueStyle={{ display: 'flex', alignItems: 'center', gap: 8 }}
          onStartEdit={startEdit}
          onEditValueChange={setEditValue}
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
        </EditableSelectField>

        <EditableSelectField
          label="Project"
          field="project"
          value={task.project}
          options={[
            { value: '', label: 'No project' },
            ...allProjects.map((project) => ({ value: project, label: project })),
          ]}
          editingField={editingField}
          editValue={editValue}
          editButtons={editButtons}
          canEdit={capabilities.taskUpdate}
          onStartEdit={startEdit}
          onEditValueChange={setEditValue}
        >
          {task.project ? (
            <span className="projectTag">{task.project}</span>
          ) : (
            <span style={{ color: 'var(--text-muted)' }}>Click to set project...</span>
          )}
        </EditableSelectField>

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

        {task.labels.length > 0 && (
          <div className="detailField">
            <div className="detailLabel">Labels</div>
            <div className="detailValue" style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {task.labels.map((label) => (
                <span key={label} className="taskLabel">
                  {label}
                </span>
              ))}
            </div>
          </div>
        )}

        {task.comment_count > 0 && (
          <div className="detailField">
            <div className="detailLabel">Comments</div>
            <div className="detailValue">{task.comment_count}</div>
          </div>
        )}

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
              value={columnId}
              onChange={(e) => handleMove(e.target.value)}
            >
              {board.columns.map((col) => (
                <option key={col.id} value={col.id}>
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
