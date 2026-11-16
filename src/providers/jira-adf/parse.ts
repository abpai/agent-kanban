// Markdown -> ADF. Parses CommonMark plus GFM tables, strikethrough and task
// lists. GFM's bare-URL autolinking is left out on purpose: Jira stores a typed
// URL as plain text, and autolinking would turn it into a link on every
// read-back. Anything without an ADF equivalent becomes an issue, never
// degraded markup.

// oxlint-disable anti-slop/no-runtime-typeof -- ADF arrives from Jira as untyped JSON; these checks are the decode boundary.
import type {
  Definition,
  Link,
  List,
  Nodes,
  PhrasingContent,
  Root,
  RootContent,
  Table,
} from 'mdast'
import { createHash } from 'node:crypto'

import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmStrikethroughFromMarkdown } from 'mdast-util-gfm-strikethrough'
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table'
import { gfmTaskListItemFromMarkdown } from 'mdast-util-gfm-task-list-item'
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough'
import { gfmTable } from 'micromark-extension-gfm-table'
import { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item'

import type { JsonObject, JsonValue } from '../../json'
import {
  DATE_SCHEME,
  EMOJI_SCHEME,
  isJsonObject,
  MARKER_PATTERN,
  MENTION_SCHEME,
  STATUS_SCHEME,
  unescapeTitle,
  type AdfDocument,
  type AdfMarkSpec,
  type AdfNode,
  type MarkdownWriteIssue,
} from './model'

interface WriteContext {
  issues: MarkdownWriteIssue[]
  definitions: Map<string, Definition>
  lineOffset: number
  source: string
}

function refuse(ctx: WriteContext, node: Nodes | null, message: string): void {
  const issue: MarkdownWriteIssue = { code: 'unsupported_markdown', message }
  const line = node?.position?.start.line
  if (line !== undefined) issue.line = line + ctx.lineOffset
  ctx.issues.push(issue)
}

function parseTree(markdown: string): Root {
  return fromMarkdown(markdown, {
    extensions: [gfmTable(), gfmStrikethrough(), gfmTaskListItem()],
    mdastExtensions: [
      gfmTableFromMarkdown(),
      gfmStrikethroughFromMarkdown(),
      gfmTaskListItemFromMarkdown(),
    ],
  })
}

function collectDefinitions(node: Nodes, into: Map<string, Definition>): void {
  if (node.type === 'definition') into.set(node.identifier, node)
  if ('children' in node) for (const child of node.children) collectDefinitions(child, into)
}

type FlowScope = 'doc' | 'listItem' | 'blockquote' | 'expand' | 'nestedExpand'

// What the ADF schema lets each container hold. Writing anything else gets a
// 400 from Jira, so it is refused here with a line number instead.
// An HTML block is written as a paragraph of literal text, so it is allowed
// wherever a paragraph is.
const ALLOWED_IN = {
  doc: new Set([
    'paragraph',
    'html',
    'heading',
    'list',
    'code',
    'blockquote',
    'thematicBreak',
    'table',
  ]),
  expand: new Set([
    'paragraph',
    'html',
    'heading',
    'list',
    'code',
    'blockquote',
    'thematicBreak',
    'table',
  ]),
  nestedExpand: new Set([
    'paragraph',
    'html',
    'heading',
    'list',
    'code',
    'blockquote',
    'thematicBreak',
  ]),
  listItem: new Set(['paragraph', 'html', 'list', 'code']),
  blockquote: new Set(['paragraph', 'html', 'list', 'code']),
} satisfies Record<FlowScope, ReadonlySet<string>>

// The ADF schema allows task lists everywhere except inside a quote.
const TASK_LIST_SCOPES: ReadonlySet<FlowScope> = new Set([
  'doc',
  'expand',
  'nestedExpand',
  'listItem',
])

const STATUS_COLORS: ReadonlySet<string> = new Set([
  'neutral',
  'purple',
  'blue',
  'red',
  'yellow',
  'green',
])

function emptyParagraph(): AdfNode {
  return { type: 'paragraph' }
}

function flowToAdf(nodes: RootContent[], scope: FlowScope, ctx: WriteContext): AdfNode[] {
  const out: AdfNode[] = []
  for (const node of nodes) {
    if (node.type === 'definition') continue
    if (!ALLOWED_IN[scope].has(node.type)) {
      refuse(ctx, node, describeRefusal(node, scope))
      continue
    }
    if (node.type === 'list' && isTaskList(node) && !TASK_LIST_SCOPES.has(scope)) {
      refuse(ctx, node, `A task list cannot be written inside ${scopeName(scope)} in Jira.`)
      continue
    }
    const converted = flowNodeToAdf(node, ctx)
    if (converted) out.push(converted)
  }
  return out
}

function isTaskList(node: List): boolean {
  return node.children.some((item) => typeof item.checked === 'boolean')
}

function scopeName(scope: FlowScope): string {
  switch (scope) {
    case 'listItem':
      return 'a list item'
    case 'blockquote':
      return 'a quote'
    case 'nestedExpand':
      return 'a nested expand'
    default:
      return 'Jira'
  }
}

function describeRefusal(node: RootContent, scope: FlowScope): string {
  if (node.type === 'footnoteDefinition') return 'Footnotes cannot be written to Jira.'
  if (node.type === 'yaml') return 'Front matter cannot be written to Jira.'
  return `A markdown ${node.type} cannot be written inside ${scopeName(scope)}.`
}

function flowNodeToAdf(node: RootContent, ctx: WriteContext): AdfNode | null {
  switch (node.type) {
    case 'paragraph': {
      checkMarker(node.children, node, ctx)
      const content = phrasingToAdf(node.children, [], ctx)
      return content.length > 0 ? { type: 'paragraph', content } : null
    }
    case 'heading': {
      checkMarker(node.children, node, ctx)
      const content = phrasingToAdf(node.children, [], ctx)
      const heading: AdfNode = { type: 'heading', attrs: { level: node.depth } }
      if (content.length > 0) heading['content'] = content
      return heading
    }
    case 'html': {
      // Jira has no HTML, so the faithful write is the characters as typed.
      // They read back escaped (`\<div>`), which parses to the same text.
      const content = textNodes(node.value, [])
      return content.length > 0 ? { type: 'paragraph', content } : null
    }
    case 'thematicBreak':
      return { type: 'rule' }
    case 'code': {
      if (node.meta)
        refuse(ctx, node, 'Code fence info after the language cannot be written to Jira.')
      const block: AdfNode = { type: 'codeBlock' }
      if (node.lang) block['attrs'] = { language: node.lang }
      if (node.value.length > 0) block['content'] = [{ type: 'text', text: node.value }]
      return block
    }
    case 'blockquote': {
      const content = flowToAdf(node.children, 'blockquote', ctx)
      return { type: 'blockquote', content: content.length > 0 ? content : [emptyParagraph()] }
    }
    case 'list':
      return listToAdf(node, ctx)
    case 'table':
      return tableToAdf(node, ctx)
    default:
      refuse(ctx, node, `A markdown ${node.type} cannot be written to Jira.`)
      return null
  }
}

function listToAdf(node: List, ctx: WriteContext): AdfNode {
  const tasks = node.children.filter((item) => item.checked !== null && item.checked !== undefined)
  if (tasks.length > 0) {
    if (tasks.length !== node.children.length || node.ordered) {
      refuse(ctx, node, 'A list that mixes task items with plain items cannot be written to Jira.')
    }
    return taskListToAdf(node, ctx)
  }
  const items = node.children.map((item): AdfNode => {
    // Jira's editor stores an item that starts with a nested list when the
    // first bullet is indented, so that shape is written as-is.
    const content = flowToAdf(item.children, 'listItem', ctx)
    return { type: 'listItem', content: content.length > 0 ? content : [emptyParagraph()] }
  })
  if (!node.ordered) return { type: 'bulletList', content: items }
  const list: AdfNode = { type: 'orderedList', content: items }
  if (typeof node.start === 'number' && node.start !== 1) list['attrs'] = { order: node.start }
  return list
}

function taskListToAdf(node: List, ctx: WriteContext): AdfNode {
  const content: AdfNode[] = []
  for (const item of node.children) {
    const [first, ...rest] = item.children
    if (first?.type === 'paragraph') checkMarker(first.children, first, ctx)
    const inline = first?.type === 'paragraph' ? phrasingToAdf(first.children, [], ctx) : []
    const task: AdfNode = {
      type: 'taskItem',
      attrs: { localId: PENDING_LOCAL_ID, state: item.checked ? 'DONE' : 'TODO' },
    }
    if (inline.length > 0) task['content'] = inline
    content.push(task)
    const nested = first?.type === 'paragraph' ? rest : item.children
    for (const child of nested) {
      if (
        child.type === 'list' &&
        child.children.every((sub) => typeof sub.checked === 'boolean')
      ) {
        content.push(taskListToAdf(child, ctx))
      } else {
        refuse(
          ctx,
          child,
          'A task item can only hold one line of text and nested task lists in Jira.',
        )
      }
    }
  }
  return { type: 'taskList', attrs: { localId: PENDING_LOCAL_ID }, content }
}

function tableToAdf(node: Table, ctx: WriteContext): AdfNode {
  if (node.align?.some((align) => align !== null)) {
    refuse(
      ctx,
      node,
      'Jira tables have no column alignment; remove the `:` from the delimiter row.',
    )
  }
  const rows = node.children.map(
    (row, rowIndex): AdfNode => ({
      type: 'tableRow',
      content: row.children.map((cell): AdfNode => {
        checkMarker(cell.children, cell, ctx)
        const content = phrasingToAdf(cell.children, [], ctx)
        return {
          type: rowIndex === 0 ? 'tableHeader' : 'tableCell',
          attrs: {},
          content: [content.length > 0 ? { type: 'paragraph', content } : emptyParagraph()],
        }
      }),
    }),
  )
  return {
    type: 'table',
    attrs: { isNumberColumnEnabled: false, layout: 'default', localId: PENDING_LOCAL_ID },
    content: rows,
  }
}

// The visible text of inline content, with link text kept in brackets, so a
// marker split by formatting or written as a reference link is still seen.
function visibleText(nodes: PhrasingContent[]): string {
  return nodes
    .map((node): string => {
      switch (node.type) {
        case 'text':
        case 'inlineCode':
          return node.value
        case 'link':
        case 'linkReference':
          return `[${visibleText(node.children)}]`
        case 'emphasis':
        case 'strong':
        case 'delete':
          return visibleText(node.children)
        default:
          return ''
      }
    })
    .join('')
}

function checkMarker(nodes: PhrasingContent[], at: Nodes, ctx: WriteContext): void {
  if (!MARKER_PATTERN.test(visibleText(nodes))) return
  const issue: MarkdownWriteIssue = {
    code: 'unsupported_marker',
    message:
      'The markdown still contains an unsupported-Jira-content marker; writing it would replace the original Jira content with the marker text.',
  }
  if (at.position) issue.line = at.position.start.line + ctx.lineOffset
  ctx.issues.push(issue)
}

function decodeSchemeValue(encoded: string): string | null {
  try {
    return decodeURIComponent(encoded)
  } catch {
    return null
  }
}

function sourceStartsWith(node: Nodes, ctx: WriteContext, prefix: string): boolean {
  const offset = node.position?.start.offset
  return offset !== undefined && ctx.source.startsWith(prefix, offset)
}

function textNodes(text: string, marks: AdfMarkSpec[]): AdfNode[] {
  const out: AdfNode[] = []
  text.split('\n').forEach((line, index) => {
    // Markdown soft line breaks are kept as Jira line breaks, the way GitHub
    // renders comments.
    if (index > 0) out.push({ type: 'hardBreak' })
    if (line.length === 0) return
    const node: AdfNode = { type: 'text', text: line }
    if (marks.length > 0) node['marks'] = marks
    out.push(node)
  })
  return out
}

function linkText(node: Link): string | null {
  if (node.children.length === 0) return ''
  const [only] = node.children
  return node.children.length === 1 && only?.type === 'text' ? only.value : null
}

function schemeNode(
  node: Link,
  marks: AdfMarkSpec[],
  ctx: WriteContext,
): AdfNode | null | undefined {
  const scheme = [MENTION_SCHEME, EMOJI_SCHEME, STATUS_SCHEME, DATE_SCHEME].find((prefix) =>
    node.url.startsWith(prefix),
  )
  if (!scheme) return undefined
  const label = linkText(node)
  const value = decodeSchemeValue(node.url.slice(scheme.length))
  if (value === null) {
    refuse(ctx, node, `The ${scheme.slice(0, -1)} link has malformed percent-encoding.`)
    return null
  }
  if (label === null || marks.length > 0) {
    refuse(ctx, node, `A ${scheme.slice(0, -1)} link must be plain text outside other formatting.`)
    return null
  }
  switch (scheme) {
    case MENTION_SCHEME:
      if (value.length === 0) {
        refuse(ctx, node, 'A jira-mention link needs an account id.')
        return null
      }
      return { type: 'mention', attrs: { id: value, text: label } }
    case EMOJI_SCHEME: {
      const attrs: JsonObject = { shortName: label }
      if (value.length > 0) attrs['id'] = value
      return { type: 'emoji', attrs }
    }
    case STATUS_SCHEME:
      if (!STATUS_COLORS.has(value) && !/^#[0-9a-f]{6}$/i.test(value)) {
        refuse(
          ctx,
          node,
          `Jira status colors are ${[...STATUS_COLORS].join(', ')} or #rrggbb; '${value}' is not one.`,
        )
        return null
      }
      return {
        type: 'status',
        attrs: { text: label, color: value, localId: PENDING_LOCAL_ID },
      }
    default:
      if (!/^\d+$/.test(value)) {
        refuse(ctx, node, 'A jira-date link needs a millisecond timestamp.')
        return null
      }
      return { type: 'date', attrs: { timestamp: value } }
  }
}

function linkToAdf(node: Link, marks: AdfMarkSpec[], out: AdfNode[], ctx: WriteContext): void {
  const special = schemeNode(node, marks, ctx)
  if (special !== undefined) {
    if (special) out.push(special)
    return
  }
  if (sourceStartsWith(node, ctx, '<') && !node.url.startsWith('mailto:')) {
    if (marks.length > 0) {
      refuse(ctx, node, 'A Jira smart link (<url>) cannot be formatted.')
      return
    }
    out.push({ type: 'inlineCard', attrs: { url: node.url } })
    return
  }
  const attrs: JsonObject = { href: node.url }
  if (node.title) attrs['title'] = node.title
  phrasingToAdf(node.children, [...marks, { type: 'link', attrs }], ctx, out)
}

function htmlMark(value: string): { open: AdfMarkSpec } | { close: string } | null {
  const color = value.match(COLOR_SPAN_OPEN)
  if (color) return { open: { type: 'textColor', attrs: { color: color[1]!.toLowerCase() } } }
  switch (value) {
    case '<u>':
      return { open: { type: 'underline' } }
    case '<sub>':
      return { open: { type: 'subsup', attrs: { type: 'sub' } } }
    case '<sup>':
      return { open: { type: 'subsup', attrs: { type: 'sup' } } }
    case '</u>':
      return { close: 'underline' }
    case '</sub>':
    case '</sup>':
      return { close: 'subsup' }
    case '</span>':
      return { close: 'textColor' }
    default:
      return null
  }
}

function withMark(marks: AdfMarkSpec[], mark: AdfMarkSpec): AdfMarkSpec[] {
  return [...marks.filter((m) => m.type !== mark.type), mark]
}

function phrasingToAdf(
  nodes: PhrasingContent[],
  marks: AdfMarkSpec[],
  ctx: WriteContext,
  out: AdfNode[] = [],
): AdfNode[] {
  const htmlMarks: AdfMarkSpec[] = []
  const active = (): AdfMarkSpec[] => [...marks, ...htmlMarks]
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out.push(...textNodes(node.value, active()))
        break
      case 'break':
        out.push({ type: 'hardBreak' })
        break
      case 'emphasis':
        phrasingToAdf(node.children, withMark(active(), { type: 'em' }), ctx, out)
        break
      case 'strong':
        phrasingToAdf(node.children, withMark(active(), { type: 'strong' }), ctx, out)
        break
      case 'delete':
        phrasingToAdf(node.children, withMark(active(), { type: 'strike' }), ctx, out)
        break
      case 'inlineCode': {
        const current = active()
        if (current.some((mark) => mark.type !== 'link')) {
          refuse(
            ctx,
            node,
            'Jira inline code can only be combined with a link, not other formatting.',
          )
        }
        out.push({ type: 'text', text: node.value, marks: [...current, { type: 'code' }] })
        break
      }
      case 'link':
        linkToAdf(node, active(), out, ctx)
        break
      case 'linkReference': {
        const definition = ctx.definitions.get(node.identifier)
        if (!definition) {
          refuse(ctx, node, `Link reference [${node.label ?? node.identifier}] has no definition.`)
          break
        }
        const link: Link = {
          type: 'link',
          url: definition.url,
          title: definition.title,
          children: node.children,
        }
        linkToAdf(link, active(), out, ctx)
        break
      }
      case 'html': {
        const tag = htmlMark(node.value)
        if (tag && 'open' in tag) {
          htmlMarks.push(tag.open)
        } else if (tag && htmlMarks.at(-1)?.type === tag.close) {
          htmlMarks.pop()
        } else {
          // Any other tag, such as `<integer>` or `<Suspense>`, is literal
          // text: Jira has no HTML, and it reads back escaped (`\<integer>`).
          out.push(...textNodes(node.value, active()))
        }
        break
      }
      default:
        refuse(ctx, node, `A markdown ${node.type} cannot be written to Jira.`)
    }
  }
  if (htmlMarks.length > 0) {
    refuse(ctx, null, `Unclosed inline HTML mark (${htmlMarks.map((m) => m.type).join(', ')}).`)
  }
  return mergeTextRuns(out)
}

