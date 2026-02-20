import { create } from 'zustand'
import { api } from './api'
import type { BoardView, ActivityEntry, BoardMetrics, BoardConfig, Priority } from './types'

function getErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}

interface AppState {
  board: BoardView | null
  activity: ActivityEntry[]
  metrics: BoardMetrics | null
  config: BoardConfig | null
  selectedTaskId: string | null
  loading: boolean
  error: string | null
  pollInterval: ReturnType<typeof setTimeout> | null
  pollingEnabled: boolean
  filterAssignee: string | null
  filterProject: string | null
  showNewTaskModal: boolean
  newTaskDefaultColumn: string | null
  wsConnected: boolean
  ws: WebSocket | null
  wsReconnectTimer: ReturnType<typeof setTimeout> | null

  fetchBoard: () => Promise<void>
  fetchActivity: () => Promise<void>
  fetchMetrics: () => Promise<void>
  fetchConfig: () => Promise<void>
  fetchAll: () => Promise<void>
  selectTask: (id: string | null) => void
  setFilterAssignee: (assignee: string | null) => void
  setFilterProject: (project: string | null) => void
  setShowNewTaskModal: (show: boolean, defaultColumn?: string) => void
  createTask: (data: {
    title: string
    description?: string
    column?: string
    priority?: Priority
    assignee?: string
    project?: string
  }) => Promise<void>
  updateTask: (
    id: string,
    data: {
      title?: string
      description?: string
      priority?: Priority
      assignee?: string
      project?: string
    },
  ) => Promise<void>
  moveTask: (id: string, column: string) => Promise<void>
  removeTask: (id: string) => Promise<void>
  connectWebSocket: () => void
  disconnectWebSocket: () => void
  startPolling: (intervalMs?: number) => void
  stopPolling: () => void
}

export const useStore = create<AppState>((set, get) => ({
  board: null,
  activity: [],
  metrics: null,
  config: null,
  selectedTaskId: null,
  loading: false,
  error: null,
  pollInterval: null,
  pollingEnabled: false,
  filterAssignee: null,
  filterProject: null,
  showNewTaskModal: false,
  newTaskDefaultColumn: null,
  wsConnected: false,
  ws: null,
  wsReconnectTimer: null,

  fetchBoard: async () => {
    try {
      const board = await api.getBoard()
      set({ board, error: null })
    } catch (err) {
      set({ error: getErrorMessage(err, 'Failed to fetch board') })
    }
  },

  fetchActivity: async () => {
    try {
      const activity = await api.getActivity()
      set({ activity, error: null })
    } catch (err) {
      set({ error: getErrorMessage(err, 'Failed to fetch activity') })
    }
  },

  fetchMetrics: async () => {
    try {
      const metrics = await api.getMetrics()
      set({ metrics, error: null })
    } catch (err) {
      set({ error: getErrorMessage(err, 'Failed to fetch metrics') })
    }
  },

  fetchConfig: async () => {
    try {
      const config = await api.getConfig()
      set({ config })
    } catch {
      // Config is optional
    }
  },

  fetchAll: async () => {
    set({ loading: true })
    await Promise.all([
      get().fetchBoard(),
      get().fetchActivity(),
      get().fetchMetrics(),
      get().fetchConfig(),
    ])
    set({ loading: false })
  },

  selectTask: (id) => set({ selectedTaskId: id }),

  setFilterAssignee: (assignee) => set({ filterAssignee: assignee }),
  setFilterProject: (project) => set({ filterProject: project }),
  setShowNewTaskModal: (show, defaultColumn) =>
    set({ showNewTaskModal: show, newTaskDefaultColumn: defaultColumn ?? null }),

  createTask: async (data) => {
    await api.createTask(data)
    await get().fetchAll()
  },

  updateTask: async (id, data) => {
    await api.updateTask(id, data)
    await get().fetchAll()
  },

  moveTask: async (id, column) => {
    await api.moveTask(id, column)
    await get().fetchAll()
  },

  removeTask: async (id) => {
    await api.deleteTask(id)
    set({ selectedTaskId: null })
    await get().fetchAll()
  },

  connectWebSocket: () => {
    const existing = get().ws
    if (
      existing &&
      (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)
    ) {
      return
    }

    const reconnectTimer = get().wsReconnectTimer
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      set({ wsReconnectTimer: null })
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/ws`
    const ws = new WebSocket(wsUrl)
    set({ ws })

    ws.onopen = () => {
      set({ wsConnected: true, ws })
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'refresh') {
          get().fetchAll()
        }
      } catch {
        // ignore malformed messages
      }
    }

    ws.onclose = () => {
      set({ wsConnected: false, ws: null })
      if (!get().pollingEnabled) return
      // Auto-reconnect after 3s (tracked so disconnectWebSocket can cancel)
      const timer = setTimeout(() => {
        set({ wsReconnectTimer: null })
        if (get().pollingEnabled && !get().ws) get().connectWebSocket()
      }, 3000)
      set({ wsReconnectTimer: timer })
    }

    ws.onerror = () => {
      ws.close()
    }
  },

  disconnectWebSocket: () => {
    const { ws, wsReconnectTimer } = get()
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer)
    if (ws) {
      ws.onclose = null // Prevent auto-reconnect
      ws.close()
    }
    set({ ws: null, wsConnected: false, wsReconnectTimer: null })
  },

  startPolling: (intervalMs = 5000) => {
    get().stopPolling()
    set({ pollingEnabled: true })
    get().fetchAll()
    get().connectWebSocket()

    const scheduleNextPoll = () => {
      if (!get().pollingEnabled) return
      const delay = get().wsConnected ? 30000 : intervalMs
      const pollInterval = setTimeout(async () => {
        await get().fetchAll()
        scheduleNextPoll()
      }, delay)
      set({ pollInterval })
    }

    scheduleNextPoll()
  },

  stopPolling: () => {
    const { pollInterval } = get()
    set({ pollingEnabled: false })
    if (pollInterval) {
      clearTimeout(pollInterval)
      set({ pollInterval: null })
    }
  },
}))
