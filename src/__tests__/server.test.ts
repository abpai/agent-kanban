import { afterEach, describe, expect, test } from 'bun:test'
import type { BoardBootstrap, BoardConfig, BoardMetrics, BoardView, Column, Task } from '../types'
import { startServer, type StartedServer } from '../server'
import type {
  CreateTaskInput,
  KanbanProvider,
  ProviderContext,
  ProviderSyncStatus,
  TaskListFilters,
  UpdateTaskInput,
} from '../providers/types'

const emptyBoard: BoardView = { columns: [] }
const emptyConfig: BoardConfig = { members: [], projects: [], provider: 'local' }
const noopTask = (): Task => ({
  id: 't1',
  providerId: 't1',
  externalRef: 't1',
  url: null,
  title: 'Task',
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
  created_at: '2026-04-22T00:00:00.000Z',
  updated_at: '2026-04-22T00:00:00.000Z',
  version: '1',
  source_updated_at: null,
})
const noopMetrics = (): BoardMetrics => ({
  tasksByColumn: [],
  tasksByPriority: [],
  totalTasks: 0,
  completedTasks: 0,
  avgCompletionHours: null,
  recentActivity: [],
  tasksCreatedThisWeek: 0,
  inProgressCount: 0,
  completionPercent: 0,
  assignees: [],
  projects: [],
})

