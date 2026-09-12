import { expect } from 'bun:test'
import { KanbanError } from '../../errors'

export function assertKanbanError(cause: unknown): asserts cause is KanbanError {
  expect(cause).toBeInstanceOf(KanbanError)
}
