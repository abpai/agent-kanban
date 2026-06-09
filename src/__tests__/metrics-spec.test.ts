import { describe, expect, test } from 'bun:test'
import { assembleBoardMetrics, classifyColumnRoles } from '../metrics-spec'
import type { ActivityEntry } from '../types'

const columnCounts = [
  { id: 'c1', name: 'Backlog', position: 0, count: 4 },
  { id: 'c2', name: 'In Progress', position: 1, count: 2 },
  { id: 'c3', name: 'Done', position: 2, count: 3 },
]

describe('assembleBoardMetrics', () => {
  test('normalizes priority order by severity regardless of input order', () => {
    const metrics = assembleBoardMetrics({
      columnCounts,
      // Deliberately unsorted / alphabetical-ish to prove the spec re-orders.
      priorityCounts: [
        { priority: 'low', count: 1 },
        { priority: 'urgent', count: 2 },
        { priority: 'medium', count: 3 },
        { priority: 'high', count: 4 },
      ],
      totalTasks: 9,
      tasksCreatedThisWeek: 5,
      avgCompletionHours: 12,
      recentActivity: [],
      assignees: ['amy'],
      projects: ['Dispatch'],
    })
    expect(metrics.tasksByPriority.map((row) => row.priority)).toEqual([
      'urgent',
      'high',
      'medium',
      'low',
    ])
  })

  test('derives completed / in-progress counts and completion percent from column roles', () => {
    const metrics = assembleBoardMetrics({
      columnCounts,
      priorityCounts: [],
      totalTasks: 9,
      tasksCreatedThisWeek: 0,
      avgCompletionHours: null,
      recentActivity: [],
      assignees: [],
      projects: [],
    })
    expect(metrics.completedTasks).toBe(3) // Done column
    expect(metrics.inProgressCount).toBe(2) // In Progress column
    expect(metrics.completionPercent).toBe(33) // round(3/9 * 100)
    expect(metrics.tasksByColumn).toEqual([
      { column_name: 'Backlog', count: 4 },
      { column_name: 'In Progress', count: 2 },
      { column_name: 'Done', count: 3 },
    ])
  })

  test('completion percent is zero when there are no tasks', () => {
    const metrics = assembleBoardMetrics({
      columnCounts: [{ id: 'c1', name: 'Backlog', position: 0, count: 0 }],
      priorityCounts: [],
      totalTasks: 0,
      tasksCreatedThisWeek: 0,
      avgCompletionHours: null,
      recentActivity: [],
      assignees: [],
      projects: [],
    })
    expect(metrics.completionPercent).toBe(0)
    expect(metrics.completedTasks).toBe(0)
  })

  test('passes through avg hours, activity, assignees, and projects unchanged', () => {
    const activity: ActivityEntry[] = [
      {
        id: 'a1',
        task_id: 't1',
        action: 'created',
        field_changed: null,
        old_value: null,
        new_value: 'Task',
        timestamp: '2026-01-01T00:00:00Z',
      },
    ]
    const metrics = assembleBoardMetrics({
      columnCounts,
      priorityCounts: [],
      totalTasks: 9,
      tasksCreatedThisWeek: 5,
      avgCompletionHours: 7.5,
      recentActivity: activity,
      assignees: ['amy', 'bob'],
      projects: ['Dispatch'],
    })
    expect(metrics.avgCompletionHours).toBe(7.5)
    expect(metrics.recentActivity).toBe(activity)
    expect(metrics.tasksCreatedThisWeek).toBe(5)
    expect(metrics.assignees).toEqual(['amy', 'bob'])
    expect(metrics.projects).toEqual(['Dispatch'])
  })
})

describe('classifyColumnRoles', () => {
  test('recognizes done/in-progress synonyms and falls back to the terminal column', () => {
    const roles = classifyColumnRoles([
      { id: 'c1', name: 'Backlog', position: 0 },
      { id: 'c2', name: 'WIP', position: 1 },
      { id: 'c3', name: 'Shipped', position: 2 },
    ])
    expect(roles.doneColumnIds).toEqual(['c3'])
    expect(roles.inProgressColumnIds).toEqual(['c2'])
  })

  test('falls back to the last column when no name reads as done', () => {
    const roles = classifyColumnRoles([
      { id: 'c1', name: 'Backlog', position: 0 },
      { id: 'c2', name: 'Later', position: 1 },
    ])
    expect(roles.doneColumnIds).toEqual(['c2'])
  })
})
