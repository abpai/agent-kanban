import type { StateCreator } from 'zustand'
import { withBasePath, withTokenParam } from '../base'
import type { AppState } from '../store'

/**
 * Network transport: the WebSocket connection lifecycle (connect, reconnect,
 * teardown) and the polling timer. Incoming WS messages are parsed here, but
 * the actual board mutation is delegated to the board slice's `applyRealtime*`
 * reducers; anything this layer can't represent falls back to `fetchAll()`.
 */
export interface TransportSlice {
  pollInterval: ReturnType<typeof setTimeout> | null
  pollingEnabled: boolean
  wsConnected: boolean
  ws: WebSocket | null
  wsReconnectTimer: ReturnType<typeof setTimeout> | null

  connectWebSocket: () => void
  disconnectWebSocket: () => void
  startPolling: (intervalMs?: number) => void
  stopPolling: () => void
}

export const createTransportSlice: StateCreator<AppState, [], [], TransportSlice> = (set, get) => ({
  pollInterval: null,
  pollingEnabled: false,
  wsConnected: false,
  ws: null,
  wsReconnectTimer: null,

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
    // WebSocket handshakes can't carry an Authorization header, so the token (if
    // any) rides as a query param to match the server's /ws auth fallback.
    const wsUrl = withTokenParam(`${protocol}//${window.location.host}${withBasePath('/ws')}`)
    const ws = new WebSocket(wsUrl)
    set({ ws })

    ws.onopen = () => {
      set({ wsConnected: true, ws })
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'task:upsert' && data.task && data.columnId) {
          if (!get().applyRealtimeUpsert(data.task, data.columnId)) void get().fetchAll()
          return
        }
        if (data.type === 'task:delete' && data.id) {
          get().applyRealtimeDelete(data.id)
          return
        }
        void get().fetchAll()
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
    void get().fetchAll()
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
})
