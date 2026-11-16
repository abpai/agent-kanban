// Validates ADF against Atlassian's published JSON Schema (draft-04), the same
// contract Jira Cloud enforces on writes. Test-only: the schema package is a
// dev dependency, pinned so a schema change shows up as a reviewed bump.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import type { AnySchemaObject } from 'ajv'
import Ajv from 'ajv-draft-04'

import type { JsonValue } from '../../json'

const require = createRequire(import.meta.url)
const schema: AnySchemaObject = JSON.parse(
  readFileSync(require.resolve('@atlaskit/adf-schema/json-schema/v1/full.json'), 'utf8'),
)

const ajv = new Ajv({ allErrors: false, strict: false })
const validate = ajv.compile(schema)

/** Schema errors as readable lines; empty when the document is valid. */
export function adfSchemaErrors(document: JsonValue): string[] {
  if (validate(document)) return []
  return (validate.errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message}`)
}
