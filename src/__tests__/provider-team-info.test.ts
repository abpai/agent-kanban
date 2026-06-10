import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

import { initLinearCacheSchema, loadSyncMeta } from '../providers/linear-cache'
import { parseProviderTeamInfo } from '../providers/team-info'

describe('parseProviderTeamInfo', () => {
  test('accepts the persisted provider team shape', () => {
    expect(
      parseProviderTeamInfo(JSON.stringify({ id: 'team-1', key: 'ENG', name: 'Engineering' })),
    ).toEqual({
      id: 'team-1',
      key: 'ENG',
      name: 'Engineering',
    })
  })

  test('rejects corrupt or incomplete metadata', () => {
    expect(parseProviderTeamInfo(null)).toBeNull()
    expect(parseProviderTeamInfo('not json')).toBeNull()
    expect(parseProviderTeamInfo(JSON.stringify({ id: 'team-1', key: 'ENG' }))).toBeNull()
    expect(
      parseProviderTeamInfo(JSON.stringify({ id: 'team-1', key: 42, name: 'Engineering' })),
    ).toBeNull()
  })

  test('Linear sync metadata degrades corrupt team JSON to null', () => {
    const db = new Database(':memory:')
    initLinearCacheSchema(db)
    db.query('INSERT INTO linear_sync_meta (key, value) VALUES ($key, $value)').run({
      $key: 'team',
      $value: 'not json',
    })

    expect(loadSyncMeta(db).team).toBeNull()
  })
})
