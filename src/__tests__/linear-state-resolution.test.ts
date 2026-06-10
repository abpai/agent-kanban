import { describe, expect, test } from 'bun:test'

import { resolveLinearState, type LinearStateRow } from '../providers/linear-cache'

describe('resolveLinearState', () => {
  const state = (id: string, name: string): LinearStateRow => ({
    id,
    name,
    position: 0,
    color: null,
    type: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  })

  test('matches by exact id first', () => {
    const states = [state('state-1', 'Todo'), state('state-2', 'In Progress')]
    expect(resolveLinearState(states, 'state-2').id).toBe('state-2')
  })

  test('matches by case-insensitive name', () => {
    const states = [state('state-1', 'In Progress')]
    expect(resolveLinearState(states, 'in progress').id).toBe('state-1')
  })

  test("resolves a separator-collapsed trigger string ('in-progress') to the 'In Progress' state", () => {
    const states = [state('state-1', 'Todo'), state('state-2', 'In Progress')]
    expect(resolveLinearState(states, 'in-progress').id).toBe('state-2')
    expect(resolveLinearState(states, 'InProgress').id).toBe('state-2')
    expect(resolveLinearState(states, 'in_progress').id).toBe('state-2')
  })

  test('exact case-insensitive name wins over a separator-insensitive collision', () => {
    // 'To Do' and 'Todo' both normalize to 'todo'; an exact lowercase hit must
    // not be derailed into the ambiguity branch.
    const states = [state('state-1', 'To Do'), state('state-2', 'Todo')]
    expect(resolveLinearState(states, 'todo').id).toBe('state-2')
  })

  test('rejects a separator-insensitive match that collapses two distinct states', () => {
    const states = [state('state-1', 'To Do'), state('state-2', 'To-Do')]
    expect(() => resolveLinearState(states, 'Todo')).toThrow(/ambiguous/)
  })

  test('empty / separator-only input does not match a separator-only state name', () => {
    const states = [state('state-1', '---'), state('state-2', 'To Do')]
    expect(() => resolveLinearState(states, '   ')).toThrow(/No Linear workflow state matching/)
    expect(() => resolveLinearState(states, '!!!')).toThrow(/No Linear workflow state matching/)
  })

  test('throws COLUMN_NOT_FOUND when nothing matches', () => {
    const states = [state('state-1', 'Todo')]
    expect(() => resolveLinearState(states, 'Done')).toThrow(/No Linear workflow state matching/)
  })
})