// Literal HTML arrives as its own markdown node, so `a <x> b` would write three
// text nodes while its read-back `a \<x> b` writes one. Jira stores them as
// sent, and the description hash covers the stored document, so adjacent runs
// with the same marks are merged to make a re-save of the read-back a no-op.
function mergeTextRuns(nodes: AdfNode[]): AdfNode[] {
  const merged: AdfNode[] = []
  for (const node of nodes) {
    const previous = merged.at(-1)
    if (
      previous?.type === 'text' &&
      node.type === 'text' &&
      JSON.stringify(previous['marks'] ?? []) === JSON.stringify(node['marks'] ?? [])
    ) {
      merged[merged.length - 1] = { ...previous, text: `${previous['text']}${node['text']}` }
    } else {
      merged.push(node)
    }
  }
  return merged
}

interface ExpandSegment {
  title: string
  lines: string[]
  firstLine: number
  children: Segment[]
}

type Segment =
  | { kind: 'markdown'; lines: string[]; firstLine: number }
  | ({ kind: 'expand' } & ExpandSegment)

interface SplitResult {
  segments: Segment[]
  /** Index of the closing `:::` line, or of the end of input. */
  end: number
  closed: boolean
}

// Zero-based indexes of the lines inside code blocks, anywhere in the tree.
function codeLineIndexes(tree: Root): Set<number> {
  const out = new Set<number>()
  const walk = (node: Nodes): void => {
    if (node.type === 'code' && node.position) {
      for (let line = node.position.start.line; line <= node.position.end.line; line += 1) {
        out.add(line - 1)
      }
    }
    if ('children' in node) for (const child of node.children) walk(child)
  }
  walk(tree)
  return out
}

