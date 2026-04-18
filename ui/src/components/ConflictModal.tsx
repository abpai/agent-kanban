import { useStore } from '../store'

export function ConflictModal() {
  const { pendingConflict, resolveConflictKeepLocal, resolveConflictDiscardLocal } = useStore()
  if (!pendingConflict) return null

  return (
    <>
      <div className="taskDetailOverlay" />
      <div className="taskDetail" style={{ maxWidth: 480 }}>
        <div className="detailTitle" style={{ marginBottom: 12 }}>
          Conflicting update
        </div>
        <div className="detailValue" style={{ marginBottom: 16 }}>
          {pendingConflict.message}
        </div>
        <div className="detailValue" style={{ marginBottom: 20, color: 'var(--text-muted)' }}>
          This task changed after you loaded it. Keep your edits (overwrites the remote change) or
          discard them (reloads the latest version)?
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btnPrimary" onClick={resolveConflictKeepLocal}>
            Keep my changes
          </button>
          <button className="btnSecondary" onClick={resolveConflictDiscardLocal}>
            Discard my changes
          </button>
        </div>
      </div>
    </>
  )
}
