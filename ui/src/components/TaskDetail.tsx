import { type CSSProperties, type ReactNode, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Dialog } from './Dialog'
import { useStore } from '../store'
import { getTaskOptions, parsePriority, relativeTime } from '../utils'
import { findTask } from './boardUtils'
import type { Task } from '../types'

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
  options,
  isEditing,
  editValue,
  editButtons,
  canEdit,
  valueStyle,
  onStartEdit,
  onEditValueChange,
  children,
}: {
  label: string
  options: SelectOption[]
  isEditing: boolean
  editValue: string
  editButtons: ReactNode
  canEdit: boolean
  valueStyle?: CSSProperties
  onStartEdit: () => void
  onEditValueChange: (value: string) => void
  children: ReactNode
}) {
  return (
    <div className="detailField">
      <div className="detailLabel">{label}</div>
      {isEditing ? (
        <div>
          <select
            className="formInput"
            aria-label={label}
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
          role={canEdit ? 'button' : undefined}
          tabIndex={canEdit ? 0 : undefined}
          aria-label={canEdit ? `Edit ${label}` : undefined}
          onKeyDown={(e) => {
            if (canEdit && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault()
              onStartEdit()
            }
          }}
          onClick={() => canEdit && onStartEdit()}
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
    storeError,
  } = useStore(
    useShallow((s) => ({
      board: s.board,
      metrics: s.metrics,
      config: s.config,
      capabilities: s.capabilities,
      selectedTaskId: s.selectedTaskId,
      selectTask: s.selectTask,
      moveTask: s.moveTask,
      removeTask: s.removeTask,
      updateTask: s.updateTask,
      storeError: s.error,
    })),
  )
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editingField, setEditingField] = useState<EditableField | null>(null)
  const [editValue, setEditValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  if (!board || !selectedTaskId) return null

  const found = findTask(board, selectedTaskId)
  if (!found) return null
  const { task, columnId, columnName } = found
  const { assignees, projects } = getTaskOptions(metrics, config)

  const runMutation = async (action: () => Promise<void>) => {
    setSaving(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save changes. Try again.')
    } finally {
      setSaving(false)
    }
  }

  const handleMove = async (newColumn: string) => {
    if (newColumn && newColumn !== columnId) {
      await moveTask(task.id, newColumn)
    }
  }

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    await removeTask(task.id)
    setConfirmDelete(false)
  }

  const startEdit = (field: EditableField, currentValue: string) => {
    setEditingField(field)
    setEditValue(currentValue)
  }

  const saveEdit = async () => {
    if (!editingField) return
    const updates: Parameters<typeof updateTask>[1] = {}
    if (editingField === 'title') updates.title = editValue.trim()
    if (editingField === 'description') updates.description = editValue
    if (editingField === 'priority') updates.priority = parsePriority(editValue)
    if (editingField === 'assignee') updates.assignee = editValue
    if (editingField === 'project') updates.project = editValue
    await updateTask(task.id, updates, { expectedVersion: task.version })
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
        disabled={saving || (editingField === 'title' && !editValue.trim())}
        onClick={() => void runMutation(saveEdit)}
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
    } satisfies CSSProperties,
    role: capabilities.taskUpdate ? 'button' : undefined,
    tabIndex: capabilities.taskUpdate ? 0 : undefined,
    'aria-label': capabilities.taskUpdate ? `Edit ${field}` : undefined,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (capabilities.taskUpdate && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault()
        startEdit(field, value)
      }
    },
    onClick: () => capabilities.taskUpdate && startEdit(field, value),
    title: capabilities.taskUpdate ? 'Click to edit' : undefined,
  })

  return (
    <Dialog className="taskDetail" label={task.title} onClose={() => selectTask(null)}>
      <button
        className="closeBtn"
        aria-label="Close task"
        autoFocus
        onClick={() => selectTask(null)}
      >
        &times;
      </button>

      {(error ?? storeError) && (
        <p className="errorBanner" role="alert">
          {error ?? storeError}
        </p>
      )}
      {editingField === 'title' ? (
        <div style={{ marginBottom: 20 }}>
          <input
            className="formInput"
            aria-label="Title"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            autoFocus
            style={{ marginBottom: 8 }}
          />
          {editButtons}
        </div>
      ) : (
        <div className="detailTitle" {...editableProps('title', task.title)}>
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
        options={PRIORITY_OPTIONS}
        isEditing={editingField === 'priority'}
        editValue={editValue}
        editButtons={editButtons}
        canEdit={capabilities.taskUpdate}
        valueStyle={{ display: 'flex', alignItems: 'center', gap: 8 }}
        onStartEdit={() => startEdit('priority', task.priority)}
        onEditValueChange={setEditValue}
      >
        <div className={`priorityDot ${task.priority}`} />
        {task.priority}
      </EditableSelectField>

      <EditableSelectField
        label="Assignee"
        options={[
          { value: '', label: 'Unassigned' },
          ...assignees.map((name) => ({ value: name, label: name })),
        ]}
        isEditing={editingField === 'assignee'}
        editValue={editValue}
        editButtons={editButtons}
        canEdit={capabilities.taskUpdate}
        valueStyle={{ display: 'flex', alignItems: 'center', gap: 8 }}
        onStartEdit={() => startEdit('assignee', task.assignee)}
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
              {task.assignee.charAt(0).toUpperCase()}
            </div>
            {task.assignee}
          </>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>Unassigned</span>
        )}
      </EditableSelectField>

      <EditableSelectField
        label="Project"
        options={[
          { value: '', label: 'No project' },
          ...projects.map((project) => ({ value: project, label: project })),
        ]}
        isEditing={editingField === 'project'}
        editValue={editValue}
        editButtons={editButtons}
        canEdit={capabilities.taskUpdate}
        onStartEdit={() => startEdit('project', task.project)}
        onEditValueChange={setEditValue}
      >
        {task.project ? (
          <span className="projectTag">{task.project}</span>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>No project</span>
        )}
      </EditableSelectField>

      <div className="detailField">
        <div className="detailLabel">Description</div>
        {editingField === 'description' ? (
          <div>
            <textarea
              className="formInput"
              aria-label="Description"
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
            {...editableProps('description', task.description || '', { minHeight: 20 })}
          >
            {task.description || (
              <span style={{ color: 'var(--text-muted)' }}>No description yet</span>
            )}
          </div>
        )}
      </div>

      <TaskMetadata task={task} />

      <div className="detailActions">
        {capabilities.taskMove && (
          <select
            className="detailSelect"
            aria-label="Move task to column"
            disabled={saving}
            value={columnId}
            onChange={(e) => void runMutation(() => handleMove(e.target.value))}
          >
            {board.columns.map((col) => (
              <option key={col.id} value={col.id}>
                {col.name}
              </option>
            ))}
          </select>
        )}
        {capabilities.taskDelete && (
          <button
            className="deleteBtn"
            disabled={saving}
            onClick={() => void runMutation(handleDelete)}
          >
            {confirmDelete ? 'Confirm delete' : 'Delete'}
          </button>
        )}
      </div>
    </Dialog>
  )
}

function TaskMetadata({ task }: { task: Task }) {
  return (
    <>
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
    </>
  )
}
