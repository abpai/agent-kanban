import { create } from 'zustand'
import { api, ApiError } from './api'
import { withBasePath } from './base'
import { safeLocalStorageGet, safeLocalStorageSet } from './utils'
import {
  findTask,
  insertTask,
  makeTempId,
  moveTaskInBoard,
  patchTask,
  removeTaskById,
  replaceTask,
  upsertTaskInColumn,
} from './components/boardUtils'
import type {
  BoardConfig,
  BoardMetrics,
  BoardView,
  Priority,
  ProviderCapabilities,
  ProviderTeamInfo,
  ActivityEntry,
  Task,
} from './types'

function getErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}

export interface PendingConflict {
  taskId: string
  attemptedUpdates: {
    title?: string
    description?: string
    priority?: Priority
    assignee?: string
    project?: string
  }
  message: string
}

const defaultCapabilities: ProviderCapabilities = {
  taskCreate: true,
  taskUpdate: true,
  taskMove: true,
  taskDelete: true,
  comment: true,
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
  provider: 'local' | 'linear' | 'jira'
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
    opts?: { expectedVersion?: string | null },
  ) => Promise<void>
  moveTask: (id: string, column: string) => Promise<void>
  removeTask: (id: string) => Promise<void>
  pendingConflict: PendingConflict | null
  resolveConflictKeepLocal: () => Promise<void>
  resolveConflictDiscardLocal: () => Promise<void>
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
  pendingConflict: null,

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
    const board = get().board
    if (!board) {
      await api.createTask(data)
      return
    }
    const columnName = data.column ?? 'backlog'
    const tempId = makeTempId()
    const now = new Date().toISOString()
    const optimistic: Task = {
      id: tempId,
      providerId: tempId,
      externalRef: tempId,
      url: null,
      title: data.title,
      description: data.description ?? '',
      column_id: '',
      position: 0,
      priority: data.priority ?? 'medium',
      assignee: data.assignee ?? '',
      assignees: data.assignee ? [data.assignee] : [],
      labels: [],
      comment_count: 0,
      project: data.project ?? '',
      metadata: '{}',
      created_at: now,
      updated_at: now,
      version: '0',
      source_updated_at: null,
    }
    const snapshot = board
    set({ board: insertTask(board, optimistic, columnName) })
    try {
      const created = await api.createTask(data)
      const current = get().board
      if (current) set({ board: replaceTask(current, tempId, created) })
    } catch (err) {
      set({ board: snapshot })
      throw err
    }
  },

  updateTask: async (id, data, opts) => {
    const board = get().board
    const snapshot = board
    if (board) set({ board: patchTask(board, id, data) })
    const payload: Parameters<typeof api.updateTask>[1] = { ...data }
    if (opts?.expectedVersion) payload.expectedVersion = opts.expectedVersion
    try {
      const updated = await api.updateTask(id, payload)
      const current = get().board
      if (current) set({ board: replaceTask(current, id, updated) })
    } catch (err) {
      if (snapshot) set({ board: snapshot })
      if (err instanceof ApiError && err.code === 'CONFLICT') {
        set({ pendingConflict: { taskId: id, attemptedUpdates: data, message: err.message } })
        return
      }
      throw err
    }
  },

  moveTask: async (id, column) => {
    const board = get().board
    const snapshot = board
    if (board) set({ board: moveTaskInBoard(board, id, column) })
    try {
      const moved = await api.moveTask(id, column)
      const current = get().board
      if (current) set({ board: replaceTask(current, id, moved) })
    } catch (err) {
      if (snapshot) set({ board: snapshot })
      throw err
    }
  },

  removeTask: async (id) => {
    const board = get().board
    const snapshot = board
    const found = board ? findTask(board, id) : null
    if (board) set({ board: removeTaskById(board, id), selectedTaskId: null })
    try {
      await api.deleteTask(id)
    } catch (err) {
      if (snapshot) set({ board: snapshot, selectedTaskId: found ? id : null })
      throw err
    }
  },

  resolveConflictKeepLocal: async () => {
    const conflict = get().pendingConflict
    if (!conflict) return
    set({ pendingConflict: null })
    await api.updateTask(conflict.taskId, conflict.attemptedUpdates)
    await get().fetchAll()
  },

  resolveConflictDiscardLocal: async () => {
    set({ pendingConflict: null })
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
    const wsUrl = `${protocol}//${window.location.host}${withBasePath('/ws')}`
    const ws = new WebSocket(wsUrl)
    set({ ws })

    ws.onopen = () => {
      set({ wsConnected: true, ws })
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'task:upsert' && data.task && data.columnName) {
          const current = get().board
          if (current) set({ board: upsertTaskInColumn(current, data.task, data.columnName) })
          return
        }
        if (data.type === 'task:delete' && data.id) {
          const current = get().board
          if (current) set({ board: removeTaskById(current, data.id) })
          return
        }
        get().fetchAll()
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
