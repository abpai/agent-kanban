import { describe, expect, test } from 'bun:test'
import { parsePositiveInt } from '../transport-input'

describe('parsePositiveInt', () => {
  test('returns undefined for absent values', () => {
    expect(parsePositiveInt(null)).toBeUndefined()
    expect(parsePositiveInt(undefined)).toBeUndefined()
    expect(parsePositiveInt('')).toBeUndefined()
  })

  test('accepts positive integers', () => {
    expect(parsePositiveInt('1')).toBe(1)
    expect(parsePositiveInt('100')).toBe(100)
  })

  test.each([
    '0',
    '-5',
    '3.9',
    'abc',
    '5abc',
    'NaN',
    'Infinity',
    '1e100',
    '1e3',
    '0x10',
    '1000000000000000000000000',
  ])('rejects invalid value %p', (value) => {
    expect(() => parsePositiveInt(value)).toThrow(/positive integer/)
  })

  test('uses the provided field name in the message', () => {
    expect(() => parsePositiveInt('-1', 'count')).toThrow(/count must be a positive integer/)
  })
})
