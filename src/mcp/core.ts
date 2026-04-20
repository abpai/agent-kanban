import type { KanbanProvider } from '../providers/types.ts'
import type { Task, TaskComment } from '../types.ts'
import { TrackerMcpError, toTrackerMcpError } from './errors.ts'
import type { TrackerMcpHooks, TrackerMcpPolicy } from './types.ts'

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
          execute: async () => provider.getBoard(),
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
