// Content hashes over raw stored JSON. They depend only on what Jira stores,
// never on the markdown converter, so a converter upgrade cannot make an
// unchanged description look edited.

// oxlint-disable anti-slop/no-runtime-typeof -- hashes untyped JSON from Jira.
import { createHash } from 'node:crypto'

import type { JsonValue } from '../../json'

/** JSON with object keys sorted at every depth, so key order cannot change a hash. */
function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .flatMap((key) => {
        const entry = value[key]
        return entry === undefined ? [] : [`${JSON.stringify(key)}:${canonicalJson(entry)}`]
      })
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

/** `sha256:<hex>` of the canonical JSON of `value`. */
export function sha256Json(value: JsonValue): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

/**
 * Hash of a description or comment exactly as Jira stores it: the raw ADF,
 * not normalized and not rendered. `null` for a missing description.
 */
export function adfContentHash(doc: JsonValue | undefined): string | null {
  return doc === undefined || doc === null ? null : sha256Json(doc)
}
