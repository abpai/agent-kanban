// ADF -> markdown. Builds an mdast tree and serializes it with
// mdast-util-to-markdown. Every node becomes markdown or a visible marker plus a
// warning; nothing is skipped.

// oxlint-disable anti-slop/no-runtime-typeof -- ADF arrives from Jira as untyped JSON; these checks are the decode boundary.
import type {
  Blockquote,
  Code,
  Heading,
  Html,
  Link,
  List,
  ListItem,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Table,
  TableCell,
  TableRow,
} from 'mdast'
import { gfmStrikethroughToMarkdown } from 'mdast-util-gfm-strikethrough'
import { gfmTableToMarkdown } from 'mdast-util-gfm-table'
import { gfmTaskListItemToMarkdown } from 'mdast-util-gfm-task-list-item'
import { toMarkdown, type Options as ToMarkdownOptions } from 'mdast-util-to-markdown'

import type { JsonValue } from '../../json'
import {
  DATE_SCHEME,
  EMOJI_SCHEME,
  MARKER_PREFIX,
  MENTION_SCHEME,
  STATUS_SCHEME,
  asNode,
  attrsOf,
  childNodes,
  escapeTitle,
  hoistEdgeWhitespace,
  markKey,
  markRank,
  marksOf,
  numberAttr,
  stringAttr,
  textOf,
  type AdfConversionWarning,
  type AdfMarkSpec,
  type AdfNode,
} from './model'
import { normalizeMarks } from './normalize'

const AUTOLINK_URL = /^[a-z][a-z0-9+.-]{1,31}:[^\s<>]*$/i

const HTML_MARK_TAGS = new Map<string, string>([
  ['underline', 'u'],
  ['subsup:sub', 'sub'],
  ['subsup:sup', 'sup'],
])

const TO_MARKDOWN: ToMarkdownOptions = {
  extensions: [gfmTableToMarkdown(), gfmStrikethroughToMarkdown(), gfmTaskListItemToMarkdown()],
  bullet: '-',
  bulletOther: '*',
  emphasis: '*',
  strong: '*',
  fence: '`',
  fences: true,
  listItemIndent: 'one',
  resourceLink: true,
  rule: '-',
}

interface ReadContext {
  warnings: AdfConversionWarning[]
}

function warn(
  ctx: ReadContext,
  warning: Omit<AdfConversionWarning, 'path'> & { path: string },
): void {
  ctx.warnings.push(warning)
}

function describeUnsupported(node: AdfNode): string {
  const attrs = attrsOf(node)
  const details: string[] = []
  for (const key of ['panelType', 'url', 'text', 'alt', 'extensionKey', 'title', 'timestamp']) {
    const value = attrs[key]
    if (typeof value === 'string' && value.length > 0)
      details.push(`${key}=${JSON.stringify(value)}`)
  }
  return details.length > 0 ? `${node.type} ${details.join(' ')}` : node.type
}

function markerText(node: AdfNode): string {
  return `[${MARKER_PREFIX}${describeUnsupported(node)}]`
}

function rawFlow(value: string): Html {
  return { type: 'html', value }
}

function unsupportedNode(node: AdfNode, path: string, ctx: ReadContext): RootContent[] {
  warn(ctx, {
    code: 'unsupported_node',
    nodeType: node.type,
    path,
    message: `Jira ${node.type} has no markdown form; rendered as a marker.`,
  })
  const children = childNodes(node)
  if (children.length === 0) return [rawFlow(markerText(node))]
  const inner = children.every(isInlineNode)
    ? [paragraphFromInline(children, `${path}.content`, ctx)]
    : blocksToMdast(children, `${path}.content`, ctx, false)
  return [rawFlow(markerText(node)), ...inner, rawFlow(`[end ${MARKER_PREFIX}${node.type}]`)]
}

const INLINE_TYPES = new Set([
  'text',
  'hardBreak',
  'mention',
  'emoji',
  'inlineCard',
  'status',
  'date',
  'placeholder',
  'inlineExtension',
  'mediaInline',
])

function isInlineNode(node: AdfNode): boolean {
  return INLINE_TYPES.has(node.type)
}

