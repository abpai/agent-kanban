import { afterEach, describe, expect, test } from 'bun:test'
import type {
  BoardBootstrap,
  BoardConfig,
  BoardMetrics,
  BoardView,
  Column,
  Task,
} from '../types.ts'
import { startServer, type StartedServer } from '../server.ts'
import type {
  CreateTaskInput,
  KanbanProvider,
  ProviderContext,
  ProviderSyncStatus,
  TaskListFilters,
  UpdateTaskInput,
} from '../providers/types.ts'

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
