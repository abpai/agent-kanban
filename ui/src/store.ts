import { create } from 'zustand'
import { api } from './api'
import { withBasePath } from './base'
import { safeLocalStorageGet, safeLocalStorageSet } from './utils'
import type {
  BoardConfig,
  BoardMetrics,
  BoardView,
  Priority,
  ProviderCapabilities,
  ProviderTeamInfo,
  ActivityEntry,
} from './types'

function getErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}

const defaultCapabilities: ProviderCapabilities = {
  taskCreate: true,
  taskUpdate: true,
  taskMove: true,
  taskDelete: true,
  activity: true,
  metrics: true,
  columnCrud: true,
  bulk: true,
  configEdit: true,
}

export type ActivityWindowDays = 7 | 14 | 28 | 70 | null

const STORAGE_KEYS = {
  assignee: 'agent-kanban:filter:assignee',
  project: 'agent-kanban:filter:project',
  activityDays: 'agent-kanban:filter:activity-days',
} as const

function loadStoredActivityDays(): ActivityWindowDays {
  const value = safeLocalStorageGet(STORAGE_KEYS.activityDays)
  if (value === '7' || value === '14' || value === '28' || value === '70') {
    return Number(value) as 7 | 14 | 28 | 70
  }
  return null
}

interface AppState {
  board: BoardView | null
  activity: ActivityEntry[]
  metrics: BoardMetrics | null
  config: BoardConfig | null
  provider: 'local' | 'linear'
  capabilities: ProviderCapabilities
  team: ProviderTeamInfo | null
  selectedTaskId: string | null
  loading: boolean
  error: string | null
  pollInterval: ReturnType<typeof setTimeout> | null
  pollingEnabled: boolean
  filterAssignee: string | null
  filterProject: string | null
  filterActivityDays: ActivityWindowDays
  showNewTaskModal: boolean
  newTaskDefaultColumn: string | null
  wsConnected: boolean
  ws: WebSocket | null
  wsReconnectTimer: ReturnType<typeof setTimeout> | null

  fetchBootstrap: () => Promise<void>
  fetchAll: () => Promise<void>
  selectTask: (id: string | null) => void
  setFilterAssignee: (assignee: string | null) => void
  setFilterProject: (project: string | null) => void
  setFilterActivityDays: (days: ActivityWindowDays) => void
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
  provider: 'local',
  capabilities: defaultCapabilities,
  team: null,
  selectedTaskId: null,
  loading: false,
  error: null,
  pollInterval: null,
  pollingEnabled: false,
  filterAssignee: safeLocalStorageGet(STORAGE_KEYS.assignee),
  filterProject: safeLocalStorageGet(STORAGE_KEYS.project),
  filterActivityDays: loadStoredActivityDays(),
  showNewTaskModal: false,
  newTaskDefaultColumn: null,
  wsConnected: false,
  ws: null,
  wsReconnectTimer: null,

  fetchBootstrap: async () => {
    try {
      const bootstrap = await api.getBootstrap()
      set({
        board: bootstrap.board,
        activity: bootstrap.activity,
        metrics: bootstrap.metrics,
        config: bootstrap.config,
        provider: bootstrap.provider,
        capabilities: bootstrap.capabilities,
        team: bootstrap.team,
        error: null,
      })
    } catch (err) {
      set({ error: getErrorMessage(err, 'Failed to fetch board') })
    }
  },

  fetchAll: async () => {
    set({ loading: true })
    await get().fetchBootstrap()
    set({ loading: false })
  },

  selectTask: (id) => set({ selectedTaskId: id }),
  setFilterAssignee: (assignee) => {
    if (assignee) {
      safeLocalStorageSet(STORAGE_KEYS.assignee, assignee)
    } else {
      safeLocalStorageSet(STORAGE_KEYS.assignee, '')
    }
    set({ filterAssignee: assignee })
  },
  setFilterProject: (project) => {
    if (project) {
      safeLocalStorageSet(STORAGE_KEYS.project, project)
    } else {
      safeLocalStorageSet(STORAGE_KEYS.project, '')
    }
    set({ filterProject: project })
  },
  setFilterActivityDays: (days) => {
    if (days) {
      safeLocalStorageSet(STORAGE_KEYS.activityDays, String(days))
    } else {
      safeLocalStorageSet(STORAGE_KEYS.activityDays, '')
    }
    set({ filterActivityDays: days })
  },
  setShowNewTaskModal: (show, defaultColumn) =>
    set({ showNewTaskModal: show, newTaskDefaultColumn: defaultColumn ?? null }),

  createTask: async (data) => {
    await api.createTask(data)
  },

  updateTask: async (id, data) => {
    await api.updateTask(id, data)
  },

  moveTask: async (id, column) => {
    await api.moveTask(id, column)
  },

  removeTask: async (id) => {
    await api.deleteTask(id)
    set({ selectedTaskId: null })
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
    const wsUrl = `${protocol}//${window.location.host}${withBasePath('/ws')}`
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
      ws.onclose = null
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
