import { describe, expect, test } from 'bun:test'
import { replaceTask, upsertTaskInColumn } from '../../ui/src/components/boardUtils'
import type { BoardView, Task } from '../../ui/src/types'

function makeTask(
  overrides: Partial<Task> & Pick<Task, 'id' | 'title' | 'column_id' | 'position'>,
): Task {
  const { id, title, column_id, position, ...rest } = overrides
  return {
    id,
    providerId: id,
    externalRef: id,
    url: null,
    title,
    description: '',
    column_id,
    position,
    priority: 'medium',
    assignee: '',
    assignees: [],
    labels: [],
    comment_count: 0,
    project: '',
    metadata: '{}',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    version: '0',
    source_updated_at: null,
    ...rest,
  }
}

function makeBoard(): BoardView {
  return {
    columns: [
      {
        id: 'c-backlog',
        name: 'backlog',
        position: 0,
        color: null,
        created_at: '',
        updated_at: '',
        tasks: [
          makeTask({ id: 't-1', title: 'First', column_id: 'c-backlog', position: 0 }),
          makeTask({ id: 'tmp-1', title: 'Temp', column_id: 'c-backlog', position: 1 }),
          makeTask({ id: 't-2', title: 'Second', column_id: 'c-backlog', position: 2 }),
        ],
      },
      {
        id: 'c-done',
        name: 'done',
        position: 1,
        color: null,
        created_at: '',
        updated_at: '',
        tasks: [],
      },
    ],
  }
}

describe('boardUtils', () => {
  test('replaceTask removes duplicate real task ids when resolving an optimistic create', () => {
    const board = makeBoard()
    const withWsInsertedReal: BoardView = {
      columns: board.columns.map((column) =>
        column.id === 'c-backlog'
          ? {
              ...column,
              tasks: [
                ...column.tasks,
                makeTask({ id: 't-real', title: 'Created', column_id: 'c-backlog', position: 1 }),
              ],
            }
          : column,
      ),
    }

    const nextBoard = replaceTask(
      withWsInsertedReal,
      'tmp-1',
      makeTask({ id: 't-real', title: 'Created', column_id: 'c-backlog', position: 1 }),
    )

    expect(nextBoard.columns[0]!.tasks.map((task) => task.id)).toEqual(['t-1', 't-real', 't-2'])
  })

  test('upsertTaskInColumn preserves same-column ordering for in-place edits', () => {
    const board = makeBoard()

    const nextBoard = upsertTaskInColumn(
      board,
      makeTask({ id: 't-1', title: 'First edited', column_id: 'c-backlog', position: 0 }),
      'backlog',
    )

    expect(nextBoard.columns[0]!.tasks.map((task) => task.id)).toEqual(['t-1', 'tmp-1', 't-2'])
    expect(nextBoard.columns[0]!.tasks[0]!.title).toBe('First edited')
  })
})
