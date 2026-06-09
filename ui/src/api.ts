import type { BoardBootstrap, Task, Priority } from './types'
import { withBasePath, authHeaders } from './base'

const BASE = withBasePath('/api')

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

interface ApiEnvelope<T> {
  ok: boolean
  data?: T
  error?: { code?: string; message?: string }
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { ...authHeaders(), ...init?.headers },
    })
  } catch (err) {
    throw new ApiError(
      'NETWORK_ERROR',
      err instanceof Error ? err.message : 'Network request failed',
    )
  }

  // The server can return non-JSON (WebSocket upgrade text, "dashboard not built",
  // proxy errors) and malformed bodies can slip past the API envelope. Only parse
  // JSON when advertised, and normalize every failure into a typed ApiError so the
  // store keeps its stable error codes (e.g. CONFLICT) instead of seeing a raw
  // SyntaxError.
  const contentType = res.headers.get('content-type') ?? ''
  let body: ApiEnvelope<T> | undefined
  if (contentType.includes('application/json')) {
    try {
      body = (await res.json()) as ApiEnvelope<T>
    } catch {
      throw new ApiError('INVALID_RESPONSE', 'Server returned a malformed JSON response')
    }
  }

  if (body && typeof body === 'object' && 'ok' in body) {
    if (!body.ok) {
      throw new ApiError(body.error?.code ?? 'UNKNOWN', body.error?.message ?? 'Unknown error')
    }
    return body.data as T
  }

  if (!res.ok) {
    const text = body === undefined ? await res.text().catch(() => '') : ''
    throw new ApiError(
      `HTTP_${res.status}`,
      text.trim() || `Request failed with status ${res.status}`,
    )
  }
  throw new ApiError('INVALID_RESPONSE', 'Server returned an unexpected response')
}

export const api = {
  getBootstrap: () => fetchJson<BoardBootstrap>('/bootstrap'),
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
      expectedVersion?: string
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
