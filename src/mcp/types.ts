import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation'
import type { TaskComment } from '../types.ts'
import type { TrackerMcpError, TrackerMcpErrorCode } from './errors.ts'

export type TrackerMcpScope = Record<string, unknown>

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

export interface TrackerMcpToolHandlerContext<TScope, TArgs = Record<string, unknown>> {
  scope: TScope
  args: TArgs
  request: Request
}

export interface TrackerMcpTool<TScope, TArgs = Record<string, unknown>, TResult = unknown> {
  name: string
  description?: string
  inputSchema: JsonSchemaType
  annotations?: ToolAnnotations
  outputSchema?: JsonSchemaType
  handler(input: TrackerMcpToolHandlerContext<TScope, TArgs>): Promise<TResult> | TResult
}

export interface TrackerMcpServer {
  fetch(req: Request): Promise<Response>
  selfPing(): Promise<void>
  close(signal?: globalThis.AbortSignal): Promise<void>
}
