import { useEffect } from 'react'
import { useStore } from './store'
import { Header } from './components/Header'
import { Board } from './components/Board'
import { TaskDetail } from './components/TaskDetail'
import { NewTaskModal } from './components/NewTaskModal'

export function App() {
  const { startPolling, stopPolling, disconnectWebSocket, error, selectedTaskId, board, loading } =
    useStore()

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
      {error && <div className="errorBanner">{error}</div>}
      {loading && !board ? <div className="loading">Loading board...</div> : <Board />}
      <NewTaskModal />
      {selectedTaskId && <TaskDetail />}
    </div>
  )
}
