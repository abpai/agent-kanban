import { create } from 'zustand'
import { createBoardSlice, type BoardSlice } from './store/board-slice'
import { createTransportSlice, type TransportSlice } from './store/transport-slice'
import { createUiSlice, type UiSlice } from './store/ui-slice'

/**
 * The app store is composed from three independent slices (Zustand's slices
 * pattern) so each concern lives in its own module while sharing one store and
 * one `set`/`get`:
 * - board-slice: board data + optimistic mutations + conflict resolution
 * - transport-slice: WebSocket + polling
 * - ui-slice: selection, filters, modal (client-only UI state)
 */
export type AppState = BoardSlice & TransportSlice & UiSlice

export const useStore = create<AppState>((...a) => ({
  ...createBoardSlice(...a),
  ...createTransportSlice(...a),
  ...createUiSlice(...a),
}))
