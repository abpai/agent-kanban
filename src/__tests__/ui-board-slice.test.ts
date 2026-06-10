import { describe, expect, test } from 'bun:test'

import { defaultCapabilities } from '../../ui/src/store/capabilities'

describe('UI board slice defaults', () => {
  test('starts with provider capabilities closed until bootstrap loads', () => {
    expect(Object.values(defaultCapabilities).every((enabled) => enabled === false)).toBe(true)
  })
})
