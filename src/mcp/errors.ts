import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server'
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
    case ErrorCode.INVALID_CONFIG:
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

export function toTrackerMcpError(cause: unknown): TrackerMcpError {
  if (cause instanceof TrackerMcpError) return cause
  if (cause instanceof KanbanError) {
    return new TrackerMcpError({
      code: providerError(cause.code),
      message: cause.message,
      publicMessage: cause.message,
      cause,
    })
  }
  if (cause instanceof Error) {
    return new TrackerMcpError({
      code: 'internal_error',
      message: cause.message,
      publicMessage: cause.message,
      cause,
    })
  }
  return new TrackerMcpError({
    code: 'internal_error',
    message: String(cause),
    publicMessage: String(cause),
    cause,
  })
}

export function trackerMcpJsonRpcCode(code: TrackerMcpErrorCode): number {
  switch (code) {
    case 'auth_failed':
      return -32001
    case 'policy_denied':
      return -32012
    case 'ticket_not_found':
    case 'comment_not_found':
      return -32003
    case 'validation_failed':
      return ProtocolErrorCode.InvalidParams
    case 'provider_unavailable':
      return -32010
    case 'internal_error':
    default:
      return ProtocolErrorCode.InternalError
  }
}

export function toMcpError(cause: unknown): ProtocolError {
  const trackerError = toTrackerMcpError(cause)
  return new ProtocolError(
    trackerMcpJsonRpcCode(trackerError.code),
    trackerError.publicMessage ?? trackerError.message,
    { trackerMcpCode: trackerError.code },
  )
}
