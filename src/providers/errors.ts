import { ErrorCode, type ErrorCodeValue, KanbanError } from '../errors.ts'

export function unsupportedOperation(message: string): never {
  throw new KanbanError(ErrorCode.UNSUPPORTED_OPERATION, message)
}

export function providerNotConfigured(message: string): never {
  throw new KanbanError(ErrorCode.PROVIDER_NOT_CONFIGURED, message)
}

export function providerUpstreamError(
  message: string,
  code: ErrorCodeValue = ErrorCode.PROVIDER_UPSTREAM_ERROR,
): never {
  throw new KanbanError(code, message)
}
