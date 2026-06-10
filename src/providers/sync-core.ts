import type { Task } from '../types'
import type { ProviderSyncStatus, TaskListFilters } from './types'

export function parseSyncTimestamp(value: string | null | undefined): number {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function maxSyncTimestamp(
  a: string | null | undefined,
  b: string | null | undefined,
): string | null {
  const aMs = parseSyncTimestamp(a)
  const bMs = parseSyncTimestamp(b)
  if (!aMs && !bMs) return null
  return aMs >= bMs ? (a ?? null) : (b ?? null)
}

export class SyncGate {
  private backgroundManaged = false

  constructor(private readonly pollingSyncIntervalMs: number) {}

  shouldSkip(params: {
    force: boolean
    viaWarmer: boolean
    lastSyncAt: string | null | undefined
    now?: number
  }): boolean {
    const lastSyncAtMs = parseSyncTimestamp(params.lastSyncAt)
    if (this.backgroundManaged && !params.force && !params.viaWarmer && lastSyncAtMs > 0) {
      return true
    }
    const now = params.now ?? Date.now()
    return !params.force && lastSyncAtMs > 0 && now - lastSyncAtMs < this.pollingSyncIntervalMs
  }

  setBackgroundManaged(managed: boolean): void {
    this.backgroundManaged = managed
  }
}

export function syncStatusFromMeta(meta: {
  lastSyncAt: string | null
  lastFullSyncAt: string | null
  lastWebhookAt: string | null
}): ProviderSyncStatus {
  return {
    lastSyncAt: meta.lastSyncAt,
    lastFullSyncAt: meta.lastFullSyncAt,
    lastWebhookAt: meta.lastWebhookAt,
  }
}

export function applyTaskFilters(tasks: Task[], filters: TaskListFilters = {}): Task[] {
  let result = tasks
  if (filters.priority) result = result.filter((task) => task.priority === filters.priority)
  if (filters.assignee) result = result.filter((task) => task.assignee === filters.assignee)
  if (filters.project) result = result.filter((task) => task.project === filters.project)
  if (filters.sort === 'title') {
    result = [...result].sort((a, b) => a.title.localeCompare(b.title))
  }
  if (filters.sort === 'updated') {
    result = [...result].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  }
  if (filters.limit) result = result.slice(0, filters.limit)
  return result
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (concurrency < 1) throw new RangeError('concurrency must be at least 1')
  const results: R[] = []
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency)
    results.push(...(await Promise.all(batch.map((item, offset) => mapper(item, i + offset)))))
  }
  return results
}

export async function forEachWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  await mapWithConcurrency(items, concurrency, worker)
}
