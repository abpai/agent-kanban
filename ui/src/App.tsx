import { lazy, Suspense, useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from './store'
import { Header } from './components/Header'
import { Board } from './components/Board'

const TaskDetail = lazy(() =>
  import('./components/TaskDetail').then((m) => ({ default: m.TaskDetail })),
)
const NewTaskModal = lazy(() =>
  import('./components/NewTaskModal').then((m) => ({ default: m.NewTaskModal })),
)
const ConflictModal = lazy(() =>
  import('./components/ConflictModal').then((m) => ({ default: m.ConflictModal })),
)

export function App() {
  const {
    startPolling,
    stopPolling,
    disconnectWebSocket,
    error,
    selectedTaskId,
    showNewTaskModal,
    pendingConflict,
    loading,
    hasBoard,
  } = useStore(
    useShallow((s) => ({
      startPolling: s.startPolling,
      stopPolling: s.stopPolling,
      disconnectWebSocket: s.disconnectWebSocket,
      error: s.error,
      selectedTaskId: s.selectedTaskId,
      showNewTaskModal: s.showNewTaskModal && s.capabilities.taskCreate,
      pendingConflict: s.pendingConflict !== null,
      loading: s.loading,
      hasBoard: s.board !== null,
    })),
  )

  useEffect(() => {
    startPolling(5000)
    return () => {
      stopPolling()
      disconnectWebSocket()
    }
  }, [startPolling, stopPolling, disconnectWebSocket])

  return (
    <div className="appLayout">
      <Header />
      {error && (
        <div className="errorBanner" role="alert">
          {error}
        </div>
      )}
      {loading && !hasBoard ? (
        <div className="loading" role="status">
          Loading board…
        </div>
      ) : (
        <Board />
      )}
      <Suspense
        fallback={
          <div className="loading" role="status">
            Opening task…
          </div>
        }
      >
        {showNewTaskModal && <NewTaskModal />}
        {selectedTaskId && <TaskDetail key={selectedTaskId} />}
        {pendingConflict && <ConflictModal />}
      </Suspense>
    </div>
  )
}