function paragraphFromInline(nodes: AdfNode[], path: string, ctx: ReadContext): Paragraph {
  return {
    type: 'paragraph',
    children: rawBreaksBeforeHtml(inlineToMdast(trimBreaks(nodes), path, ctx)),
  }
}

// The serializer writes a line break followed by a character reference (the
// escaped `:::`) as a space, so that break is written raw together with it.
function rawBreaksBeforeHtml(children: PhrasingContent[]): PhrasingContent[] {
  const out: PhrasingContent[] = []
  for (const child of children) {
    const previous = out.at(-1)
    if (child.type === 'html' && child.value.startsWith('&') && previous?.type === 'break') {
      out[out.length - 1] = { type: 'html', value: `\\\n${child.value}` }
      continue
    }
    if ('children' in child) child.children = rawBreaksBeforeHtml(child.children)
    out.push(child)
  }
  return out
}

// Line breaks that open or close a paragraph are blank space in Jira, and
// markdown has no way to write them (a closing one becomes a literal
// backslash). normalizeAdf drops them the same way.
function trimBreaks(nodes: AdfNode[]): AdfNode[] {
  let start = 0
  let end = nodes.length
  while (start < end && nodes[start]!.type === 'hardBreak') start += 1
  while (end > start && nodes[end - 1]!.type === 'hardBreak') end -= 1
  return nodes.slice(start, end)
}

function warnBlockMarks(node: AdfNode, path: string, ctx: ReadContext): void {
  for (const mark of marksOf(node)) {
    warn(ctx, {
      code: 'unsupported_mark',
      nodeType: mark.type,
      path,
      message: `Block mark ${mark.type} on ${node.type} has no markdown form; content kept without it.`,
    })
  }
}

function isEmptyParagraph(node: AdfNode): boolean {
  return node.type === 'paragraph' && childNodes(node).length === 0
}

function blocksToMdast(
  nodes: AdfNode[],
  path: string,
  ctx: ReadContext,
  allowExpand: boolean,
): RootContent[] {
  const out: RootContent[] = []
  nodes.forEach((node, index) => {
    // Empty paragraphs are vertical spacing in Jira; markdown collapses them.
    if (isEmptyParagraph(node)) return
    for (const block of blockToMdast(node, `${path}[${index}]`, ctx, allowExpand)) {
      if (block.type === 'paragraph' && block.children.length === 0) continue
      out.push(block)
    }
  })
  return out
}

function blockToMdast(
  node: AdfNode,
  path: string,
  ctx: ReadContext,
  allowExpand: boolean,
): RootContent[] {
  switch (node.type) {
    case 'paragraph':
      warnBlockMarks(node, path, ctx)
      return [paragraphFromInline(childNodes(node), `${path}.content`, ctx)]
    case 'heading': {
      warnBlockMarks(node, path, ctx)
      const level = numberAttr(node, 'level') ?? 1
      const depth = Math.min(6, Math.max(1, level))
      const heading: Heading = {
        type: 'heading',
        // SAFETY: clamped to 1..6 on the line above.
        depth: depth as Heading['depth'],
        children: inlineToMdast(trimBreaks(childNodes(node)), `${path}.content`, ctx),
      }
      return [heading]
    }
    case 'bulletList':
    case 'orderedList':
      return [listToMdast(node, path, ctx)]
    case 'taskList':
      return [taskListToMdast(node, path, ctx)]
    case 'codeBlock': {
      warnBlockMarks(node, path, ctx)
      const language = stringAttr(node, 'language')
      const code: Code = {
        type: 'code',
        lang: language && language.length > 0 ? language : null,
        value: childNodes(node).map(textOf).join(''),
      }
      return [code]
    }
    case 'blockquote': {
      const quote: Blockquote = {
        type: 'blockquote',
        // SAFETY: blockquote children are flow content; ADF only nests blocks here.
        children: blocksToMdast(
          childNodes(node),
          `${path}.content`,
          ctx,
          false,
        ) as Blockquote['children'],
      }
      return [quote]
    }
    case 'rule':
      return [{ type: 'thematicBreak' }]
    case 'table':
      return tableToMdast(node, path, ctx)
    case 'expand':
    case 'nestedExpand':
      if (!allowExpand) return unsupportedNode(node, path, ctx)
      warnBlockMarks(node, path, ctx)
      return [expandToMdast(node, path, ctx)]
    default:
      if (isInlineNode(node)) return [paragraphFromInline([node], path, ctx)]
      return unsupportedNode(node, path, ctx)
  }
}

