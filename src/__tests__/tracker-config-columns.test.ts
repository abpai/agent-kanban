import { describe, expect, test } from 'bun:test'
import { trackerConfigFromEnv } from '../tracker-config'
import { KanbanError } from '../errors'

describe('trackerConfigFromEnv default columns', () => {
  test('parses comma-separated default columns for the local provider', () => {
    const config = trackerConfigFromEnv({ KANBAN_DEFAULT_COLUMNS: 'Todo, Doing , Done' })
    expect(config).toMatchObject({ provider: 'local', defaultColumns: ['Todo', 'Doing', 'Done'] })
  })

  test('rejects case-insensitive duplicate default columns', () => {
    expect(() => trackerConfigFromEnv({ KANBAN_DEFAULT_COLUMNS: 'Done,done' })).toThrow(KanbanError)
    expect(() => trackerConfigFromEnv({ KANBAN_DEFAULT_COLUMNS: 'Done,done' })).toThrow(
      /duplicate column name/i,
    )
  })

  test('leaves default columns unset when the variable is absent', () => {
    const config = trackerConfigFromEnv({})
    expect(config).toMatchObject({ provider: 'local' })
    expect((config as { defaultColumns?: string[] }).defaultColumns).toBeUndefined()
  })
})
