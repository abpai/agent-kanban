import { describe, expect, test } from 'bun:test'
import { selectDoneColumnIds, selectInProgressColumnIds } from '../column-roles'

const cols = (names: string[]) => names.map((name, i) => ({ id: `c${i}`, name, position: i }))

describe('selectDoneColumnIds', () => {
  test('matches done synonyms regardless of case/separators', () => {
    const columns = cols(['Backlog', 'In Progress', 'Done'])
    expect(selectDoneColumnIds(columns)).toEqual(['c2'])
    expect(selectDoneColumnIds(cols(['todo', 'completed']))).toEqual(['c1'])
    expect(selectDoneColumnIds(cols(['Open', 'Merged']))).toEqual(['c1'])
  })

  test('falls back to the terminal column when no name matches', () => {
    // Custom names with no recognizable "done" -> last column by position.
    expect(selectDoneColumnIds(cols(['Todo', 'Doing', 'Shipping Soon']))).toEqual(['c2'])
  })

  test('returns empty for no columns', () => {
    expect(selectDoneColumnIds([])).toEqual([])
  })
})

describe('selectInProgressColumnIds', () => {
  test('matches in-progress synonyms regardless of case/separators', () => {
    expect(selectInProgressColumnIds(cols(['Todo', 'In Progress', 'Done']))).toEqual(['c1'])
    expect(selectInProgressColumnIds(cols(['in-progress']))).toEqual(['c0'])
    expect(selectInProgressColumnIds(cols(['WIP', 'Doing']))).toEqual(['c0', 'c1'])
  })

  test('returns empty when nothing matches (no positional fallback)', () => {
    expect(selectInProgressColumnIds(cols(['Backlog', 'Done']))).toEqual([])
  })
})