function listItemChildren(item: AdfNode, path: string, ctx: ReadContext): ListItem['children'] {
  const children = item.type === 'listItem' ? childNodes(item) : [item]
  // SAFETY: list item children are flow content produced by blocksToMdast.
  return blocksToMdast(children, `${path}.content`, ctx, false) as ListItem['children']
}

// CommonMark lets only a list starting at 1 interrupt a paragraph. Any other
// list after a paragraph needs a blank line, which makes the item loose.
function needsLooseItem(children: ListItem['children']): boolean {
  return children.some((child, index) => {
    const previous = children[index - 1]
    return (
      previous?.type === 'paragraph' &&
      child.type === 'list' &&
      ((child.ordered === true && (child.start ?? 1) !== 1) ||
        child.children[0]?.children.length === 0)
    )
  })
}

function listToMdast(node: AdfNode, path: string, ctx: ReadContext): List {
  const ordered = node.type === 'orderedList'
  const list: List = {
    type: 'list',
    ordered,
    spread: false,
    children: childNodes(node).map((item, index): ListItem => {
      const children = listItemChildren(item, `${path}.content[${index}]`, ctx)
      return { type: 'listItem', spread: needsLooseItem(children), children }
    }),
  }
  if (ordered) list.start = numberAttr(node, 'order') ?? 1
  return list
}

function taskListToMdast(node: AdfNode, path: string, ctx: ReadContext): List {
  const items: ListItem[] = []
  childNodes(node).forEach((child, index) => {
    const childPath = `${path}.content[${index}]`
    if (child.type === 'taskList') {
      const nested = taskListToMdast(child, childPath, ctx)
      const previous = items.at(-1)
      if (previous) {
        previous.children.push(nested)
        return
      }
      warn(ctx, {
        code: 'unsupported_layout',
        nodeType: 'taskList',
        path: childPath,
        message: 'A task list that starts with a nested task list has no markdown form.',
      })
      items.push({ type: 'listItem', spread: false, checked: false, children: [nested] })
      return
    }
    if (child.type !== 'taskItem') {
      items.push({
        type: 'listItem',
        spread: false,
        checked: false,
        // SAFETY: unsupported nodes render as flow content.
        children: unsupportedNode(child, childPath, ctx) as ListItem['children'],
      })
      return
    }
    const inline = inlineToMdast(childNodes(child), `${childPath}.content`, ctx)
    items.push({
      type: 'listItem',
      spread: false,
      checked: stringAttr(child, 'state') === 'DONE',
      children: inline.length > 0 ? [{ type: 'paragraph', children: inline }] : [],
    })
  })
  return { type: 'list', ordered: false, spread: false, children: items }
}

function expandToMdast(node: AdfNode, path: string, ctx: ReadContext): Html {
  const title = stringAttr(node, 'title') ?? ''
  const open = title.length > 0 ? `::: expand title="${escapeTitle(title)}"` : '::: expand'
  const inner = serialize(blocksToMdast(childNodes(node), `${path}.content`, ctx, true))
  return rawFlow(inner.length > 0 ? `${open}\n${inner}\n:::` : `${open}\n:::`)
}

