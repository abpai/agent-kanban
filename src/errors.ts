export const ErrorCode = {
  BOARD_NOT_INITIALIZED: 'BOARD_NOT_INITIALIZED',
  BOARD_ALREADY_INITIALIZED: 'BOARD_ALREADY_INITIALIZED',
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  COLUMN_NOT_FOUND: 'COLUMN_NOT_FOUND',
  COLUMN_NOT_EMPTY: 'COLUMN_NOT_EMPTY',
  COLUMN_NAME_EXISTS: 'COLUMN_NAME_EXISTS',
  INVALID_PRIORITY: 'INVALID_PRIORITY',
  INVALID_METADATA: 'INVALID_METADATA',
  INVALID_POSITION: 'INVALID_POSITION',
  MISSING_ARGUMENT: 'MISSING_ARGUMENT',
  UNKNOWN_COMMAND: 'UNKNOWN_COMMAND',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode]

export class KanbanError extends Error {
  constructor(
    public code: ErrorCodeValue,
    message: string,
  ) {
    super(message)
    this.name = 'KanbanError'
  }
}
