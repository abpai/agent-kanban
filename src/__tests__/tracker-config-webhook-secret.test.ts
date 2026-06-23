import { describe, expect, test } from 'bun:test'
import { WEBHOOK_SECRET_ENV, trackerProviderFromEnv } from '../tracker-config'

// OBS-2: the provider -> webhook-secret-env mapping is a single source of truth.
// WEBHOOK_SECRET_ENV is typed Record<TrackerProvider, …>, so adding a new
// provider to the union is a COMPILE error until its secret env is declared here
// — that compile-time exhaustiveness is the real guard against assertTunnelSecurity
// silently failing open for a new webhook-capable provider. These runtime tests
// pin the map contents and the env normalization the guard relies on.

describe('WEBHOOK_SECRET_ENV (single source of truth)', () => {
  test('maps each known provider to its secret env (local has none)', () => {
    expect(WEBHOOK_SECRET_ENV).toEqual({
      local: null,
      linear: 'LINEAR_WEBHOOK_SECRET',
      jira: 'JIRA_WEBHOOK_SECRET',
    })
  })

  test('every non-local provider points at a *_WEBHOOK_SECRET env name', () => {
    for (const [provider, envName] of Object.entries(WEBHOOK_SECRET_ENV)) {
      if (provider === 'local') {
        expect(envName).toBeNull()
      } else {
        expect(envName).toMatch(/_WEBHOOK_SECRET$/)
      }
    }
  })
})

describe('trackerProviderFromEnv', () => {
  test('normalizes known providers (case/whitespace-insensitive)', () => {
    expect(trackerProviderFromEnv({ KANBAN_PROVIDER: 'jira' })).toBe('jira')
    expect(trackerProviderFromEnv({ KANBAN_PROVIDER: 'Linear' })).toBe('linear')
    expect(trackerProviderFromEnv({ KANBAN_PROVIDER: '  JIRA  ' })).toBe('jira')
    expect(trackerProviderFromEnv({ KANBAN_PROVIDER: 'local' })).toBe('local')
  })

  test('falls back to local for unset / blank / unrecognized values', () => {
    expect(trackerProviderFromEnv({})).toBe('local')
    expect(trackerProviderFromEnv({ KANBAN_PROVIDER: '' })).toBe('local')
    // A future provider not yet wired in resolves to local (no webhooks) rather
    // than an unmapped value; once added to TrackerProvider it must gain a
    // WEBHOOK_SECRET_ENV entry (compile-enforced).
    expect(trackerProviderFromEnv({ KANBAN_PROVIDER: 'github' })).toBe('local')
  })

  test('inherited Object property names do not leak through the map lookup', () => {
    // The normalizer derives from WEBHOOK_SECRET_ENV's OWN keys, so prototype
    // names must not be treated as providers.
    for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(trackerProviderFromEnv({ KANBAN_PROVIDER: name })).toBe('local')
    }
  })
})