// Tables map to GFM only when GFM can hold them: a header row, then body rows,
// every cell one paragraph without line breaks, and no merged cells. Anything
// else still renders as a GFM table so no text is lost, behind a marker.
function tableLayoutProblem(rows: AdfNode[]): string | null {
  if (rows.length === 0) return 'no rows'
  const width = childNodes(rows[0]!).length
  for (const [rowIndex, row] of rows.entries()) {
    if (row.type !== 'tableRow') return `${row.type} inside table`
    const cells = childNodes(row)
    if (cells.length !== width) return 'rows of different widths'
    for (const cell of cells) {
      const expected = rowIndex === 0 ? 'tableHeader' : 'tableCell'
      if (cell.type !== expected) {
        return rowIndex === 0
          ? 'first row is not a header row'
          : 'header cell outside the first row'
      }
      const colspan = numberAttr(cell, 'colspan') ?? 1
      const rowspan = numberAttr(cell, 'rowspan') ?? 1
      if (colspan !== 1 || rowspan !== 1) return 'merged cells'
      if (stringAttr(cell, 'background')) return 'cell background colors'
      const blocks = childNodes(cell).filter((child) => !isEmptyParagraph(child))
      if (blocks.length > 1) return 'cells with several blocks'
      const only = blocks[0]
      if (only && only.type !== 'paragraph') return `${only.type} inside a cell`
      if (only && childNodes(only).some((inline) => inline.type === 'hardBreak')) {
        return 'line breaks inside a cell'
      }
      if (only && childNodes(only).some((inline) => textOf(inline).includes('\n'))) {
        return 'line breaks inside a cell'
      }
    }
  }
  return null
}

function flattenCell(cell: AdfNode, path: string, ctx: ReadContext): PhrasingContent[] {
  const out: PhrasingContent[] = []
  childNodes(cell).forEach((block, index) => {
    const blockPath = `${path}.content[${index}]`
    const inline = isInlineNode(block) ? [block] : collectInline(block)
    const phrasing = inlineToMdast(inline, blockPath, ctx).flatMap((node) =>
      node.type === 'break' ? [{ type: 'text' as const, value: ' ' }] : [node],
    )
    if (phrasing.length === 0) return
    if (out.length > 0) out.push({ type: 'text', value: ' / ' })
    out.push(...phrasing)
  })
  return out
}

function collectInline(node: AdfNode): AdfNode[] {
  if (isInlineNode(node)) return [node]
  const out: AdfNode[] = []
  for (const child of childNodes(node)) {
    if (out.length > 0 && !isInlineNode(child)) out.push({ type: 'text', text: ' ' })
    out.push(...collectInline(child))
  }
  return out
}

function tableToMdast(node: AdfNode, path: string, ctx: ReadContext): RootContent[] {
  const rows = childNodes(node)
  let problem = tableLayoutProblem(rows)
  if (!problem && node['attrs'] !== undefined && attrsOf(node)['isNumberColumnEnabled'] === true) {
    problem = 'numbered rows'
  }
  if (!problem) {
    const table: Table = {
      type: 'table',
      align: [],
      children: rows.map(
        (row, rowIndex): TableRow => ({
          type: 'tableRow',
          children: childNodes(row).map((cell, cellIndex): TableCell => {
            const cellPath = `${path}.content[${rowIndex}].content[${cellIndex}]`
            const paragraph = childNodes(cell).find((child) => !isEmptyParagraph(child))
            return {
              type: 'tableCell',
              children: paragraph
                ? inlineToMdast(childNodes(paragraph), `${cellPath}.content[0].content`, ctx)
                : [],
            }
          }),
        }),
      ),
    }
    return [table]
  }

  warn(ctx, {
    code: 'unsupported_layout',
    nodeType: 'table',
    path,
    message: `Jira table has ${problem}, which a markdown table cannot hold; rendered flattened behind a marker.`,
  })
  const width = Math.max(1, ...rows.map((row) => childNodes(row).length))
  const flattened: TableRow[] = rows.map((row, rowIndex) => {
    const cells = childNodes(row).map(
      (cell, cellIndex): TableCell => ({
        type: 'tableCell',
        children: flattenCell(cell, `${path}.content[${rowIndex}].content[${cellIndex}]`, ctx),
      }),
    )
    while (cells.length < width) cells.push({ type: 'tableCell', children: [] })
    return { type: 'tableRow', children: cells }
  })
  return [
    rawFlow(`[${MARKER_PREFIX}table layout (${problem})]`),
    { type: 'table', align: [], children: flattened },
  ]
}

interface InlineFrame {
  key: string
  container: PhrasingContent[]
  close?: string
}

const SUPPORTED_TEXT_MARKS = new Set([
  'strong',
  'em',
  'strike',
  'code',
  'link',
  'underline',
  'subsup',
  'textColor',
])

