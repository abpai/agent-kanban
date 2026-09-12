import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Dialog } from './Dialog'
import { useStore } from '../store'
import type { Priority } from '../types'

export function NewTaskModal() {
  const { setShowNewTaskModal, createTask, board, metrics, config, newTaskDefaultColumn } =
    useStore(
      useShallow((s) => ({
        setShowNewTaskModal: s.setShowNewTaskModal,
        createTask: s.createTask,
        board: s.board,
        metrics: s.metrics,
        config: s.config,
        newTaskDefaultColumn: s.newTaskDefaultColumn,
      })),
    )
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [column, setColumn] = useState(newTaskDefaultColumn ?? '')
  const [priority, setPriority] = useState<Priority>('medium')
  const [assignee, setAssignee] = useState('')
  const [project, setProject] = useState('')
  const [labels, setLabels] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const [error, setError] = useState<string | null>(null)

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
    setError(null)
    try {
      const parsedLabels = labels
        .split(',')
        .map((label) => label.trim())
        .filter(Boolean)
      await createTask({
        title: title.trim(),
        description: description.trim() || undefined,
        column: column || undefined,
        priority,
        assignee: assignee || undefined,
        project: project || undefined,
        labels: parsedLabels.length > 0 ? parsedLabels : undefined,
      })
      setShowNewTaskModal(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create task. Try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog label="New task" onClose={() => setShowNewTaskModal(false)}>
      <h2>New task</h2>
      {error && (
        <p className="errorBanner" role="alert">
          {error}
        </p>
      )}
      <form onSubmit={(e) => void handleSubmit(e)}>
        <div className="formField">
          <label className="formLabel" htmlFor="new-title">
            Title
          </label>
          <input
            className="formInput"
            type="text"
            id="new-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs to happen?"
            autoFocus
          />
        </div>

        <div className="formField">
          <label className="formLabel" htmlFor="new-description">
            Description
          </label>
          <textarea
            className="formInput"
            id="new-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Add context, links, or acceptance criteria…"
          />
        </div>

        <div className="formRow">
          <div className="formField">
            <label className="formLabel" htmlFor="new-column">
              Column
            </label>
            <select
              className="formInput"
              id="new-column"
              value={column}
              onChange={(e) => setColumn(e.target.value)}
            >
              <option value="">Default column</option>
              {columns.map((col) => (
                <option key={col.id} value={col.id}>
                  {col.name}
                </option>
              ))}
            </select>
          </div>

          <div className="formField">
            <label className="formLabel" htmlFor="new-priority">
              Priority
            </label>
            <select
              className="formInput"
              id="new-priority"
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
            <label className="formLabel" htmlFor="new-assignee">
              Assignee
            </label>
            <select
              className="formInput"
              id="new-assignee"
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
            <label className="formLabel" htmlFor="new-project">
              Project
            </label>
            <select
              className="formInput"
              id="new-project"
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

        <div className="formField">
          <label className="formLabel" htmlFor="new-labels">
            Labels
          </label>
          <input
            className="formInput"
            type="text"
            id="new-labels"
            value={labels}
            onChange={(e) => setLabels(e.target.value)}
            placeholder="Comma-separated, e.g. bug, frontend"
          />
        </div>

        <div className="modalActions">
          <button type="button" className="btnSecondary" onClick={() => setShowNewTaskModal(false)}>
            Cancel
          </button>
          <button type="submit" className="btnPrimary" disabled={!title.trim() || submitting}>
            {submitting ? 'Creating...' : 'Create task'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
