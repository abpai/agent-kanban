import type { StateCreator } from 'zustand'
import { safeLocalStorageGet, safeLocalStorageSet } from '../utils'
import type { AppState } from '../store'

type ActivityWindowDays = 1 | 7 | 14 | 28 | 70 | null

const STORAGE_KEYS = {
  assignee: 'agent-kanban:filter:assignee',
  project: 'agent-kanban:filter:project',
  activityDays: 'agent-kanban:filter:activity-days',
} as const

function loadStoredActivityDays(): ActivityWindowDays {
  const value = safeLocalStorageGet(STORAGE_KEYS.activityDays)
  if (value === '1' || value === '7' || value === '14' || value === '28' || value === '70') {
    return Number(value) as 1 | 7 | 14 | 28 | 70
  }
  return null
}

/**
 * Local, client-only UI state: the selected task, persisted board filters, and
 * the new-task modal. None of this touches the network or the board data.
 */
export interface UiSlice {
  selectedTaskId: string | null
  filterAssignee: string | null
  filterProject: string | null
  filterActivityDays: ActivityWindowDays
  showNewTaskModal: boolean
  newTaskDefaultColumn: string | null

  selectTask: (id: string | null) => void
  setFilterAssignee: (assignee: string | null) => void
  setFilterProject: (project: string | null) => void
  setFilterActivityDays: (days: ActivityWindowDays) => void
  setShowNewTaskModal: (show: boolean, defaultColumn?: string) => void
}

export const createUiSlice: StateCreator<AppState, [], [], UiSlice> = (set) => ({
  selectedTaskId: null,
  filterAssignee: safeLocalStorageGet(STORAGE_KEYS.assignee),
  filterProject: safeLocalStorageGet(STORAGE_KEYS.project),
  filterActivityDays: loadStoredActivityDays(),
  showNewTaskModal: false,
  newTaskDefaultColumn: null,

  selectTask: (id) => set({ selectedTaskId: id }),
  setFilterAssignee: (assignee) => {
    safeLocalStorageSet(STORAGE_KEYS.assignee, assignee || '')
    set({ filterAssignee: assignee })
  },
  setFilterProject: (project) => {
    safeLocalStorageSet(STORAGE_KEYS.project, project || '')
    set({ filterProject: project })
  },
  setFilterActivityDays: (days) => {
    safeLocalStorageSet(STORAGE_KEYS.activityDays, days ? String(days) : '')
    set({ filterActivityDays: days })
  },
  setShowNewTaskModal: (show, defaultColumn) =>
    set({ showNewTaskModal: show, newTaskDefaultColumn: defaultColumn ?? null }),
})