// `::: expand` fences are not markdown, so they are split out before parsing.
// Lines inside code blocks never open or close an expand.
function splitSegments(
  lines: string[],
  codeLines: ReadonlySet<number>,
  start: number,
  nested: boolean,
): SplitResult {
  const segments: Segment[] = []
  let chunk: string[] = []
  let chunkStart = start
  const flush = (next: number): void => {
    if (chunk.length > 0) segments.push({ kind: 'markdown', lines: chunk, firstLine: chunkStart })
    chunk = []
    chunkStart = next
  }
  let i = start
  while (i < lines.length) {
    const line = lines[i]!
    if (codeLines.has(i)) {
      chunk.push(line)
      i += 1
      continue
    }
    if (nested && EXPAND_CLOSE.test(line)) {
      flush(i + 1)
      return { segments, end: i, closed: true }
    }
    const open = line.match(EXPAND_OPEN)
    if (open) {
      const inner = splitSegments(lines, codeLines, i + 1, true)
      if (inner.closed) {
        flush(inner.end + 1)
        segments.push({
          kind: 'expand',
          title: unescapeTitle(open[1] ?? ''),
          lines: [],
          firstLine: i,
          children: inner.segments,
        })
        i = inner.end + 1
        chunkStart = i
        continue
      }
    }
    chunk.push(line)
    i += 1
  }
  flush(i)
  return { segments, end: i, closed: false }
}