function supportedMarks(node: AdfNode, path: string, ctx: ReadContext): AdfMarkSpec[] {
  const out: AdfMarkSpec[] = []
  for (const mark of marksOf(node)) {
    if (isRenderableMark(mark)) {
      out.push(mark)
      continue
    }
    warn(ctx, {
      code: 'unsupported_mark',
      nodeType: mark.type,
      path,
      message: `Text mark ${mark.type} has no markdown form; text kept without it.`,
    })
  }
  return out.sort((a, b) => markRank(a.type) - markRank(b.type))
}

function isRenderableMark(mark: AdfMarkSpec): boolean {
  if (!SUPPORTED_TEXT_MARKS.has(mark.type)) return false
  if (mark.type === 'link') return (stringAttr(mark, 'href') ?? '').length > 0
  if (mark.type === 'subsup') {
    const kind = stringAttr(mark, 'type')
    return kind === 'sub' || kind === 'sup'
  }
  if (mark.type === 'textColor') return /^#[0-9a-f]{6}$/i.test(stringAttr(mark, 'color') ?? '')
  return true
}

// Two adjacent text nodes with the same marks are one run to a reader, and
// rendering them apart can change the markdown (two code spans touching).
function mergeAdjacentText(nodes: AdfNode[]): AdfNode[] {
  const out: AdfNode[] = []
  for (const node of nodes) {
    const previous = out.at(-1)
    if (
      previous?.type === 'text' &&
      node.type === 'text' &&
      JSON.stringify(normalizeMarks(previous['marks'])) ===
        JSON.stringify(normalizeMarks(node['marks']))
    ) {
      out[out.length - 1] = { ...previous, text: textOf(previous) + textOf(node) }
      continue
    }
    out.push(node)
  }
  return out
}

function inlineToMdast(adfNodes: AdfNode[], path: string, ctx: ReadContext): PhrasingContent[] {
  const nodes = mergeAdjacentText(adfNodes.flatMap(hoistEdgeWhitespace))
  const root: PhrasingContent[] = []
  const stack: InlineFrame[] = []
  const current = (): PhrasingContent[] => stack.at(-1)?.container ?? root

  const closeTo = (depth: number): void => {
    while (stack.length > depth) {
      const frame = stack.pop()!
      if (frame.close) current().push({ type: 'html', value: frame.close })
    }
  }

  const open = (mark: AdfMarkSpec): void => {
    const into = current()
    const key = markKey(mark)
    switch (mark.type) {
      case 'link': {
        const link: Link = { type: 'link', url: stringAttr(mark, 'href') ?? '', children: [] }
        const title = stringAttr(mark, 'title')
        if (title) link.title = title
        into.push(link)
        stack.push({ key, container: link.children })
        return
      }
      case 'strong':
      case 'strike':
      case 'em': {
        const children: PhrasingContent[] = []
        const wrapper: PhrasingContent =
          mark.type === 'em'
            ? { type: 'emphasis', children }
            : mark.type === 'strike'
              ? { type: 'delete', children }
              : { type: 'strong', children }
        into.push(wrapper)
        stack.push({ key, container: children })
        return
      }
      default: {
        const tag =
          mark.type === 'textColor'
            ? null
            : (HTML_MARK_TAGS.get(
                mark.type === 'subsup' ? `subsup:${stringAttr(mark, 'type')}` : mark.type,
              ) ?? null)
        const openTag = tag
          ? `<${tag}>`
          : `<span style="color: ${(stringAttr(mark, 'color') ?? '').toLowerCase()}">`
        into.push({ type: 'html', value: openTag })
        stack.push({ key, container: into, close: tag ? `</${tag}>` : '</span>' })
      }
    }
  }

  nodes.forEach((node, index) => {
    const nodePath = `${path}[${index}]`
    const marks = node.type === 'text' ? supportedMarks(node, nodePath, ctx) : []
    if (node.type !== 'text') {
      for (const mark of marksOf(node)) {
        warn(ctx, {
          code: 'unsupported_mark',
          nodeType: mark.type,
          path: nodePath,
          message: `Mark ${mark.type} on ${node.type} has no markdown form; node kept without it.`,
        })
      }
    }
    const frames = marks.filter((mark) => mark.type !== 'code')
    let shared = 0
    while (
      shared < stack.length &&
      shared < frames.length &&
      stack[shared]!.key === markKey(frames[shared]!)
    ) {
      shared += 1
    }
    closeTo(shared)
    for (const mark of frames.slice(shared)) open(mark)
    current().push(...inlineLeaf(node, marks, nodePath, ctx))
  })
  closeTo(0)
  return root
}

