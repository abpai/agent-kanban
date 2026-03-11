import { useState, useEffect, useCallback } from 'react'
import { useStore } from '../store'
import type { Priority } from '../types'

export function NewTaskModal() {
  const {
    showNewTaskModal,
    setShowNewTaskModal,
    createTask,
    capabilities,
    board,
    metrics,
    config,
    newTaskDefaultColumn,
  } = useStore()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [column, setColumn] = useState('')
  const [priority, setPriority] = useState<Priority>('medium')
  const [assignee, setAssignee] = useState('')
  const [project, setProject] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const resetForm = useCallback(() => {
    setTitle('')
    setDescription('')
    setColumn(newTaskDefaultColumn ?? '')
    setPriority('medium')
    setAssignee('')
    setProject('')
  }, [newTaskDefaultColumn])

  useEffect(() => {
    if (showNewTaskModal) {
      setColumn(newTaskDefaultColumn ?? '')
    } else {
      resetForm()
    }
  }, [showNewTaskModal, newTaskDefaultColumn, resetForm])

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowNewTaskModal(false)
    }
    if (showNewTaskModal) document.addEventListener('keydown', handleEsc)
    return () => document.removeEventListener('keydown', handleEsc)
  }, [showNewTaskModal, setShowNewTaskModal])

  if (!showNewTaskModal || !capabilities.taskCreate) return null

  const columns = board?.columns ?? []
  const allAssignees = [
    ...new Set([...(metrics?.assignees ?? []), ...(config?.members?.map((m) => m.name) ?? [])]),
  ].sort()
  const allProjects = [
    ...new Set([...(metrics?.projects ?? []), ...(config?.projects ?? [])]),
  ].sort()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    setSubmitting(true)
    try {
      await createTask({
        title: title.trim(),
        description: description.trim() || undefined,
        column: column || undefined,
        priority,
        assignee: assignee || undefined,
        project: project || undefined,
      })
      setShowNewTaskModal(false)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modalOverlay" onClick={() => setShowNewTaskModal(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New Task</h2>
        <form onSubmit={handleSubmit}>
          <div className="formField">
            <label className="formLabel">Title</label>
            <input
              className="formInput"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Task title..."
              autoFocus
            />
          </div>

          <div className="formField">
            <label className="formLabel">Description</label>
            <textarea
              className="formInput"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description..."
            />
          </div>

          <div className="formRow">
            <div className="formField">
              <label className="formLabel">Column</label>
              <select
                className="formInput"
                value={column}
                onChange={(e) => setColumn(e.target.value)}
              >
                <option value="">Default (backlog)</option>
                {columns.map((col) => (
                  <option key={col.id} value={col.name}>
                    {col.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="formField">
              <label className="formLabel">Priority</label>
              <select
                className="formInput"
                value={priority}
                onChange={(e) => setPriority(e.target.value as Priority)}
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
          </div>

          <div className="formRow">
            <div className="formField">
              <label className="formLabel">Assignee</label>
              <select
                className="formInput"
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
              >
                <option value="">Unassigned</option>
                {allAssignees.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </div>

            <div className="formField">
              <label className="formLabel">Project</label>
              <select
                className="formInput"
                value={project}
                onChange={(e) => setProject(e.target.value)}
              >
                <option value="">No project</option>
                {allProjects.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="modalActions">
            <button
              type="button"
              className="btnSecondary"
              onClick={() => setShowNewTaskModal(false)}
            >
              Cancel
            </button>
            <button type="submit" className="btnPrimary" disabled={!title.trim() || submitting}>
              {submitting ? 'Creating...' : 'Create Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
