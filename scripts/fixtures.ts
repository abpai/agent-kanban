import type { Database } from 'bun:sqlite'
import type { Priority } from '../src/types'
import { addTask, listTasks, moveTask, updateTask } from '../src/db'

interface FixtureTask {
  title: string
  description?: string
  column: string
  priority: Priority
  assignee?: string
  project?: string
}

const FIXTURE_TASKS: FixtureTask[] = [
  {
    title: 'Daily standup notes',
    description: 'Capture blockers and progress each morning',
    column: 'recurring',
    priority: 'medium',
    assignee: 'Alex',
  },
  {
    title: 'Weekly metrics review',
    description: 'Review board throughput and cycle time every Friday',
    column: 'recurring',
    priority: 'low',
    assignee: 'BuildBot',
    project: 'Platform',
  },
  {
    title: 'Add search functionality',
    description: 'Full-text search across task titles and descriptions',
    column: 'backlog',
    priority: 'high',
    assignee: 'Alex',
    project: 'Platform',
  },
  {
    title: 'Write API docs',
    description: 'Document all CLI commands with examples',
    column: 'backlog',
    priority: 'medium',
    assignee: 'BuildBot',
  },
  {
    title: 'Refactor error handling',
    description: 'Consolidate error codes and improve user-facing messages',
    column: 'backlog',
    priority: 'low',
    project: 'Platform',
  },
  {
    title: 'Implement board export',
    description: 'Export board state to JSON and CSV formats',
    column: 'in-progress',
    priority: 'high',
    assignee: 'Alex',
    project: 'Platform',
  },
  {
    title: 'Fix column reorder bug',
    description: 'Columns shift incorrectly when moving to position 0',
    column: 'in-progress',
    priority: 'high',
    assignee: 'BuildBot',
  },
  {
    title: 'Add bulk delete command',
    description: 'Allow deleting multiple tasks by ID or filter',
    column: 'review',
    priority: 'medium',
    assignee: 'Alex',
    project: 'Platform',
  },
  {
    title: 'Set up CI pipeline',
    description: 'GitHub Actions for lint, typecheck, and test on every PR',
    column: 'done',
    priority: 'high',
    assignee: 'BuildBot',
    project: 'Platform',
  },
  {
    title: 'Add activity logging',
    description: 'Track task creates, moves, updates, and deletes',
    column: 'done',
    priority: 'medium',
    assignee: 'Alex',
  },
]

export function seedFixtures(db: Database): { taskCount: number; movedCount: number } {
  let movedCount = 0

  for (const fixture of FIXTURE_TASKS) {
    const task = addTask(db, fixture.title, {
      description: fixture.description,
      priority: fixture.priority,
      assignee: fixture.assignee,
      project: fixture.project,
    })

    if (fixture.column !== 'backlog') {
      moveTask(db, task.id, fixture.column)
      movedCount++
    }
  }

  const inProgress = listTasks(db, { column: 'in-progress' })
  const bug = inProgress.find((task) => task.title === 'Fix column reorder bug')
  if (bug) {
    updateTask(db, bug.id, { priority: 'urgent' })
  }

  return { taskCount: FIXTURE_TASKS.length, movedCount }
}