function segmentsToAdf(
  segments: Segment[],
  depth: number,
  issues: MarkdownWriteIssue[],
): AdfNode[] {
  const out: AdfNode[] = []
  for (const segment of segments) {
    if (segment.kind === 'expand') {
      if (depth > 1) {
        issues.push({
          code: 'unsupported_markdown',
          message: 'Jira expands can only be nested one level deep.',
          line: segment.firstLine + 1,
        })
      }
      const content = segmentsToAdf(segment.children, depth + 1, issues)
      const node: AdfNode = {
        type: depth === 0 ? 'expand' : 'nestedExpand',
        attrs: { title: segment.title },
        content: content.length > 0 ? content : [emptyParagraph()],
      }
      out.push(node)
      continue
    }
    const source = segment.lines.join('\n')
    const tree = parseTree(source)
    const definitions = new Map<string, Definition>()
    collectDefinitions(tree, definitions)
    const ctx: WriteContext = { issues, definitions, lineOffset: segment.firstLine, source }
    const scope: FlowScope = depth === 0 ? 'doc' : depth === 1 ? 'expand' : 'nestedExpand'
    out.push(...flowToAdf(tree.children, scope, ctx))
  }
  return out
}

export interface ParsedMarkdown {
  document: AdfDocument
  issues: MarkdownWriteIssue[]
}