function makeProvider(overrides: Partial<KanbanProvider> = {}): KanbanProvider {
  const provider: KanbanProvider = {
    type: 'local',
    async getContext(): Promise<ProviderContext> {
      return {
        provider: provider.type,
        capabilities: {
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
          labelReplacement: true,
        },
        team: null,
      }
    },
    async getBootstrap(): Promise<BoardBootstrap> {
      return {
        provider: provider.type,
        capabilities: (await provider.getContext()).capabilities,
        board: emptyBoard,
        config: emptyConfig,
        metrics: null,
        activity: [],
        team: null,
      }
    },
    async getBoard(): Promise<BoardView> {
      return emptyBoard
    },
    async listColumns(): Promise<Column[]> {
      return []
    },
    async listTasks(_filters?: TaskListFilters): Promise<Task[]> {
      return []
    },
    async getTask(_idOrRef: string): Promise<Task> {
      return noopTask()
    },
    async createTask(_input: CreateTaskInput): Promise<Task> {
      return noopTask()
    },
    async updateTask(_idOrRef: string, _input: UpdateTaskInput): Promise<Task> {
      return noopTask()
    },
    async moveTask(_idOrRef: string, _column: string): Promise<Task> {
      return noopTask()
    },
    async deleteTask(_idOrRef: string): Promise<Task> {
      return noopTask()
    },
    async listComments(): Promise<[]> {
      return []
    },
    async getComment() {
      return {
        id: 'c1',
        task_id: 't1',
        body: '',
        author: null,
        created_at: '2026-04-22T00:00:00.000Z',
        updated_at: '2026-04-22T00:00:00.000Z',
      }
    },
    async comment() {
      return {
        id: 'c1',
        task_id: 't1',
        body: '',
        author: null,
        created_at: '2026-04-22T00:00:00.000Z',
        updated_at: '2026-04-22T00:00:00.000Z',
      }
    },
    async updateComment() {
      return {
        id: 'c1',
        task_id: 't1',
        body: '',
        author: null,
        created_at: '2026-04-22T00:00:00.000Z',
        updated_at: '2026-04-22T00:00:00.000Z',
      }
    },
    async getActivity() {
      return []
    },
    async getMetrics(): Promise<BoardMetrics> {
      return noopMetrics()
    },
    async getConfig(): Promise<BoardConfig> {
      return emptyConfig
    },
    async patchConfig(): Promise<BoardConfig> {
      return emptyConfig
    },
    ...overrides,
  }
  return provider
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const runtimes: StartedServer[] = []

afterEach(() => {
  while (runtimes.length > 0) {
    runtimes.pop()?.stop(true)
  }
})

describe('startServer', () => {
  test('health is cheap and does not call getContext', async () => {
    let getContextCalls = 0
    const runtime = startServer(
      makeProvider({
        async getContext() {
          getContextCalls += 1
          return {
            provider: 'local',
            capabilities: {
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
              labelReplacement: true,
            },
            team: null,
          }
        },
      }),
      0,
    )
    runtimes.push(runtime)

    const response = await fetch(`http://127.0.0.1:${runtime.port}/api/health`)
    const body = (await response.json()) as {
      ok: boolean
      data: { provider: string; status: string; wsClients: number }
    }

    expect(response.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.data.provider).toBe('local')
    expect(getContextCalls).toBe(0)
  })

  test('ready stays false until the first background sync succeeds', async () => {
    let resolveSync!: () => void
    const runtime = startServer(
      makeProvider({
        type: 'linear',
        async syncCache() {
          await new Promise<void>((resolve) => {
            resolveSync = resolve
          })
        },
      }),
      0,
      { syncIntervalMs: 20 },
    )
    runtimes.push(runtime)

    await sleep(5)
    let response = await fetch(`http://127.0.0.1:${runtime.port}/api/ready`)
    expect(response.status).toBe(503)

    resolveSync()
    await sleep(5)
    response = await fetch(`http://127.0.0.1:${runtime.port}/api/ready`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      ok: boolean
      data: { ready: boolean; backgroundSync: { warm: boolean } }
    }
    expect(body.ok).toBe(true)
    expect(body.data.ready).toBe(true)
    expect(body.data.backgroundSync.warm).toBe(true)
  })

  test('sync-status reports provider sync metadata and background scheduler state', async () => {
    let syncCalls = 0
    let providerSync: ProviderSyncStatus = {
      lastSyncAt: null,
      lastFullSyncAt: null,
      lastWebhookAt: null,
    }

    const runtime = startServer(
      makeProvider({
        type: 'jira',
        async syncCache() {
          syncCalls += 1
          const now = new Date().toISOString()
          providerSync = {
            lastSyncAt: now,
            lastFullSyncAt: syncCalls === 1 ? now : providerSync.lastFullSyncAt,
            lastWebhookAt: providerSync.lastWebhookAt,
          }
        },
        async getSyncStatus() {
          return providerSync
        },
      }),
      0,
      { syncIntervalMs: 20 },
    )
    runtimes.push(runtime)

    await sleep(55)
    const response = await fetch(`http://127.0.0.1:${runtime.port}/api/sync-status`)
    const body = (await response.json()) as {
      ok: boolean
      data: {
        provider: string
        backgroundSync: { enabled: boolean; warm: boolean; lastSuccessAt: string | null }
        providerSync: ProviderSyncStatus
      }
    }

    expect(response.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.data.provider).toBe('jira')
    expect(body.data.backgroundSync.enabled).toBe(true)
    expect(body.data.backgroundSync.warm).toBe(true)
    expect(body.data.backgroundSync.lastSuccessAt).not.toBeNull()
    expect(body.data.providerSync.lastSyncAt).not.toBeNull()
    expect(syncCalls).toBeGreaterThanOrEqual(2)
  })
})

describe('startServer auth + CORS', () => {
  const TOKEN = 'secret-token'

  test('without a token, the API stays open (localhost default)', async () => {
    const runtime = startServer(makeProvider(), 0)
    runtimes.push(runtime)
    const res = await fetch(`http://127.0.0.1:${runtime.port}/api/bootstrap`)
    expect(res.status).toBe(200)
  })

  test('with a token, protected routes require Bearer auth', async () => {
    const runtime = startServer(makeProvider(), 0, { authToken: TOKEN })
    runtimes.push(runtime)

    const noAuth = await fetch(`http://127.0.0.1:${runtime.port}/api/bootstrap`)
    expect(noAuth.status).toBe(401)
    const noAuthBody = (await noAuth.json()) as { ok: boolean; error: { code: string } }
    expect(noAuthBody.ok).toBe(false)
    expect(noAuthBody.error.code).toBe('UNAUTHORIZED')

    const wrong = await fetch(`http://127.0.0.1:${runtime.port}/api/bootstrap`, {
      headers: { Authorization: 'Bearer nope' },
    })
    expect(wrong.status).toBe(401)

    const ok = await fetch(`http://127.0.0.1:${runtime.port}/api/bootstrap`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    expect(ok.status).toBe(200)
  })

  test('?token= does NOT authorize HTTP API routes (header only)', async () => {
    const runtime = startServer(makeProvider(), 0, { authToken: TOKEN })
    runtimes.push(runtime)
    const res = await fetch(`http://127.0.0.1:${runtime.port}/api/bootstrap?token=${TOKEN}`)
    expect(res.status).toBe(401)
  })

  test('/ws requires the token and accepts it as a query param', async () => {
    const runtime = startServer(makeProvider(), 0, { authToken: TOKEN })
    runtimes.push(runtime)

    // Plain GET (no upgrade) exercises the auth gate before the upgrade attempt.
    const noToken = await fetch(`http://127.0.0.1:${runtime.port}/ws`)
    expect(noToken.status).toBe(401)

    // Correct query token passes the gate; the non-WebSocket request then fails
    // the upgrade (400) rather than auth (401).
    const withToken = await fetch(`http://127.0.0.1:${runtime.port}/ws?token=${TOKEN}`)
    expect(withToken.status).not.toBe(401)
  })

  test('with a token, /api/health stays public', async () => {
    const runtime = startServer(makeProvider(), 0, { authToken: TOKEN })
    runtimes.push(runtime)
    const res = await fetch(`http://127.0.0.1:${runtime.port}/api/health`)
    expect(res.status).toBe(200)
  })

  test('with a token, webhook routes are exempt (provider secret guards them)', async () => {
    const runtime = startServer(
      makeProvider({
        type: 'local',
        async handleWebhook() {
          return { handled: true }
        },
      }),
      0,
      { authToken: TOKEN },
    )
    runtimes.push(runtime)
    const res = await fetch(`http://127.0.0.1:${runtime.port}/api/webhooks/local`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    // Reaches the provider handler instead of being rejected by bearer auth.
    expect(res.status).not.toBe(401)
  })

  test('a throwing provider webhook handler returns an enveloped 500, not a dropped connection', async () => {
    const runtime = startServer(
      makeProvider({
        type: 'local',
        async handleWebhook() {
          throw new Error('boom during webhook apply')
        },
      }),
      0,
      { authToken: TOKEN },
    )
    runtimes.push(runtime)
    const res = await fetch(`http://127.0.0.1:${runtime.port}/api/webhooks/local`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    const body = (await res.json()) as { ok: boolean; error: { code: string } }
    expect(res.status).toBe(500)
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('INTERNAL_ERROR')
  })

  test('F06: a `/kanban`-prefixed API path still enforces the auth gate (no prefix bypass)', async () => {
    const runtime = startServer(makeProvider(), 0, { authToken: TOKEN })
    runtimes.push(runtime)

    const noAuth = await fetch(`http://127.0.0.1:${runtime.port}/kanban/api/bootstrap`)
    expect(noAuth.status).toBe(401)

    const withAuth = await fetch(`http://127.0.0.1:${runtime.port}/kanban/api/bootstrap`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    expect(withAuth.status).toBe(200)

    // Health stays public under the prefix too.
    const health = await fetch(`http://127.0.0.1:${runtime.port}/kanban/api/health`)
    expect(health.status).toBe(200)
  })

  test('F13: a connected WS client receives task:upsert when a task is created via the API', async () => {
    const runtime = startServer(makeProvider(), 0)
    runtimes.push(runtime)

    const ws = new WebSocket(`ws://127.0.0.1:${runtime.port}/ws`)
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('ws connection failed'))
    })
    const received = new Promise<{
      type: string
      task?: { column_id?: string }
      columnId?: string
    }>((resolve, reject) => {
      ws.onmessage = (e) => resolve(JSON.parse(String(e.data)))
      // Fast-fail with a clear message instead of hanging until the global test
      // timeout if the broadcast never arrives (e.g. the socket was not yet
      // registered when the mutation fired).
      setTimeout(() => reject(new Error('timed out waiting for ws broadcast')), 4000)
    })
    try {
      // Let the open handler register the socket before the mutation broadcasts.
      await sleep(25)

      await fetch(`http://127.0.0.1:${runtime.port}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Broadcast me' }),
      })

      const msg = await received
      expect(msg.type).toBe('task:upsert')
      expect(msg.columnId).toBe('backlog')
    } finally {
      ws.close()
    }
  })

  test('wsClients are tracked per server instance, not shared globally', async () => {
    const a = startServer(makeProvider(), 0)
    runtimes.push(a)
    const b = startServer(makeProvider(), 0)
    runtimes.push(b)

    const ws = new WebSocket(`ws://127.0.0.1:${a.port}/ws`)
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('ws connection failed'))
    })
    // Let server A's open handler register the socket.
    await sleep(25)

    const healthA = (await (await fetch(`http://127.0.0.1:${a.port}/api/health`)).json()) as {
      data: { wsClients: number }
    }
    const healthB = (await (await fetch(`http://127.0.0.1:${b.port}/api/health`)).json()) as {
      data: { wsClients: number }
    }
    expect(healthA.data.wsClients).toBe(1)
    // Before per-instance scoping, B shared A's global set and also reported 1.
    expect(healthB.data.wsClients).toBe(0)
    ws.close()
  })

  test('CORS headers are emitted only when an allowed origin is configured', async () => {
    const withOrigin = startServer(makeProvider(), 0, {
      allowedOrigin: 'https://kanban.example',
    })
    runtimes.push(withOrigin)
    const res = await fetch(`http://127.0.0.1:${withOrigin.port}/api/health`)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://kanban.example')

    const preflight = await fetch(`http://127.0.0.1:${withOrigin.port}/api/bootstrap`, {
      method: 'OPTIONS',
    })
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://kanban.example')

    const noOrigin = startServer(makeProvider(), 0)
    runtimes.push(noOrigin)
    const bare = await fetch(`http://127.0.0.1:${noOrigin.port}/api/health`)
    expect(bare.headers.get('access-control-allow-origin')).toBeNull()
  })
})
