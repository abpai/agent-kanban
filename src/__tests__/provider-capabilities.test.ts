import { describe, expect, test } from 'bun:test'

import {
  JIRA_CAPABILITIES,
  LINEAR_CAPABILITIES,
  LOCAL_CAPABILITIES,
} from '../providers/capabilities'

describe('provider capabilities', () => {
  test('remote providers share the same read/write baseline', () => {
    expect(LINEAR_CAPABILITIES).toEqual(JIRA_CAPABILITIES)
    expect(LINEAR_CAPABILITIES).toEqual({
      taskCreate: true,
      taskUpdate: true,
      taskMove: true,
      taskDelete: false,
      comment: true,
      activity: false,
      metrics: false,
      columnCrud: false,
      bulk: false,
      configEdit: false,
    })
  })

  test('local provider exposes the full local board surface', () => {
    expect(LOCAL_CAPABILITIES).toEqual({
      taskCreate: true,
      taskUpdate: true,
      taskMove: true,
      taskDelete: true,
      comment: true,
      activity: true,
      metrics: true,
      columnCrud: true,
      bulk: true,
      configEdit: true,
    })
  })
})
