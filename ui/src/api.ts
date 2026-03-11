import type {
  BoardBootstrap,
  BoardConfig,
  BoardMetrics,
  BoardView,
  ActivityEntry,
  Task,
  Priority,
} from './types'

const BASE = '/api'

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init)
  const body = await res.json()
  if (!body.ok) throw new Error(body.error?.message ?? 'Unknown error')
  return body.data as T
}

export const api = {
  getBootstrap: () => fetchJson<BoardBootstrap>('/bootstrap'),
  getBoard: () => fetchJson<BoardView>('/board'),
  getActivity: (limit = 50) => fetchJson<ActivityEntry[]>(`/activity?limit=${limit}`),
  getMetrics: () => fetchJson<BoardMetrics>('/metrics'),
  getTask: (id: string) => fetchJson<Task>(`/tasks/${id}`),
  getConfig: () => fetchJson<BoardConfig>('/config'),
  createTask: (data: {
    title: string
    description?: string
    column?: string
    priority?: Priority
    assignee?: string
    project?: string
  }) =>
    fetchJson<Task>('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  updateTask: (
    id: string,
    data: {
      title?: string
      description?: string
      priority?: Priority
      assignee?: string
      project?: string
    },
  ) =>
    fetchJson<Task>(`/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  moveTask: (id: string, column: string) =>
    fetchJson<Task>(`/tasks/${id}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ column }),
    }),
  deleteTask: (id: string) =>
    fetchJson<Task>(`/tasks/${id}`, {
      method: 'DELETE',
    }),
}
