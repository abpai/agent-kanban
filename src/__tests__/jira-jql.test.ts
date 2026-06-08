import { describe, expect, test } from 'bun:test'
import { buildDeltaJql, assertSafeProjectKey, safeDeltaSince } from '../providers/jira-jql'
import { KanbanError } from '../errors'

describe('buildDeltaJql', () => {
  test('preserves the existing query format for a full scan (null since)', () => {
    expect(buildDeltaJql('ENG', null)).toBe(
      'project = ENG AND updated >= "1970-01-01 00:00" ORDER BY updated ASC',
    )
  })

  test('interpolates a valid ISO timestamp unchanged', () => {
    expect(buildDeltaJql('ENG', '2026-01-05T00:00:00Z')).toBe(
      'project = ENG AND updated >= "2026-01-05T00:00:00Z" ORDER BY updated ASC',
    )
  })

  test('accepts the ISO offset form Jira returns in issue.fields.updated', () => {
    expect(buildDeltaJql('ENG', '2026-06-08T12:34:56.789+0000')).toContain(
      'updated >= "2026-06-08T12:34:56.789+0000"',
    )
  })

  test('rejects an injection attempt in the since cursor and falls back to a full scan', () => {
    const malicious = '2026-01-01" OR project = OTHER ORDER BY updated ASC -- '
    expect(buildDeltaJql('ENG', malicious)).toBe(
      'project = ENG AND updated >= "1970-01-01 00:00" ORDER BY updated ASC',
    )
  })

  test('rejects an invalid project key', () => {
    expect(() => buildDeltaJql('ENG" OR 1=1', null)).toThrow(KanbanError)
    expect(() => assertSafeProjectKey('has space')).toThrow(KanbanError)
    expect(assertSafeProjectKey('ENG')).toBe('ENG')
  })
})

describe('safeDeltaSince', () => {
  test('passes through valid cursors and null', () => {
    expect(safeDeltaSince(null)).toBeNull()
    expect(safeDeltaSince('2026-01-05T00:00:00Z')).toBe('2026-01-05T00:00:00Z')
    expect(safeDeltaSince('1970-01-01 00:00')).toBe('1970-01-01 00:00')
  })

  test('nulls out an unsafe cursor so it is not carried forward or re-persisted', () => {
    // A lexicographically-high injection value would otherwise survive the
    // `issue.fields.updated > newestUpdatedAt` comparison and re-persist itself,
    // trapping every future sync into a full scan.
    expect(safeDeltaSince('9999" OR project = OTHER')).toBeNull()
  })
})
