import { McpError, ErrorCode as JsonRpcErrorCode } from '@modelcontextprotocol/sdk/types.js'
import { ErrorCode, type ErrorCodeValue, KanbanError } from '../errors'

export type TrackerMcpErrorCode =
  | 'auth_failed'
  | 'policy_denied'
  | 'ticket_not_found'
  | 'comment_not_found'
  | 'validation_failed'
  | 'provider_unavailable'
  | 'internal_error'

export class TrackerMcpError extends Error {
  override readonly name = 'TrackerMcpError'
  readonly code: TrackerMcpErrorCode
  override readonly cause?: unknown
  readonly publicMessage?: string

  constructor(input: {
    code: TrackerMcpErrorCode
    message?: string
    publicMessage?: string
    cause?: unknown
  }) {
    super(input.message ?? input.publicMessage ?? input.code)
    this.code = input.code
    this.cause = input.cause
    this.publicMessage = input.publicMessage
  }
}

function providerError(code: ErrorCodeValue): TrackerMcpErrorCode {
  switch (code) {
    case ErrorCode.TASK_NOT_FOUND:
      return 'ticket_not_found'
    case ErrorCode.COMMENT_NOT_FOUND:
      return 'comment_not_found'
    case ErrorCode.COLUMN_NOT_FOUND:
    case ErrorCode.INVALID_METADATA:
    case ErrorCode.INVALID_POSITION:
    case ErrorCode.INVALID_PRIORITY:
    case ErrorCode.MISSING_ARGUMENT:
    case ErrorCode.UNSUPPORTED_OPERATION:
    case ErrorCode.CONFLICT:
      return 'validation_failed'
    case ErrorCode.PROVIDER_AUTH_FAILED:
    case ErrorCode.PROVIDER_RATE_LIMITED:
    case ErrorCode.PROVIDER_UPSTREAM_ERROR:
    case ErrorCode.PROVIDER_SYNC_REQUIRED:
    case ErrorCode.PROVIDER_NOT_CONFIGURED:
      return 'provider_unavailable'
    default:
      return 'internal_error'
  }
}

export function toTrackerMcpError(error: unknown): TrackerMcpError {
  if (error instanceof TrackerMcpError) return error
  if (error instanceof KanbanError) {
    return new TrackerMcpError({
      code: providerError(error.code),
      message: error.message,
      publicMessage: error.message,
      cause: error,
    })
  }
  if (error instanceof Error) {
    return new TrackerMcpError({
      code: 'internal_error',
      message: error.message,
      publicMessage: error.message,
      cause: error,
    })
  }
  return new TrackerMcpError({
    code: 'internal_error',
    message: String(error),
    publicMessage: String(error),
    cause: error,
  })
}

export function trackerMcpJsonRpcCode(code: TrackerMcpErrorCode): number {
  switch (code) {
    case 'auth_failed':
      return -32001
    case 'policy_denied':
      return -32002
    case 'ticket_not_found':
    case 'comment_not_found':
      return -32003
    case 'validation_failed':
      return JsonRpcErrorCode.InvalidParams
    case 'provider_unavailable':
      return -32010
    case 'internal_error':
    default:
      return JsonRpcErrorCode.InternalError
  }
}

export function toMcpError(error: unknown): McpError {
  const trackerError = toTrackerMcpError(error)
  return new McpError(
    trackerMcpJsonRpcCode(trackerError.code),
    trackerError.publicMessage ?? trackerError.message,
    { trackerMcpCode: trackerError.code },
  )
}
