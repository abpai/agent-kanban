import type { StateCreator } from 'zustand'
import { api, ApiError } from '../api'
import {
  findTask,
  insertTask,
  makeTempId,
  moveTaskInBoard,
  patchTask,
  reconcileMetricsWithBoard,
  removeTaskById,
  replaceTask,
  upsertTaskInColumn,
} from '../components/boardUtils'
import type {
  BoardConfig,
  BoardMetrics,
  BoardView,
  Priority,
  ProviderCapabilities,
  ProviderTeamInfo,
  Task,
} from '../types'
import type { AppState } from '../store'
import { defaultCapabilities } from './capabilities'

interface PendingConflict {
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

/**
 * Board data and the actions that mutate it: bootstrap/refresh, optimistic
 * create/update/move/remove with rollback, conflict resolution, and the
 * board-reducer entry points (`applyRealtime*`) that the transport slice calls
 * when a WebSocket event arrives. All board mutation lives here so the
 * transport slice never reaches into board internals.
 */
export interface BoardSlice {
  board: BoardView | null
  metrics: BoardMetrics | null
  config: BoardConfig | null
  provider: 'local' | 'linear' | 'jira'
  capabilities: ProviderCapabilities
  team: ProviderTeamInfo | null
  loading: boolean
  error: string | null
  pendingConflict: PendingConflict | null

  fetchBootstrap: () => Promise<void>
  fetchAll: () => Promise<void>
  createTask: (data: {
    title: string
    description?: string
    column?: string
    priority?: Priority
    assignee?: string
    project?: string
    labels?: string[]
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
  resolveConflictKeepLocal: () => Promise<void>
  resolveConflictDiscardLocal: () => Promise<void>

  // Board-reducer entry points for realtime events. `applyRealtimeUpsert`
  // returns false when the event can't be represented on the current board
  // (unknown column), signalling the caller to do a full refresh instead.
  applyRealtimeUpsert: (task: Task, columnId: string) => boolean
  applyRealtimeDelete: (id: string) => void
}

export const createBoardSlice: StateCreator<AppState, [], [], BoardSlice> = (set, get) => ({
  board: null,
  metrics: null,
  config: null,
  provider: 'local',
  capabilities: defaultCapabilities,
  team: null,
  loading: false,
  error: null,
  pendingConflict: null,

  fetchBootstrap: async () => {
    try {
      const bootstrap = await api.getBootstrap()
      set({
        board: bootstrap.board,
        metrics: bootstrap.metrics,
        config: bootstrap.config,
        provider: bootstrap.provider,
        capabilities: bootstrap.capabilities,
        team: bootstrap.team,
        error: null,
      })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to fetch board' })
    }
  },

  fetchAll: async () => {
    set({ loading: true })
    await get().fetchBootstrap()
    set({ loading: false })
  },

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
      labels: data.labels ?? [],
      comment_count: 0,
      project: data.project ?? '',
      metadata: '{}',
      created_at: now,
      updated_at: now,
      version: '0',
      source_updated_at: null,
    }
    const snapshot = board
    const snapshotMetrics = get().metrics
    const optimisticBoard = insertTask(board, optimistic, columnName)
    set({
      board: optimisticBoard,
      metrics: reconcileMetricsWithBoard(snapshotMetrics, optimisticBoard),
    })
    try {
      const created = await api.createTask(data)
      const current = get().board
      if (current) {
        const next = replaceTask(current, tempId, created)
        set({ board: next, metrics: reconcileMetricsWithBoard(get().metrics, next) })
      }
    } catch (err) {
      set({ board: snapshot, metrics: snapshotMetrics })
      throw err
    }
  },

  updateTask: async (id, data, opts) => {
    const board = get().board
    const snapshot = board
    const snapshotMetrics = get().metrics
    if (board) {
      const next = patchTask(board, id, data)
      set({ board: next, metrics: reconcileMetricsWithBoard(snapshotMetrics, next) })
    }
    const payload: Parameters<typeof api.updateTask>[1] = { ...data }
    if (opts?.expectedVersion) payload.expectedVersion = opts.expectedVersion
    try {
      const updated = await api.updateTask(id, payload)
      const current = get().board
      if (current) {
        const next = replaceTask(current, id, updated)
        set({ board: next, metrics: reconcileMetricsWithBoard(get().metrics, next) })
      }
    } catch (err) {
      if (snapshot) set({ board: snapshot, metrics: snapshotMetrics })
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
    const snapshotMetrics = get().metrics
    if (board) {
      const next = moveTaskInBoard(board, id, column)
      set({ board: next, metrics: reconcileMetricsWithBoard(snapshotMetrics, next) })
    }
    try {
      const moved = await api.moveTask(id, column)
      const current = get().board
      if (current) {
        const next = replaceTask(current, id, moved)
        set({ board: next, metrics: reconcileMetricsWithBoard(get().metrics, next) })
      }
    } catch (err) {
      if (snapshot) set({ board: snapshot, metrics: snapshotMetrics })
      throw err
    }
  },

  removeTask: async (id) => {
    const board = get().board
    const snapshot = board
    const snapshotMetrics = get().metrics
    const found = board ? findTask(board, id) : null
    if (board) {
      const next = removeTaskById(board, id)
      set({
        board: next,
        metrics: reconcileMetricsWithBoard(snapshotMetrics, next),
        selectedTaskId: null,
        error: null,
      })
    }
    try {
      await api.deleteTask(id)
    } catch (err) {
      if (snapshot) {
        set({ board: snapshot, metrics: snapshotMetrics, selectedTaskId: found ? id : null })
      }
      set({ error: err instanceof Error ? err.message : 'Failed to delete task' })
      throw err
    }
  },

  resolveConflictKeepLocal: async () => {
    const conflict = get().pendingConflict
    if (!conflict) return
    await api.updateTask(conflict.taskId, conflict.attemptedUpdates)
    set({ pendingConflict: null })
    await get().fetchAll()
  },

  resolveConflictDiscardLocal: async () => {
    set({ pendingConflict: null })
    await get().fetchAll()
  },

  applyRealtimeUpsert: (task, columnId) => {
    const current = get().board
    if (!current) return true
    const next = upsertTaskInColumn(current, task, columnId)
    // null = the column isn't in this client's board (e.g. Jira raw status ids,
    // or a newly-added column); signal the caller to do a full refresh so the
    // update is not silently dropped.
    if (!next) return false
    set({ board: next, metrics: reconcileMetricsWithBoard(get().metrics, next) })
    return true
  },

  applyRealtimeDelete: (id) => {
    const current = get().board
    if (current) {
      const next = removeTaskById(current, id)
      set({ board: next, metrics: reconcileMetricsWithBoard(get().metrics, next) })
    }
  },
})