function textWithBreaks(value: string): PhrasingContent[] {
  const out: PhrasingContent[] = []
  value.split('\n').forEach((line, index) => {
    if (index > 0) out.push({ type: 'break' })
    // `:::` opens and closes expands, so text spelling it writes the first
    // colon as a character reference.
    line.split(':::').forEach((piece, pieceIndex) => {
      if (pieceIndex > 0) out.push({ type: 'html', value: '&#x3A;' }, { type: 'text', value: '::' })
      if (piece.length > 0) out.push({ type: 'text', value: piece })
    })
  })
  return out
}

// Ids such as Atlassian account ids contain `:`; keep them readable.
function encodeSchemeValue(value: string): string {
  return encodeURIComponent(value).replace(/%3A/gi, ':')
}

function schemeLink(url: string, label: string): Link {
  return {
    type: 'link',
    url,
    children: label.length > 0 ? [{ type: 'text', value: label }] : [],
  }
}

function inlineLeaf(
  node: AdfNode,
  marks: AdfMarkSpec[],
  path: string,
  ctx: ReadContext,
): PhrasingContent[] {
  switch (node.type) {
    case 'text': {
      const text = textOf(node)
      if (text.length === 0) return []
      if (marks.some((mark) => mark.type === 'code')) return [{ type: 'inlineCode', value: text }]
      return textWithBreaks(text)
    }
    case 'hardBreak':
      return [{ type: 'break' }]
    case 'mention': {
      const id = stringAttr(node, 'id') ?? ''
      return [
        schemeLink(`${MENTION_SCHEME}${encodeSchemeValue(id)}`, stringAttr(node, 'text') ?? ''),
      ]
    }
    case 'emoji': {
      const id = stringAttr(node, 'id') ?? ''
      return [
        schemeLink(`${EMOJI_SCHEME}${encodeSchemeValue(id)}`, stringAttr(node, 'shortName') ?? ''),
      ]
    }
    case 'status': {
      const color = stringAttr(node, 'color') ?? 'neutral'
      return [
        schemeLink(`${STATUS_SCHEME}${encodeSchemeValue(color)}`, stringAttr(node, 'text') ?? ''),
      ]
    }
    case 'date': {
      const timestamp = stringAttr(node, 'timestamp') ?? String(numberAttr(node, 'timestamp') ?? '')
      if (!/^\d+$/.test(timestamp)) break
      const label = new Date(Number(timestamp)).toISOString().slice(0, 10)
      return [schemeLink(`${DATE_SCHEME}${timestamp}`, label)]
    }
    case 'inlineCard': {
      const url = stringAttr(node, 'url') ?? ''
      if (!AUTOLINK_URL.test(url)) break
      return [{ type: 'html', value: `<${url}>` }]
    }
    default:
      break
  }
  warn(ctx, {
    code: 'unsupported_node',
    nodeType: node.type,
    path,
    message: `Jira ${node.type} has no markdown form; rendered as a marker.`,
  })
  return [{ type: 'html', value: markerText(node) }]
}

function serialize(children: RootContent[]): string {
  if (children.length === 0) return ''
  const root: Root = { type: 'root', children }
  return toMarkdown(root, TO_MARKDOWN).replace(/\n+$/, '')
}

export function documentContent(doc: JsonValue | undefined): AdfNode[] | null {
  const node = asNode(doc)
  if (!node || node.type !== 'doc' || !Array.isArray(node['content'])) return null
  return childNodes(node)
}

export interface RenderedMarkdown {
  markdown: string
  warnings: AdfConversionWarning[]
}

/** Renders doc content. Unsupported content becomes markers plus warnings. */
export function renderAdfBlocks(content: AdfNode[]): RenderedMarkdown {
  const ctx: ReadContext = { warnings: [] }
  return {
    markdown: serialize(blocksToMdast(content, 'content', ctx, true)),
    warnings: ctx.warnings,
  }
}
