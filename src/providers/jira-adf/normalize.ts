// Structural comparison. normalizeAdf maps every document to the canonical
// form two documents are compared in; compareAdf diffs those forms.

// oxlint-disable anti-slop/no-runtime-typeof -- ADF arrives from Jira as untyped JSON; these checks are the decode boundary.
import type { JsonObject, JsonValue } from '../../json'
import {
  asNode,
  hoistEdgeWhitespace,
  isJsonObject,
  markRank,
  type AdfDifference,
  type AdfDocument,
  type AdfNode,
} from './model'

// Attributes Jira adds or varies without changing what a reader sees.
const ALWAYS_DROPPED_ATTRS = ['localId']

const DROPPED_ATTRS = new Map<string, readonly string[]>([
  ['table', ['layout', 'width', 'displayMode', '__autoSize']],
  ['tableCell', ['colwidth']],
  ['tableHeader', ['colwidth']],
  ['emoji', ['text']],
  ['hardBreak', ['text']],
  ['status', ['style']],
  ['mention', ['accessLevel', 'userType']],
])

const DEFAULT_ATTRS = new Map<string, JsonObject>([
  ['orderedList', { order: 1 }],
  ['codeBlock', { language: '' }],
  ['expand', { title: '' }],
  ['nestedExpand', { title: '' }],
  ['table', { isNumberColumnEnabled: false }],
  ['tableCell', { colspan: 1, rowspan: 1 }],
  ['tableHeader', { colspan: 1, rowspan: 1 }],
])

// Containers ADF requires to hold at least one block.
const NEEDS_CONTENT = new Set([
  'listItem',
  'tableCell',
  'tableHeader',
  'blockquote',
  'expand',
  'nestedExpand',
  'panel',
])

function normalizeAttrs(type: string, attrs: JsonValue | undefined): JsonObject | null {
  if (!isJsonObject(attrs)) return null
  const dropped = new Set([...ALWAYS_DROPPED_ATTRS, ...(DROPPED_ATTRS.get(type) ?? [])])
  const defaults = DEFAULT_ATTRS.get(type) ?? {}
  const out: JsonObject = {}
  for (const key of Object.keys(attrs).sort()) {
    let value = attrs[key]
    if (value === undefined || value === null || dropped.has(key)) continue
    if (type === 'date' && key === 'timestamp') value = String(value)
    if (type === 'orderedList' && key === 'order' && typeof value === 'string')
      value = Number(value)
    if (defaults[key] === value) continue
    out[key] = value
  }
  return Object.keys(out).length > 0 ? out : null
}

export function normalizeMarks(marks: JsonValue | undefined): JsonObject[] {
  if (!Array.isArray(marks)) return []
  const out: JsonObject[] = []
  for (const mark of marks) {
    if (!isJsonObject(mark) || typeof mark['type'] !== 'string') continue
    const type = mark['type']
    const normalized: JsonObject = { type }
    const attrs = normalizeAttrs(type, mark['attrs'])
    if (attrs && type === 'textColor' && typeof attrs['color'] === 'string') {
      attrs['color'] = attrs['color'].toLowerCase()
    }
    if (attrs) normalized['attrs'] = attrs
    out.push(normalized)
  }
  return out.sort((a, b) => {
    const rank = markRank(String(a['type'])) - markRank(String(b['type']))
    return rank !== 0 ? rank : JSON.stringify(a).localeCompare(JSON.stringify(b))
  })
}

function normalizeChildren(parentType: string, content: JsonValue[]): JsonObject[] {
  const out: JsonObject[] = []
  for (const child of content) {
    const node = normalizeNode(child, parentType)
    for (const piece of node) {
      const previous = out.at(-1)
      if (
        piece['type'] === 'text' &&
        previous?.['type'] === 'text' &&
        JSON.stringify(previous['marks'] ?? []) === JSON.stringify(piece['marks'] ?? [])
      ) {
        previous['text'] = `${String(previous['text'])}${String(piece['text'])}`
        continue
      }
      out.push(piece)
    }
  }
  if (parentType === 'paragraph' || parentType === 'heading') {
    while (out.at(-1)?.['type'] === 'hardBreak') out.pop()
    while (out[0]?.['type'] === 'hardBreak') out.shift()
    return out
  }
  if (parentType === 'codeBlock') return out
  // Markdown table cells cannot hold edge whitespace, and Jira shows none.
  if (parentType === 'tableCell' || parentType === 'tableHeader') out.forEach(trimParagraphEdges)
  const blocks = out.filter(
    (node) => !(node['type'] === 'paragraph' && node['content'] === undefined),
  )
  return blocks.length === 0 && NEEDS_CONTENT.has(parentType) ? [{ type: 'paragraph' }] : blocks
}

