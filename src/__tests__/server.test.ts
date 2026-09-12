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

async function connectSocket(runtime: StartedServer) {
  const socket = new WebSocket(`ws://127.0.0.1:${runtime.port}/ws`)
  const messages: string[] = []
  socket.addEventListener('message', (event) => messages.push(String(event.data)))
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error('ws connection failed')), {
      once: true,
    })
  })
  return { socket, messages }
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return
  await new Promise<void>((resolve) => {
    socket.addEventListener('close', () => resolve(), { once: true })
    socket.close()
  })
}

async function expectSocketCount(runtime: StartedServer, count: number): Promise<void> {
  for (const path of ['/api/health', '/api/sync-status']) {
    const response = await fetch(`http://127.0.0.1:${runtime.port}${path}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toHaveProperty('data.wsClients', count)
  }
}

async function waitForMessages(messages: string[], count: number): Promise<void> {
  const deadline = Date.now() + 1000
  while (messages.length < count && Date.now() < deadline) {
    await sleep(5)
  }
  expect(messages).toHaveLength(count)
}

async function createTask(runtime: StartedServer): Promise<Response> {
  return fetch(`http://127.0.0.1:${runtime.port}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Broadcast me' }),
  })
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
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toHaveProperty('ok', true)
    expect(body).toHaveProperty('data.provider', 'local')
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
    const body = await response.json()
    expect(body).toHaveProperty('ok', true)
    expect(body).toHaveProperty('data.ready', true)
    expect(body).toHaveProperty('data.backgroundSync.warm', true)
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
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toHaveProperty('ok', true)
    expect(body).toHaveProperty('data.provider', 'jira')
    expect(body).toHaveProperty('data.backgroundSync.enabled', true)
    expect(body).toHaveProperty('data.backgroundSync.warm', true)
    expect(body).toHaveProperty('data.backgroundSync.lastSuccessAt', expect.any(String))
    expect(body).toHaveProperty('data.providerSync.lastSyncAt', expect.any(String))
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
    const noAuthBody = await noAuth.json()
    expect(noAuthBody).toHaveProperty('ok', false)
    expect(noAuthBody).toHaveProperty('error.code', 'UNAUTHORIZED')

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
    const body = await res.json()
    expect(res.status).toBe(500)
    expect(body).toHaveProperty('ok', false)
    expect(body).toHaveProperty('error.code', 'INTERNAL_ERROR')
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

  test('F13: task events reach every connected client only on the mutated server', async () => {
    const taskA = noopTask()
    const taskB = { ...noopTask(), id: 'server-b-task' }
    const a = startServer(makeProvider(), 0)
    runtimes.push(a)
    const b = startServer(
      makeProvider({
        async createTask() {
          return taskB
        },
      }),
      0,
    )
    runtimes.push(b)

    const a1 = await connectSocket(a)
    const a2 = await connectSocket(a)
    const b1 = await connectSocket(b)
    try {
      await expectSocketCount(a, 2)
      await expectSocketCount(b, 1)

      expect((await createTask(a)).status).toBe(200)
      await Promise.all([waitForMessages(a1.messages, 1), waitForMessages(a2.messages, 1)])
      const eventA = { type: 'task:upsert', task: taskA, columnId: 'backlog' }
      expect(a1.messages.map((message) => JSON.parse(message))).toEqual([eventA])
      expect(a2.messages.map((message) => JSON.parse(message))).toEqual([eventA])
      expect(b1.messages).toEqual([])

      expect((await createTask(b)).status).toBe(200)
      await waitForMessages(b1.messages, 1)
      const eventB = { type: 'task:upsert', task: taskB, columnId: 'backlog' }
      expect(b1.messages.map((message) => JSON.parse(message))).toEqual([eventB])

      await closeSocket(a1.socket)
      await expectSocketCount(a, 1)
      await expectSocketCount(b, 1)
      expect((await createTask(a)).status).toBe(200)
      await waitForMessages(a2.messages, 2)
      expect(a1.messages.map((message) => JSON.parse(message))).toEqual([eventA])
      expect(a2.messages.map((message) => JSON.parse(message))).toEqual([eventA, eventA])
      expect(b1.messages.map((message) => JSON.parse(message))).toEqual([eventB])

      await closeSocket(a2.socket)
      await expectSocketCount(a, 0)
      await expectSocketCount(b, 1)
      await closeSocket(b1.socket)
      await expectSocketCount(b, 0)
    } finally {
      await Promise.all([a1, a2, b1].map(({ socket }) => closeSocket(socket)))
    }
  })

  test('stop(false) lets an in-flight mutation finish without broadcasting afterward', async () => {
    const mutationStarted = Promise.withResolvers<void>()
    const completeMutation = Promise.withResolvers<void>()
    const runtime = startServer(
      makeProvider({
        async createTask() {
          mutationStarted.resolve()
          await completeMutation.promise
          return noopTask()
        },
      }),
      0,
    )
    runtimes.push(runtime)
    const client = await connectSocket(runtime)
    try {
      await expectSocketCount(runtime, 1)
      const response = createTask(runtime)
      await mutationStarted.promise
      runtime.stop(false)
      completeMutation.resolve()
      expect((await response).status).toBe(200)
      // Allow a late broadcast to arrive while the graceful-stop socket stays open.
      await sleep(25)
      expect(client.socket.readyState).toBe(WebSocket.OPEN)
      expect(client.messages).toEqual([])
    } finally {
      completeMutation.resolve()
      await closeSocket(client.socket)
    }
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
