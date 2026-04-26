import { describe, expect, test } from 'bun:test'
import { generateId } from '../id'

describe('generateId', () => {
  test('generates task IDs with t_ prefix', () => {
    const id = generateId('t')
    expect(id).toMatch(/^t_[a-z0-9]{8}$/)
  })

  test('generates column IDs with c_ prefix', () => {
    const id = generateId('c')
    expect(id).toMatch(/^c_[a-z0-9]{8}$/)
  })

  test('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId('t')))
    expect(ids.size).toBe(100)
  })
})
