import { afterEach, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test'

import { defaultCapabilities } from './capabilities'
import type { BoardBootstrap, Task } from '../types'

let useStore: typeof import('../store').useStore
let api: typeof import('../api').api

beforeAll(async () => {
  // The browser API chooses its base path at import time; restore the global
  // immediately so these state tests do not leak a browser shim into other suites.
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    value: { location: { pathname: '/' } },
    configurable: true,
  })
  try {
    ;({ useStore } = await import('../store'))
    ;({ api } = await import('../api'))
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

afterEach(() => {
  mock.restore()
  useStore.setState(useStore.getInitialState(), true)
})

const task: Task = {
  id: 't_retry',
  title: 'Original title',
  description: '',
  column_id: 'backlog',
  position: 0,
  priority: 'medium',
  assignee: '',
  assignees: [],
  labels: [],
  comment_count: 0,
  project: '',
  metadata: '{}',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  version: '0',
  source_updated_at: null,
}
const bootstrap: BoardBootstrap = {
  provider: 'local',
  capabilities: defaultCapabilities,
  board: {
    columns: [
      {
        id: 'backlog',
        name: 'backlog',
        position: 0,
        color: null,
        created_at: '',
        updated_at: '',
        tasks: [task],
      },
    ],
  },
  config: { members: [], projects: [] },
  metrics: null,
  activity: [],
  team: null,
}

describe('UI mutation recovery', () => {
  test('failed conflict overwrite preserves the dialog and edits for a successful retry', async () => {
    const conflict = {
      taskId: task.id,
      attemptedUpdates: { title: 'My edits' },
      message: 'Task changed remotely',
    }
    useStore.setState({ board: bootstrap.board, pendingConflict: conflict })
    const update = spyOn(api, 'updateTask')
      .mockRejectedValueOnce(new Error('Network unavailable'))
      .mockResolvedValueOnce({ ...task, title: 'My edits' })
    spyOn(api, 'getBootstrap').mockResolvedValue(bootstrap)

    const failedSave = useStore.getState().resolveConflictKeepLocal()
    expect(useStore.getState().pendingConflict).toBe(conflict)
    await expect(failedSave).rejects.toThrow('Network unavailable')
    expect(useStore.getState().pendingConflict).toBe(conflict)

    await useStore.getState().resolveConflictKeepLocal()
    expect(update).toHaveBeenCalledTimes(2)
    expect(update).toHaveBeenLastCalledWith(task.id, { title: 'My edits' })
    expect(useStore.getState().pendingConflict).toBeNull()
  })

  test('failed deletion restores the task and selection with an error that survives modal remount', async () => {
    useStore.setState({ board: bootstrap.board, selectedTaskId: task.id })
    spyOn(api, 'deleteTask')
      .mockRejectedValueOnce(new Error('Delete unavailable'))
      .mockResolvedValueOnce(task)

    await expect(useStore.getState().removeTask(task.id)).rejects.toThrow('Delete unavailable')
    expect(useStore.getState().board).toBe(bootstrap.board)
    expect(useStore.getState().selectedTaskId).toBe(task.id)
    expect(useStore.getState().error).toBe('Delete unavailable')

    await useStore.getState().removeTask(task.id)
    expect(useStore.getState().selectedTaskId).toBeNull()
    expect(useStore.getState().board!.columns[0]!.tasks).toEqual([])
    expect(useStore.getState().error).toBeNull()
  })
})