export function parseMarkdown(markdown: string): ParsedMarkdown {
  const issues: MarkdownWriteIssue[] = []
  const lines = markdown.split(/\r?\n/)
  const { segments } = splitSegments(lines, codeLineIndexes(parseTree(lines.join('\n'))), 0, false)
  const content = segmentsToAdf(segments, 0, issues)
  assignLocalIds(content)
  return { document: { version: 1, type: 'doc', content }, issues }
}

// Jira requires a localId on task lists, task items, tables and statuses, and
// stores whatever is sent. A random id would change the stored document, and so
// the description hash, every time the same markdown is written, which reads as
// an edit nobody made. Each id is instead derived from the node's place in the
// document and its content, so the same markdown always writes the same
// document, and identical nodes at different places still get distinct ids.
const PENDING_LOCAL_ID = 'pending-local-id'

function assignLocalIds(nodes: JsonValue[], path = ''): void {
  nodes.forEach((node, index) => {
    if (!isJsonObject(node)) return
    const at = `${path}/${index}`
    const children = node['content']
    if (Array.isArray(children)) assignLocalIds(children, at)
    const attrs = node['attrs']
    if (!isJsonObject(attrs) || attrs['localId'] !== PENDING_LOCAL_ID) return
    const digest = createHash('sha256')
      .update(`${at}\n${JSON.stringify({ ...node, attrs: { ...attrs, localId: null } })}`)
      .digest('hex')
    attrs['localId'] = [
      digest.slice(0, 8),
      digest.slice(8, 12),
      digest.slice(12, 16),
      digest.slice(16, 20),
      digest.slice(20, 32),
    ].join('-')
  })
}

const EXPAND_OPEN = /^::: expand(?: title="((?:\\.|[^"\\])*)")?$/

const EXPAND_CLOSE = /^:::$/

const COLOR_SPAN_OPEN = /^<span style="color: (#[0-9a-f]{6})">$/i
