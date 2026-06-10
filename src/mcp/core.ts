import type { KanbanProvider } from '../providers/types'
import type { BoardView, Task, TaskComment } from '../types'
import { TrackerMcpError, toTrackerMcpError } from './errors'
import type { TrackerMcpHooks, TrackerMcpPolicy } from './types'

export interface TrackerCore<TScope> {
  notifyAuthFailure(input: {
    request: Request
    durationMs: number
    error: TrackerMcpError
  }): Promise<void>
  notifyToolError(input: {
    scope: TScope | null
    tool: string
    ticketId?: string
    durationMs: number
    error: TrackerMcpError
  }): Promise<void>
  handlers: {
    getTicket(input: { scope: TScope; ticketId: string }): Promise<Task>
    listComments(input: { scope: TScope; ticketId: string }): Promise<TaskComment[]>
    getBoard(input: { scope: TScope }): Promise<Awaited<ReturnType<KanbanProvider['getBoard']>>>
    postComment(input: { scope: TScope; ticketId: string; body: string }): Promise<TaskComment>
    updateComment(input: {
      scope: TScope
      ticketId: string
      commentId: string
      body: string
    }): Promise<TaskComment>
    moveTicket(input: { scope: TScope; ticketId: string; column: string }): Promise<void>
  }
}

interface RunToolInput<TScope, TResult> {
  scope: TScope
  tool: string
  ticketId?: string
  execute(): Promise<TResult>
  resultMeta?: Record<string, unknown> | ((result: TResult) => Record<string, unknown> | undefined)
}

async function filterComments<TScope>(
  scope: TScope,
  comments: TaskComment[],
  policy: TrackerMcpPolicy<TScope>,
): Promise<TaskComment[]> {
  if (!policy.filterComment) return comments
  const allowed = await Promise.all(
    comments.map((comment) => policy.filterComment!(scope, comment)),
  )
  return comments.filter((_, index) => allowed[index])
}

async function filterBoard<TScope>(
  scope: TScope,
  board: BoardView,
  policy: TrackerMcpPolicy<TScope>,
): Promise<BoardView> {
  if (!policy.filterTask) return board
  const columns = await Promise.all(
    board.columns.map(async (column) => {
      const allowed = await Promise.all(column.tasks.map((task) => policy.filterTask!(scope, task)))
      return { ...column, tasks: column.tasks.filter((_, index) => allowed[index]) }
    }),
  )
  return { ...board, columns }
}

export function createTrackerCore<TScope>(input: {
  provider: KanbanProvider
  policy: TrackerMcpPolicy<TScope>
  hooks?: TrackerMcpHooks<TScope>
}): TrackerCore<TScope> {
  const { provider, policy } = input
  const hooks = input.hooks ?? {}

  async function runTool<TResult>({
    scope,
    tool,
    ticketId,
    execute,
    resultMeta,
  }: RunToolInput<TScope, TResult>): Promise<TResult> {
    const startedAt = Date.now()
    await hooks.onToolStart?.({ scope, tool, ticketId })
    try {
      const result = await execute()
      const hookResult = typeof resultMeta === 'function' ? resultMeta(result) : resultMeta
      await hooks.onToolResult?.({
        scope,
        tool,
        ticketId,
        durationMs: Date.now() - startedAt,
        result: hookResult,
      })
      return result
    } catch (error) {
      const trackerError = toTrackerMcpError(error)
      await hooks.onToolError?.({
        scope,
        tool,
        ticketId,
        durationMs: Date.now() - startedAt,
        errorCode: trackerError.code,
        error: trackerError,
      })
      throw trackerError
    }
  }

  return {
    async notifyAuthFailure({ request, durationMs, error }) {
      await hooks.onAuthFailure?.({
        request,
        durationMs,
        errorCode: 'auth_failed',
        error,
      })
    },

    async notifyToolError({ scope, tool, ticketId, durationMs, error }) {
      await hooks.onToolError?.({
        scope,
        tool,
        ticketId,
        durationMs,
        errorCode: error.code,
        error,
      })
    },

    handlers: {
      getTicket({ scope, ticketId }) {
        return runTool({
          scope,
          tool: 'getTicket',
          ticketId,
          execute: async () => {
            await policy.canReadTicket(scope, ticketId)
            return provider.getTask(ticketId)
          },
        })
      },

      listComments({ scope, ticketId }) {
        return runTool({
          scope,
          tool: 'listComments',
          ticketId,
          execute: async () => {
            await policy.canReadTicket(scope, ticketId)
            const comments = await provider.listComments(ticketId)
            return filterComments(scope, comments, policy)
          },
          resultMeta: (comments) => ({ commentCount: comments.length }),
        })
      },

      getBoard({ scope }) {
        return runTool({
          scope,
          tool: 'getBoard',
          execute: async () => {
            await policy.canReadBoard?.(scope)
            const board = await provider.getBoard()
            return filterBoard(scope, board, policy)
          },
          resultMeta: (board) => ({
            taskCount: board.columns.reduce((total, column) => total + column.tasks.length, 0),
          }),
        })
      },

      postComment({ scope, ticketId, body }) {
        return runTool({
          scope,
          tool: 'postComment',
          ticketId,
          execute: async () => {
            await policy.canPostComment(scope, ticketId, body)
            return provider.comment(ticketId, body)
          },
          resultMeta: (comment) => ({ commentId: comment.id }),
        })
      },

      updateComment({ scope, ticketId, commentId, body }) {
        return runTool({
          scope,
          tool: 'updateComment',
          ticketId,
          execute: async () => {
            const existing = await provider.getComment(ticketId, commentId)
            await policy.canUpdateComment(scope, ticketId, existing, body)
            return provider.updateComment(ticketId, commentId, body)
          },
          resultMeta: (comment) => ({ commentId: comment.id }),
        })
      },

      moveTicket({ scope, ticketId, column }) {
        return runTool({
          scope,
          tool: 'moveTicket',
          ticketId,
          execute: async () => {
            await policy.canMoveTicket(scope, ticketId, column)
            await provider.moveTask(ticketId, column)
          },
          resultMeta: { movedTo: column },
        })
      },
    },
  }
}
