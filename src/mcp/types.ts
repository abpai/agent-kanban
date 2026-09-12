import type { JsonSchemaType, ToolAnnotations } from '@modelcontextprotocol/server'
import type { Task, TaskComment } from '../types'
import type { TrackerMcpError, TrackerMcpErrorCode } from './errors'

export type TrackerMcpAuthResolver<TScope> = (ctx: {
  request: Request
  url: URL
  headers: globalThis.Headers
}) => Promise<TScope>

export interface TrackerMcpPolicy<TScope> {
  canReadTicket(scope: TScope, ticketId: string): Promise<void> | void
  canPostComment(scope: TScope, ticketId: string, body: string): Promise<void> | void
  canUpdateComment(
    scope: TScope,
    ticketId: string,
    comment: TaskComment,
    body: string,
  ): Promise<void> | void
  canMoveTicket(scope: TScope, ticketId: string, destinationColumn: string): Promise<void> | void
  filterComment?(scope: TScope, comment: TaskComment): Promise<boolean> | boolean
  /**
   * Gate the aggregate board read. Throw to deny access to the whole board.
   * Omit to allow board reads (individual tickets can still be hidden via `filterTask`).
   */
  canReadBoard?(scope: TScope): Promise<void> | void
  /**
   * Decide whether a single board task is visible to this scope. Return `false`
   * to drop it from `getBoard`. Without this, the board exposes every ticket,
   * bypassing per-ticket `canReadTicket` gates.
   */
  filterTask?(scope: TScope, task: Task): Promise<boolean> | boolean
}

export interface TrackerMcpHooks<TScope> {
  onAuthFailure?(event: {
    request: Request
    durationMs: number
    errorCode: 'auth_failed'
    error: TrackerMcpError
  }): Promise<void> | void

  onToolStart?(event: { scope: TScope; tool: string; ticketId?: string }): Promise<void> | void

  onToolResult?(event: {
    scope: TScope
    tool: string
    ticketId?: string
    durationMs: number
    // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Hook metadata is an extensible public contract supplied by custom tool implementations.
    result?: Record<string, unknown>
  }): Promise<void> | void

  onToolError?(event: {
    scope: TScope | null
    tool: string
    ticketId?: string
    durationMs: number
    errorCode: TrackerMcpErrorCode
    error: TrackerMcpError
  }): Promise<void> | void
}

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Custom tool argument keys and values are defined by each registered JSON Schema.
interface TrackerMcpToolHandlerContext<TScope, TArgs = Record<string, unknown>> {
  scope: TScope
  args: TArgs
  request?: Request
}

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Custom tool argument keys and values are defined by each registered JSON Schema.
export interface TrackerMcpTool<TScope, TArgs = Record<string, unknown>, TResult = unknown> {
  name: string
  description?: string
  inputSchema: JsonSchemaType
  annotations?: ToolAnnotations
  /** Validates the raw handler result; discovery wraps it under structuredContent.result. */
  outputSchema?: JsonSchemaType
  handler(input: TrackerMcpToolHandlerContext<TScope, TArgs>): Promise<TResult> | TResult
}

export interface TrackerMcpServer {
  fetch(req: Request): Promise<Response>
  selfPing(): Promise<void>
  close(signal?: globalThis.AbortSignal): Promise<void>
}
