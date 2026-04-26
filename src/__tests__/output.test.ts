import { describe, expect, test } from 'bun:test'
import { success, error, formatOutput } from '../output'

describe('success', () => {
  test('wraps data in ok envelope', () => {
    const result = success({ id: '123' })
    expect(result).toEqual({ ok: true, data: { id: '123' } })
  })
})

describe('error', () => {
  test('wraps error in envelope', () => {
    const result = error('NOT_FOUND', 'Task not found')
    expect(result).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Task not found' },
    })
  })
})

describe('formatOutput', () => {
  test('returns compact JSON when pretty=false', () => {
    const result = success({ x: 1 })
    const output = formatOutput(result, false)
    expect(output).toBe('{"ok":true,"data":{"x":1}}')
  })

  test('returns error text when pretty=true', () => {
    const result = error('CODE', 'Something failed')
    const output = formatOutput(result, true)
    expect(output).toBe('Error [CODE]: Something failed')
  })

  test('formats message data in pretty mode', () => {
    const result = success({ message: 'Board initialized.' })
    const output = formatOutput(result, true)
    expect(output).toBe('Board initialized.')
  })

  test('formats comments in pretty mode', () => {
    const output = formatOutput(
      success([
        {
          id: 'c_1',
          task_id: 't_1',
          body: 'hello from cli',
          author: 'alice',
          created_at: '2026-04-26T00:00:00.000Z',
          updated_at: '2026-04-26T00:00:00.000Z',
        },
      ]),
      true,
    )
    expect(output).toBe('  c_1 @alice  hello from cli')
  })
})
