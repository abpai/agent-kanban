import { beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { addTask, initSchema, seedDefaultColumns } from '../db'
import { createTrackerCore } from '../mcp/core'
import { TrackerMcpError } from '../mcp/errors'
import { LocalProvider } from '../providers/local'

interface TestScope {
  actor: string
}

let db: Database
let provider: LocalProvider

beforeEach(() => {
  db = new Database(':memory:')
  db.run('PRAGMA foreign_keys = ON')
  initSchema(db)
  seedDefaultColumns(db)
  provider = new LocalProvider(db, ':memory:')
})

describe('createTrackerCore', () => {
  test('runs allowed handlers and reports hook metadata', async () => {
    const task = addTask(db, 'Core task')
    const hookEvents: Array<{ tool: string; result?: Record<string, unknown> }> = []
    const core = createTrackerCore<TestScope>({
      provider,
      policy: {
        canReadTicket() {},
        canPostComment() {},
        canUpdateComment() {},
        canMoveTicket() {},
      },
      hooks: {
        onToolResult(event) {
          hookEvents.push({ tool: event.tool, result: event.result })
        },
      },
    })

    const created = await core.handlers.postComment({
      scope: { actor: 'agent' },
      ticketId: task.id,
      body: 'hello from core',
    })
    const updated = await core.handlers.updateComment({
      scope: { actor: 'agent' },
      ticketId: task.id,
      commentId: created.id,
      body: 'edited by core',
    })
    const comments = await core.handlers.listComments({
      scope: { actor: 'agent' },
      ticketId: task.id,
    })
    await core.handlers.moveTicket({
      scope: { actor: 'agent' },
      ticketId: task.id,
      column: 'in-progress',
    })

    const inProgressColumn = (await provider.listColumns()).find(
      (column) => column.name.toLowerCase() === 'in-progress',
    )

    expect(updated.body).toBe('edited by core')
    expect(comments).toHaveLength(1)
    expect(inProgressColumn).toBeDefined()
    expect((await provider.getTask(task.id)).column_id).toBe(inProgressColumn!.id)
    expect(hookEvents).toEqual([
      { tool: 'postComment', result: { commentId: created.id } },
      { tool: 'updateComment', result: { commentId: created.id } },
      { tool: 'listComments', result: { commentCount: 1 } },
      { tool: 'moveTicket', result: { movedTo: 'in-progress' } },
    ])
  })

  test('passes the existing comment to update policy and filters listed comments via policy', async () => {
    const task = addTask(db, 'Core task')
    const first = await provider.comment(task.id, 'visible comment')
    await provider.comment(task.id, 'hidden comment')
    let seenCommentId: string | null = null
    let seenCommentBody: string | null = null

    const core = createTrackerCore<TestScope>({
      provider,
      policy: {
        canReadTicket() {},
        canPostComment() {},
        canUpdateComment(_scope, _ticketId, comment) {
          seenCommentId = comment.id
          seenCommentBody = comment.body
        },
        canMoveTicket() {},
        filterComment(_scope, comment) {
          return comment.body.startsWith('visible')
        },
      },
    })

    const comments = await core.handlers.listComments({
      scope: { actor: 'agent' },
      ticketId: task.id,
    })
    await core.handlers.updateComment({
      scope: { actor: 'agent' },
      ticketId: task.id,
      commentId: first.id,
      body: 'edited comment',
    })

    expect(comments.map((comment) => comment.body)).toEqual(['visible comment'])
    expect(seenCommentId === first.id).toBe(true)
    expect(seenCommentBody === 'visible comment').toBe(true)
  })

  test('normalizes policy denials into TrackerMcpError and reports them through hooks', async () => {
    const task = addTask(db, 'Core task')
    const toolErrors: Array<{ tool: string; code: string; message?: string }> = []
    const core = createTrackerCore<TestScope>({
      provider,
      policy: {
        canReadTicket() {},
        canPostComment() {},
        canUpdateComment() {},
        canMoveTicket() {
          throw new TrackerMcpError({
            code: 'policy_denied',
            publicMessage: 'forbidden_column',
          })
        },
      },
      hooks: {
        onToolError(event) {
          toolErrors.push({
            tool: event.tool,
            code: event.errorCode,
            message: event.error.publicMessage,
          })
        },
      },
    })

    await expect(
      core.handlers.moveTicket({
        scope: { actor: 'agent' },
        ticketId: task.id,
        column: 'done',
      }),
    ).rejects.toMatchObject({
      code: 'policy_denied',
      publicMessage: 'forbidden_column',
    })

    expect(toolErrors).toEqual([
      {
        tool: 'moveTicket',
        code: 'policy_denied',
        message: 'forbidden_column',
      },
    ])
  })
})
