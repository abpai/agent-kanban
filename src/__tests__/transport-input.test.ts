import { describe, expect, test } from 'bun:test'
import { ErrorCode, KanbanError } from '../errors'
import { parseBoundedInt, parseDecimalDigits, parsePositiveInt } from '../transport-input'

describe('parseDecimalDigits', () => {
  test('parses plain decimal digit strings (whitespace-trimmed)', () => {
    expect(parseDecimalDigits('0')).toBe(0)
    expect(parseDecimalDigits('42')).toBe(42)
    expect(parseDecimalDigits('  1000  ')).toBe(1000)
    expect(parseDecimalDigits(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER)
  })

  test('returns null for anything that is not exact non-negative decimal digits', () => {
    for (const raw of [
      '',
      '   ',
      'notanumber',
      '12abc',
      '-1',
      '3.5',
      '0x10',
      '1e3',
      '1_000',
      '+5',
      '9007199254740993', // past MAX_SAFE_INTEGER → precision loss
      '9'.repeat(309), // Number() → Infinity
    ]) {
      expect(parseDecimalDigits(raw)).toBeNull()
    }
  })
})

describe('parseBoundedInt', () => {
  test('accepts in-range digit strings (inclusive bounds)', () => {
    expect(parseBoundedInt('0', { min: 0, max: 65535, field: 'port' })).toBe(0)
    expect(parseBoundedInt('65535', { min: 0, max: 65535, field: 'port' })).toBe(65535)
    expect(parseBoundedInt('1000', { min: 1000, field: 'iv' })).toBe(1000)
    expect(parseBoundedInt('  42  ', { min: 1, max: 100, field: 'n' })).toBe(42)
  })

  test.each([
    ['65536', { min: 0, max: 65535, field: 'port' }],
    ['999', { min: 1000, field: 'iv' }],
    ['-1', { min: 0, max: 65535, field: 'port' }],
    ['3.5', { min: 0, max: 65535, field: 'port' }],
    ['0x10', { min: 0, max: 65535, field: 'port' }],
    ['1e3', { min: 1000, field: 'iv' }],
    ['', { min: 0, max: 65535, field: 'port' }],
    ['9007199254740993', { min: 1000, field: 'iv' }], // past MAX_SAFE_INTEGER → precision loss
    ['9'.repeat(309), { min: 1000, field: 'iv' }], // Number() → Infinity
  ] as const)('rejects %p as INVALID_ARGUMENT', (value, opts) => {
    expect(() => parseBoundedInt(value, opts)).toThrow(KanbanError)
    try {
      parseBoundedInt(value, opts)
    } catch (err) {
      expect((err as KanbanError).code).toBe(ErrorCode.INVALID_ARGUMENT)
    }
  })

  test('message form depends on whether max is bounded', () => {
    expect(() => parseBoundedInt('x', { min: 0, max: 65535, field: 'port' })).toThrow(
      /port must be an integer between 0 and 65535/,
    )
    expect(() => parseBoundedInt('x', { min: 1000, field: '--sync-interval-ms' })).toThrow(
      /--sync-interval-ms must be an integer >= 1000/,
    )
  })
})

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
