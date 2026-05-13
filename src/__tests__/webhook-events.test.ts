import { describe, expect, test } from 'bun:test'

import { extractWebhookMeta, webhookEventStatus, webhookEventsEnabled } from '../webhook-events'

describe('webhookEventStatus', () => {
  test('handled -> accepted', () => {
    expect(webhookEventStatus({ handled: true })).toBe('accepted')
  })
  test('unhandled -> skipped', () => {
    expect(webhookEventStatus({ handled: false })).toBe('skipped')
    expect(webhookEventStatus({ handled: false, message: 'Unsupported event' })).toBe('skipped')
  })
  test('unauthorized -> error (regardless of handled)', () => {
    expect(webhookEventStatus({ handled: false, unauthorized: true })).toBe('error')
    expect(webhookEventStatus({ handled: true, unauthorized: true })).toBe('error')
  })
})

describe('webhookEventsEnabled', () => {
  test('enabled by default / when unset', () => {
    expect(webhookEventsEnabled({})).toBe(true)
    expect(webhookEventsEnabled({ KANBAN_WEBHOOK_EVENTS: 'on' })).toBe(true)
    expect(webhookEventsEnabled({ KANBAN_WEBHOOK_EVENTS: '1' })).toBe(true)
  })
  test('disabled by explicit off values', () => {
    for (const v of ['0', 'false', 'off', 'no', 'OFF', ' false ']) {
      expect(webhookEventsEnabled({ KANBAN_WEBHOOK_EVENTS: v })).toBe(false)
    }
  })
})

describe('extractWebhookMeta', () => {
  test('jira: webhookEvent + issue.key', () => {
    const body = JSON.stringify({ webhookEvent: 'jira:issue_updated', issue: { key: 'SMTS-7' } })
    expect(extractWebhookMeta('jira', body)).toEqual({
      eventType: 'jira:issue_updated',
      externalRef: 'SMTS-7',
    })
  })
  test('jira: tolerates a missing issue', () => {
    expect(
      extractWebhookMeta('jira', JSON.stringify({ webhookEvent: 'jira:issue_deleted' })),
    ).toEqual({
      eventType: 'jira:issue_deleted',
    })
  })
  test('linear: type.action + data.identifier', () => {
    const body = JSON.stringify({
      type: 'Issue',
      action: 'update',
      data: { id: 'uuid-1', identifier: 'SMTS-9' },
    })
    expect(extractWebhookMeta('linear', body)).toEqual({
      eventType: 'Issue.update',
      externalRef: 'SMTS-9',
    })
  })
  test('linear: falls back to data.id when identifier is absent', () => {
    const body = JSON.stringify({ type: 'Issue', action: 'remove', data: { id: 'uuid-2' } })
    expect(extractWebhookMeta('linear', body)).toEqual({
      eventType: 'Issue.remove',
      externalRef: 'uuid-2',
    })
  })
  test('invalid / non-object body -> {}', () => {
    expect(extractWebhookMeta('jira', 'not json')).toEqual({})
    expect(extractWebhookMeta('jira', '"a string"')).toEqual({})
    expect(extractWebhookMeta('linear', 'null')).toEqual({})
  })
  test('unknown provider -> {}', () => {
    expect(extractWebhookMeta('local', JSON.stringify({ webhookEvent: 'x' }))).toEqual({})
  })
})
