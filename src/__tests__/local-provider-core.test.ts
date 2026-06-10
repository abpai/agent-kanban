import { describe, expect, test } from 'bun:test'

import { ErrorCode, KanbanError } from '../errors'
import { LOCAL_CAPABILITIES } from '../providers/capabilities'
import {
  LocalProviderCore,
  type LocalStorePort,
  type LocalTaskRecord,
} from '../providers/local-core'
import type { BoardConfig, BoardMetrics, Column, TaskComment } from '../types'
import type { CreateTaskInput, TaskListFilters, UpdateTaskInput } from '../providers/types'

const column: Column = {
  id: 'c_1',
  name: 'backlog',
  position: 0,
  color: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
}

const metrics: BoardMetrics = {
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
}

const config: BoardConfig = {
  members: [],
  projects: [],
  provider: 'local',
  discoveredAssignees: [],
  discoveredProjects: [],
}

function localTask(overrides: Partial<LocalTaskRecord> = {}): LocalTaskRecord {
  return {
    id: 't_1',
    title: 'Local task',
    description: '',
    column_id: column.id,
    column_name: column.name,
    position: 0,
    priority: 'medium',
    assignee: 'amy',
    assignees: [],
    labels: [],
    comment_count: 0,
    project: '',
    metadata: '{}',
    revision: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    version: null,
    source_updated_at: null,
    ...overrides,
  }
}

class FakeLocalStore implements LocalStorePort {
  readonly capabilities = LOCAL_CAPABILITIES
  task = localTask()
  getTaskCalls = 0
  getTaskVersionCalls = 0
  updates: Array<Omit<UpdateTaskInput, 'expectedVersion'>> = []

  getBoard() {
    return { columns: [{ ...column, tasks: [this.task] }] }
  }

  listColumns() {
    return [column]
  }

  listTasks(_filters: TaskListFilters = {}) {
    return [this.task]
  }

  getTask(_idOrRef: string) {
    this.getTaskCalls += 1
    return this.task
  }

  getTaskVersion(_idOrRef: string) {
    this.getTaskVersionCalls += 1
    return String(this.task.revision ?? 0)
  }

  createTask(input: CreateTaskInput) {
    this.task = localTask({ title: input.title, revision: 0 })
    return this.task
  }

  updateTask(_idOrRef: string, input: Omit<UpdateTaskInput, 'expectedVersion'>) {
    this.updates.push(input)
    this.task = localTask({
      ...this.task,
      ...input,
      revision: (this.task.revision ?? 0) + 1,
    })
    return this.task
  }

  moveTask(_idOrRef: string, _column: string) {
    return this.task
  }

  deleteTask(_idOrRef: string) {
    return this.task
  }

  listComments(_idOrRef: string): TaskComment[] {
    return []
  }

  getComment(_idOrRef: string, commentId: string): TaskComment {
    return {
      id: commentId,
      task_id: this.task.id,
      body: '',
      author: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }
  }

  comment(_idOrRef: string, body: string): TaskComment {
    return {
      id: 'cm_1',
      task_id: this.task.id,
      body,
      author: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }
  }

  updateComment(_idOrRef: string, commentId: string, body: string): TaskComment {
    return {
      id: commentId,
      task_id: this.task.id,
      body,
      author: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    }
  }

  getActivity() {
    return []
  }

  getMetrics() {
    return metrics
  }

  getConfig() {
    return config
  }

  patchConfig() {
    return config
  }

  countComments() {
    return 2
  }

  countCommentsByTask() {
    return new Map([[this.task.id, 2]])
  }
}

describe('LocalProviderCore', () => {
  test('normalizes local task identity, comment count, labels, and version fields', async () => {
    const store = new FakeLocalStore()
    store.task = {
      ...localTask({ revision: 3 }),
      assignees: undefined,
      labels: undefined,
      comment_count: undefined,
      version: undefined,
      source_updated_at: undefined,
    } as unknown as LocalTaskRecord

    const provider = new LocalProviderCore(store)
    const task = await provider.getTask(store.task.id)

    expect(task.providerId).toBe('t_1')
    expect(task.externalRef).toBe('t_1')
    expect(task.url).toBeNull()
    expect(task.assignees).toEqual(['amy'])
    expect(task.labels).toEqual([])
    expect(task.comment_count).toBe(2)
    expect(task.version).toBe('3')
    expect(task.source_updated_at).toBeNull()
  })

  test('checks expectedVersion before store update and strips it from the store input', async () => {
    const store = new FakeLocalStore()
    store.task = localTask({ revision: 4 })
    const provider = new LocalProviderCore(store)

    const updated = await provider.updateTask(store.task.id, {
      title: 'Updated title',
      expectedVersion: '4',
    })

    expect(updated.title).toBe('Updated title')
    expect(store.updates).toEqual([{ title: 'Updated title' }])
    expect(Object.hasOwn(store.updates[0]!, 'expectedVersion')).toBe(false)
    expect(store.getTaskVersionCalls).toBe(1)
    expect(store.getTaskCalls).toBe(0)
  })

  test('rejects stale expectedVersion without calling the store update', async () => {
    const store = new FakeLocalStore()
    store.task = localTask({ revision: 4 })
    const provider = new LocalProviderCore(store)

    let err: unknown
    try {
      await provider.updateTask(store.task.id, {
        title: 'Stale update',
        expectedVersion: '3',
      })
    } catch (caught) {
      err = caught
    }

    expect(err).toBeInstanceOf(KanbanError)
    expect((err as KanbanError).code).toBe(ErrorCode.CONFLICT)
    expect(store.updates).toEqual([])
    expect(store.getTaskVersionCalls).toBe(1)
    expect(store.getTaskCalls).toBe(0)
  })
})
