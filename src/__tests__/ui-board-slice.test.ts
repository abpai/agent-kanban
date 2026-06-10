import { describe, expect, test } from 'bun:test'

import { defaultCapabilities } from '../../ui/src/store/capabilities'

// The type annotation guarantees key completeness; this pins the values so a
// default can't quietly flip back to true and reintroduce the pre-bootstrap
// flash of provider-gated actions.
describe('UI capability defaults', () => {
  test('every provider capability starts closed until bootstrap loads', () => {
    for (const [capability, enabled] of Object.entries(defaultCapabilities)) {
      expect({ capability, enabled }).toEqual({ capability, enabled: false })
    }
  })
})
