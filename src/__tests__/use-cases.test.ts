import { describe, expect, test } from 'bun:test'
import { normalizeCreateTaskInput } from '../use-cases'

describe('use-cases label normalization', () => {
  test('normalizes CLI-style nested flag arrays', () => {
    expect(
      normalizeCreateTaskInput({
        title: 'cli',
        labels: [['bug', 'ui'], undefined],
      }),
    ).toEqual({ title: 'cli', labels: ['bug', 'ui'] })
  })

  test('normalizes HTTP-style string arrays', () => {
    expect(
      normalizeCreateTaskInput({
        title: 'http',
        labels: ['bug', 'ui'],
      }),
    ).toEqual({ title: 'http', labels: ['bug', 'ui'] })
  })

  test('normalizes a comma-separated string and de-dupes', () => {
    expect(
      normalizeCreateTaskInput({
        title: 'csv',
        labels: 'bug, ui, bug',
      }),
    ).toEqual({ title: 'csv', labels: ['bug', 'ui'] })
  })

  test('treats omitted labels as none', () => {
    expect(normalizeCreateTaskInput({ title: 'none' })).toEqual({ title: 'none', labels: [] })
  })
})
