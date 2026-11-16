// Shared ADF types, the markdown conventions both directions agree on, and
// defensive accessors for ADF that arrives as untyped JSON.

// oxlint-disable anti-slop/no-runtime-typeof -- ADF arrives from Jira as untyped JSON; these checks are the decode boundary.
import type { JsonObject, JsonValue } from '../../json'

/**
 * Identifies the ADF/markdown rendering rules. It changes whenever the same ADF
 * could render to different markdown, so stored hashes of rendered text can be
 * re-stamped.
 */
export const JIRA_ADF_CONVERTER_VERSION = 'agent-kanban/adf-markdown@2'

export interface AdfNode extends JsonObject {
  type: string
}

export interface AdfDocument extends AdfNode {
  version: 1
  type: 'doc'
  content: AdfNode[]
}

export interface AdfConversionWarning {
  code: 'unsupported_node' | 'unsupported_mark' | 'unsupported_layout' | 'round_trip_mismatch'
  /** ADF node or mark type the warning is about. */
  nodeType: string
  /** JSON path in the source document, for example `content[2].content[0]`. */
  path: string
  message: string
}

export interface AdfMarkdown {
  markdown: string
  warnings: AdfConversionWarning[]
  /** True when the markdown parses back to the same normalized ADF. */
  lossless: boolean
  converterVersion: string
}

export interface AdfDifference {
  path: string
  expected: JsonValue | undefined
  actual: JsonValue | undefined
}

export interface MarkdownWriteIssue {
  code: 'unsupported_markdown' | 'unsupported_marker' | 'round_trip_mismatch'
  message: string
  /** 1-based markdown line, when the issue has a source position. */
  line?: number
  differences?: AdfDifference[]
}

export type MarkdownToAdfResult =
  | { ok: true; document: AdfDocument; converterVersion: string }
  | { ok: false; issues: MarkdownWriteIssue[]; converterVersion: string }

export const MARKER_PREFIX = 'unsupported Jira content: '

export const MARKER_PATTERN = /\[(?:end )?unsupported Jira content: /

// Inline ADF nodes that markdown has no syntax for are carried as links with
// these schemes, so they stay readable and parse back to the same node.
export const MENTION_SCHEME = 'jira-mention:'

export const EMOJI_SCHEME = 'jira-emoji:'

export const STATUS_SCHEME = 'jira-status:'

export const DATE_SCHEME = 'jira-date:'

// Marks render outermost-first in this order, so the same mark set always
// nests the same way.
const MARK_ORDER = ['link', 'textColor', 'underline', 'subsup', 'strike', 'strong', 'em', 'code']

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
}

export function asNode(value: JsonValue | undefined): AdfNode | null {
  if (!isJsonObject(value)) return null
  const type = value['type']
  if (typeof type !== 'string') return null
  return { ...value, type }
}

export function childNodes(node: AdfNode): AdfNode[] {
  const content = node['content']
  if (!Array.isArray(content)) return []
  const out: AdfNode[] = []
  for (const child of content) {
    const parsed = asNode(child)
    if (parsed) out.push(parsed)
  }
  return out
}

export function attrsOf(node: AdfNode | AdfMarkSpec): JsonObject {
  const attrs = node['attrs']
  return isJsonObject(attrs) ? attrs : {}
}

export function stringAttr(node: AdfNode | AdfMarkSpec, key: string): string | null {
  const value = attrsOf(node)[key]
  return typeof value === 'string' ? value : null
}

export function numberAttr(node: AdfNode, key: string): number | null {
  const value = attrsOf(node)[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10)
  return null
}

export interface AdfMarkSpec extends JsonObject {
  type: string
}

export function marksOf(node: AdfNode): AdfMarkSpec[] {
  const marks = node['marks']
  if (!Array.isArray(marks)) return []
  const out: AdfMarkSpec[] = []
  for (const mark of marks) {
    if (!isJsonObject(mark)) continue
    const type = mark['type']
    if (typeof type === 'string') out.push({ ...mark, type })
  }
  return out
}

export function textOf(node: AdfNode): string {
  const text = node['text']
  return typeof text === 'string' ? text : ''
}

export function markRank(type: string): number {
  const index = MARK_ORDER.indexOf(type)
  return index === -1 ? MARK_ORDER.length : index
}

export function markKey(mark: AdfMarkSpec): string {
  return JSON.stringify([mark.type, attrsOf(mark)])
}

export function escapeTitle(value: string): string {
  return value.replace(/(["\\])/g, '\\$1')
}

export function unescapeTitle(raw: string): string {
  return raw.replace(/\\(.)/g, '$1')
}

// Bold or italic on a space is invisible, and markdown cannot close `**` after
// one. Edge whitespace moves outside those marks; normalizeAdf does the same.
const INVISIBLE_ON_SPACE = new Set(['strong', 'em'])

export function hoistEdgeWhitespace(node: AdfNode): AdfNode[] {
  if (node.type !== 'text') return [node]
  const marks = marksOf(node)
  if (!marks.some((mark) => INVISIBLE_ON_SPACE.has(mark.type))) return [node]
  if (marks.some((mark) => mark.type === 'code')) return [node]
  const [, lead = '', body = '', trail = ''] = textOf(node).match(/^(\s*)([\s\S]*?)(\s*)$/) ?? []
  if (lead.length === 0 && trail.length === 0) return [node]
  const outer = marks.filter((mark) => !INVISIBLE_ON_SPACE.has(mark.type))
  const plain = (text: string): AdfNode =>
    outer.length > 0 ? { type: 'text', text, marks: outer } : { type: 'text', text }
  if (body.length === 0) return [plain(lead + trail)]
  const out: AdfNode[] = []
  if (lead.length > 0) out.push(plain(lead))
  out.push({ ...node, text: body })
  if (trail.length > 0) out.push(plain(trail))
  return out
}