// Only unformatted edge text is trimmed: the serializer writes spaces inside
// formatting as character references, which survive.
function trimParagraphEdges(node: JsonObject): void {
  const content = node['content']
  if (node['type'] !== 'paragraph' || !Array.isArray(content)) return
  const kept = [...content]
  const trimEdge = (index: () => number, trim: (text: string) => string): void => {
    while (kept.length > 0) {
      const edge = kept[index()]
      if (!isJsonObject(edge) || edge['type'] !== 'text' || edge['marks'] !== undefined) return
      const text = trim(String(edge['text']))
      if (text.length > 0) {
        kept[index()] = { ...edge, text }
        return
      }
      kept.splice(index(), 1)
    }
  }
  trimEdge(
    () => 0,
    (text) => text.trimStart(),
  )
  trimEdge(
    () => kept.length - 1,
    (text) => text.trimEnd(),
  )
  if (kept.length > 0) node['content'] = kept
  else delete node['content']
}

function normalizeNode(value: JsonValue, parentType: string): JsonObject[] {
  if (!isJsonObject(value) || typeof value['type'] !== 'string') return []
  const type = value['type']
  if (type === 'text') {
    const text = typeof value['text'] === 'string' ? value['text'] : ''
    const marks = normalizeMarks(value['marks'])
    const make = (piece: string): JsonObject =>
      marks.length > 0 ? { type: 'text', text: piece, marks } : { type: 'text', text: piece }
    const isCode = parentType === 'codeBlock' || marks.some((mark) => mark['type'] === 'code')
    if (isCode) return text.length > 0 ? [make(text)] : []
    const out: JsonObject[] = []
    text.split('\n').forEach((line, index) => {
      if (index > 0) out.push({ type: 'hardBreak' })
      if (line.length > 0) out.push(...hoistEdgeWhitespace({ type: 'text', ...make(line) }))
    })
    return out
  }
  const node: JsonObject = { type }
  const attrs = normalizeAttrs(type, value['attrs'])
  if (attrs) node['attrs'] = attrs
  const marks = normalizeMarks(value['marks'])
  if (marks.length > 0) node['marks'] = marks
  const content = value['content']
  if (Array.isArray(content)) {
    const children = normalizeChildren(type, content)
    if (children.length > 0 || type === 'doc') node['content'] = children
  }
  if (type === 'doc') node['version'] = 1
  return [node]
}

/**
 * Returns the canonical form two documents are compared in: presentation-only
 * attributes and Jira-generated ids removed, text merged, marks sorted, and
 * spacer paragraphs dropped.
 */
export function normalizeAdf(doc: JsonValue | undefined): AdfDocument {
  const [node] = isJsonObject(doc) ? normalizeNode(doc, '') : []
  const content: AdfNode[] = []
  if (node && node['type'] === 'doc' && Array.isArray(node['content'])) {
    for (const child of node['content']) {
      const parsed = asNode(child)
      if (parsed) content.push(parsed)
    }
  }
  return { version: 1, type: 'doc', content }
}

function diffValues(
  expected: JsonValue | undefined,
  actual: JsonValue | undefined,
  path: string,
  out: AdfDifference[],
): void {
  if (out.length >= 50) return
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const length = Math.max(expected.length, actual.length)
    for (let i = 0; i < length; i += 1) diffValues(expected[i], actual[i], `${path}[${i}]`, out)
    return
  }
  if (isJsonObject(expected) && isJsonObject(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)])
    for (const key of [...keys].sort()) {
      diffValues(expected[key], actual[key], path.length > 0 ? `${path}.${key}` : key, out)
    }
    return
  }
  if (JSON.stringify(expected) !== JSON.stringify(actual)) out.push({ path, expected, actual })
}

/**
 * Structural comparison of two ADF documents after normalization. Returns an
 * empty array when they are equal; otherwise the differing paths (at most 50).
 */
export function compareAdf(
  expected: JsonValue | undefined,
  actual: JsonValue | undefined,
): AdfDifference[] {
  const out: AdfDifference[] = []
  diffValues(normalizeAdf(expected), normalizeAdf(actual), '', out)
  return out
}

/** One-line summary of a structural diff, for error messages. */
export function describeAdfDifferences(differences: AdfDifference[]): string {
  return differences
    .slice(0, 5)
    .map(
      (d) =>
        `${d.path || '(root)'}: expected ${JSON.stringify(d.expected) ?? 'nothing'}, got ${JSON.stringify(d.actual) ?? 'nothing'}`,
    )
    .join('; ')
}
