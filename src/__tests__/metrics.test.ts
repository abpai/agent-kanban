import { describe, expect, test, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initSchema, seedDefaultColumns, addTask } from '../db.ts'
import { getBoardMetrics } from '../metrics.ts'

let db: Database

beforeEach(() => {
  db = new Database(':memory:')
  db.run('PRAGMA foreign_keys = ON')
  initSchema(db)
  seedDefaultColumns(db)
})

describe('getBoardMetrics', () => {
  test('returns tasks per column', () => {
    addTask(db, 'A', { column: 'recurring' })
    addTask(db, 'B', { column: 'recurring' })
    addTask(db, 'C', { column: 'backlog' })
    const metrics = getBoardMetrics(db)
    expect(metrics.tasksByColumn.find((c) => c.column_name === 'recurring')!.count).toBe(2)
    expect(metrics.tasksByColumn.find((c) => c.column_name === 'backlog')!.count).toBe(1)
    expect(metrics.tasksByColumn.find((c) => c.column_name === 'done')!.count).toBe(0)
  })

  test('returns tasks by priority', () => {
    addTask(db, 'Urgent', { priority: 'urgent' })
    addTask(db, 'High', { priority: 'high' })
    addTask(db, 'Low', { priority: 'low' })
    const metrics = getBoardMetrics(db)
    expect(metrics.tasksByPriority.find((p) => p.priority === 'urgent')!.count).toBe(1)
    expect(metrics.tasksByPriority.find((p) => p.priority === 'high')!.count).toBe(1)
  })

  test('returns total and completed counts', () => {
    addTask(db, 'A', { column: 'recurring' })
    addTask(db, 'B', { column: 'done' })
    addTask(db, 'C', { column: 'done' })
    const metrics = getBoardMetrics(db)
    expect(metrics.totalTasks).toBe(3)
    expect(metrics.completedTasks).toBe(2)
  })

  test('returns null avg completion when no data', () => {
    const metrics = getBoardMetrics(db)
    expect(metrics.avgCompletionHours).toBeNull()
  })

  test('returns recent activity', () => {
    addTask(db, 'A')
    addTask(db, 'B')
    const metrics = getBoardMetrics(db)
    expect(metrics.recentActivity.length).toBeGreaterThanOrEqual(2)
    expect(metrics.recentActivity[0]!.action).toBe('created')
  })

  test('works with empty board', () => {
    const metrics = getBoardMetrics(db)
    expect(metrics.totalTasks).toBe(0)
    expect(metrics.completedTasks).toBe(0)
    expect(metrics.tasksByColumn).toHaveLength(5)
    expect(metrics.tasksByPriority).toHaveLength(0)
  })
})
