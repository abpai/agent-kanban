import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import { Dialog } from './Dialog'

export function ConflictModal() {
  const { pendingConflict, resolveConflictKeepLocal, resolveConflictDiscardLocal } = useStore(
    useShallow((s) => ({
      pendingConflict: s.pendingConflict,
      resolveConflictKeepLocal: s.resolveConflictKeepLocal,
      resolveConflictDiscardLocal: s.resolveConflictDiscardLocal,
    })),
  )
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  if (!pendingConflict) return null
  const resolve = async (action: () => Promise<void>) => {
    setSaving(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resolve changes. Try again.')
    } finally {
      setSaving(false)
    }
  }
  return (
    <Dialog label="Conflicting update">
      <h2>Conflicting update</h2>
      <p className="detailValue">{pendingConflict.message}</p>
      <p className="detailHint">
        This task changed after you loaded it. Keep your edits to overwrite the remote change, or
        discard them to load the latest version.
      </p>
      {error && (
        <p className="errorBanner" role="alert">
          {error}
        </p>
      )}
      <div className="modalActions">
        <button
          className="btnSecondary"
          disabled={saving}
          onClick={() => void resolve(resolveConflictDiscardLocal)}
        >
          Discard my changes
        </button>
        <button
          className="btnPrimary"
          disabled={saving}
          onClick={() => void resolve(resolveConflictKeepLocal)}
        >
          Keep my changes
        </button>
      </div>
    </Dialog>
  )
}
