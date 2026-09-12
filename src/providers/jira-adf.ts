// Pure ADF (Atlassian Document Format) translation helpers.
//
// This module has no runtime dependencies: no provider stack, bun:sqlite, or fetch.
// It models only the subset of ADF
// that agent-kanban writes, plus a few Jira nodes it must preserve on read:
//
//   doc > { paragraph | bulletList | orderedList | codeBlock | heading | card }
//   paragraph / heading / codeBlock > text(inline) | inlineCard | hardBreak
//   bulletList / orderedList > listItem > paragraph > text
//
// Other unknown node types are tolerated on the read path (skipped silently)
// and never emitted on the write path.

import type { JsonObject } from '../json'

interface AdfNode extends JsonObject {
  type: string
  attrs?: JsonObject
}

export interface AdfDocument extends AdfNode {
  version: 1
  type: 'doc'
  content: AdfBlockNode[]
}

interface AdfMark extends JsonObject {
  type: string
  attrs?: JsonObject
}

interface AdfTextNode extends AdfNode {
  type: 'text'
  text: string
  marks?: AdfMark[]
}

type AdfInlineNode = AdfTextNode | AdfNode

interface AdfParagraphNode extends AdfNode {
  type: 'paragraph'
  content?: AdfInlineNode[]
}

interface AdfListItemNode extends AdfNode {
  type: 'listItem'
  content: AdfBlockNode[]
}

interface AdfBulletListNode extends AdfNode {
  type: 'bulletList'
  content: AdfListItemNode[]
}

interface AdfOrderedListNode extends AdfNode {
  type: 'orderedList'
  content: AdfListItemNode[]
  attrs?: { order?: number }
}

interface AdfCodeBlockNode extends AdfNode {
  type: 'codeBlock'
  attrs?: { language?: string }
  content?: AdfInlineNode[]
}

interface AdfHeadingNode extends AdfNode {
  type: 'heading'
  attrs: { level: number }
  content?: AdfInlineNode[]
}

interface AdfExpandNode extends AdfNode {
  type: 'expand'
  attrs?: { title?: string }
  content: AdfBlockNode[]
}

type AdfKnownBlockNode =
  | AdfParagraphNode
  | AdfBulletListNode
  | AdfOrderedListNode
  | AdfCodeBlockNode
  | AdfHeadingNode
  | AdfExpandNode

type AdfBlockNode = AdfKnownBlockNode | AdfNode
type AdfKnownNode = AdfKnownBlockNode | AdfTextNode

// ADF uses `type` as its schema discriminator. Keep unknown node types on the
// read path while recovering the known node contract at each supported branch.
function hasAdfType<T extends AdfKnownNode['type']>(
  node: AdfNode,
  type: T,
): node is Extract<AdfKnownNode, { type: T }> {
  return node.type === type
}

function hasStringAttribute<K extends string>(
  attrs: JsonObject | undefined,
  key: K,
): attrs is JsonObject & Record<K, string> {
  return typeof attrs?.[key] === 'string' && attrs[key].length > 0
}

const BULLET_MARKER = /^[-*] (.*)$/
const ORDERED_MARKER = /^(\d+)\. (.*)$/
// Opening/closing fence: `` ``` `` optionally followed by a language tag with
// no whitespace before it. Fence must occupy the whole line.
const FENCE_OPEN = /^```([^\s`]*)$/
const FENCE_CLOSE = /^```$/
// Expand wrapper: `::: expand` or `::: expand title="..."`. Quotes and
// backslashes in the title are escaped with a leading `\`.
const EXPAND_OPEN = /^::: expand(?: title="((?:\\.|[^"\\])*)")?$/
const EXPAND_CLOSE = /^:::$/

function unescapeTitle(raw: string): string {
  return raw.replace(/\\(.)/g, '$1')
}

function escapeTitle(value: string): string {
  return value.replace(/(["\\])/g, '\\$1')
}

function paragraphFromText(text: string): AdfParagraphNode {
  if (text.length === 0) {
    return { type: 'paragraph' }
  }
  return {
    type: 'paragraph',
    content: tokenizeInline(text),
  }
}

function listItemFromText(text: string): AdfListItemNode {
  return {
    type: 'listItem',
    content: [paragraphFromText(text)],
  }
}

const INLINE_MARK = /\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g

function tokenizeInline(text: string): AdfTextNode[] {
  const out: AdfTextNode[] = []
  INLINE_MARK.lastIndex = 0
  let cursor = 0
  for (const match of text.matchAll(INLINE_MARK)) {
    const start = match.index ?? 0
    if (start > cursor) {
      out.push({ type: 'text', text: text.slice(cursor, start) })
    }
    const boldText = match[1]
    if (boldText !== undefined) {
      out.push({
        type: 'text',
        text: boldText,
        marks: [{ type: 'strong' }],
      })
    } else {
      out.push({
        type: 'text',
        text: match[2]!,
        marks: [{ type: 'link', attrs: { href: match[3]! } }],
      })
    }
    cursor = start + match[0].length
  }
  if (cursor < text.length) {
    out.push({ type: 'text', text: text.slice(cursor) })
  }
  return out
}

export function plainTextToAdf(text: string): AdfDocument {
  if (text.length === 0) {
    return { version: 1, type: 'doc', content: [] }
  }
  const lines = text.split('\n')
  const { blocks } = parseBlocks(lines, 0, () => false)
  return { version: 1, type: 'doc', content: blocks }
}

interface ParseResult {
  blocks: AdfBlockNode[]
  // Index just past the last consumed line. When `stop` matches, this points
  // at the stop line itself (the caller is responsible for stepping past it).
  endIndex: number
}

interface ParsedBlock {
  block: AdfBlockNode
  endIndex: number
}

function parseCodeBlock(lines: string[], start: number, language: string): ParsedBlock | null {
  const codeLines: string[] = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (!FENCE_CLOSE.test(line)) {
      codeLines.push(line)
      continue
    }
    const block: AdfCodeBlockNode = { type: 'codeBlock' }
    if (language.length > 0) block.attrs = { language }
    const code = codeLines.join('\n')
    if (code.length > 0) block.content = [{ type: 'text', text: code }]
    return { block, endIndex: i + 1 }
  }
  return null
}

function parseList(lines: string[], start: number): ParsedBlock | null {
  const firstLine = lines[start] ?? ''
  const ordered = ORDERED_MARKER.test(firstLine)
  const marker = ordered ? ORDERED_MARKER : BULLET_MARKER
  const first = firstLine.match(marker)
  if (!first) return null
  const contentIndex = ordered ? 2 : 1
  const items: AdfListItemNode[] = []
  let i = start
  while (i < lines.length) {
    const match = (lines[i] ?? '').match(marker)
    if (!match) break
    items.push(listItemFromText(match[contentIndex] ?? ''))
    i += 1
  }
  if (!ordered) return { block: { type: 'bulletList', content: items }, endIndex: i }
  const block: AdfOrderedListNode = { type: 'orderedList', content: items }
  const firstNumber = Number.parseInt(first[1] ?? '1', 10)
  if (firstNumber !== 1) block.attrs = { order: firstNumber }
  return { block, endIndex: i }
}

function parseBlocks(lines: string[], start: number, stop: (line: string) => boolean): ParseResult {
  const blocks: AdfBlockNode[] = []
  let i = start
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (stop(line)) {
      return { blocks, endIndex: i }
    }

    // Blank line separates blocks — consume and move on.
    if (line === '') {
      i += 1
      continue
    }

    // Expand wrapper.
    const expandOpen = line.match(EXPAND_OPEN)
    if (expandOpen) {
      const title = unescapeTitle(expandOpen[1] ?? '')
      const inner = parseBlocks(lines, i + 1, (l) => EXPAND_CLOSE.test(l))
      if (inner.endIndex < lines.length) {
        blocks.push({ type: 'expand', attrs: { title }, content: inner.blocks })
        i = inner.endIndex + 1
        continue
      }
      // Unterminated `::: expand` — fall through to paragraph.
    }

    // Fenced code block.
    const fenceOpen = line.match(FENCE_OPEN)
    if (fenceOpen) {
      const code = parseCodeBlock(lines, i, fenceOpen[1] ?? '')
      if (code) {
        blocks.push(code.block)
        i = code.endIndex
        continue
      }
      // Unterminated fence — fall through and treat as a paragraph.
    }

    const list = parseList(lines, i)
    if (list) {
      blocks.push(list.block)
      i = list.endIndex
      continue
    }

    // Paragraph: consume until blank line, stop predicate, or a
    // block-starting line.
    const paragraphLines: string[] = [line]
    i += 1
    while (i < lines.length) {
      const current = lines[i] ?? ''
      if (
        current === '' ||
        stop(current) ||
        BULLET_MARKER.test(current) ||
        ORDERED_MARKER.test(current) ||
        FENCE_OPEN.test(current) ||
        EXPAND_OPEN.test(current)
      ) {
        break
      }
      paragraphLines.push(current)
      i += 1
    }
    blocks.push(paragraphFromText(paragraphLines.join('\n')))
  }

  return { blocks, endIndex: i }
}

function inlineText(
  nodes: AdfInlineNode[] | undefined,
  opts: { renderMarks?: boolean } = {},
): string {
  if (!nodes) return ''
  const renderMarks = opts.renderMarks ?? true
  let out = ''
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i]!
    if (hasAdfType(node, 'text')) {
      if (!renderMarks) {
        out += node.text
        continue
      }
      const nextNode = nodes[i + 1]
      const labelColon = readPlainTextLeadingColon(nextNode)
      if (labelColon && hasMark(node, 'strong')) {
        out += renderTextNode({ ...node, text: `${node.text}:` })
        out += labelColon.remainder
        i += 1
        continue
      }
      out += renderTextNode(node)
      continue
    }
    if (node.type === 'inlineCard') {
      const url = readCardUrl(node)
      if (url) out += url
      continue
    }
    if (node.type === 'hardBreak') {
      out += '\n'
      continue
    }
    // Other unknown inline nodes (mentions, emoji, etc.) are skipped.
  }
  return out
}

function hasMark(node: AdfTextNode, type: string): boolean {
  return node.marks?.some((m) => m.type === type) ?? false
}

function readPlainTextLeadingColon(node: AdfInlineNode | undefined): { remainder: string } | null {
  if (!node || !hasAdfType(node, 'text')) return null
  if (node.marks && node.marks.length > 0) return null
  if (!node.text.startsWith(':')) return null
  return { remainder: node.text.slice(1) }
}

function renderTextNode(node: AdfTextNode): string {
  if (!node.marks || node.marks.length === 0) return node.text
  const link = node.marks.find((m) => m.type === 'link')
  let out = node.text
  if (link && hasStringAttribute(link.attrs, 'href')) {
    out = `[${out}](${link.attrs.href})`
  }
  if (hasMark(node, 'strong')) {
    out = `**${out}**`
  }
  return out
}

function readCardUrl(node: AdfInlineNode | AdfBlockNode): string | null {
  return hasStringAttribute(node.attrs, 'url') ? node.attrs.url : null
}

function listItemInnerText(item: AdfListItemNode): string {
  // Each list item wraps a paragraph (or nested blocks). We flatten to the
  // first paragraph's inline text, which is all the write path produces.
  for (const child of item.content) {
    if (hasAdfType(child, 'paragraph')) {
      return inlineText(child.content)
    }
  }
  return ''
}

function renderBlock(node: AdfBlockNode): string | null {
  if (hasAdfType(node, 'paragraph') || hasAdfType(node, 'heading')) {
    return inlineText(node.content)
  }
  if (hasAdfType(node, 'bulletList')) {
    return node.content.map((item) => `- ${listItemInnerText(item)}`).join('\n')
  }
  if (hasAdfType(node, 'orderedList')) {
    const start = node.attrs?.order ?? 1
    return node.content.map((item, idx) => `${start + idx}. ${listItemInnerText(item)}`).join('\n')
  }
  if (hasAdfType(node, 'codeBlock')) {
    const language = node.attrs?.language ?? ''
    const body = inlineText(node.content, { renderMarks: false })
    const fence = language.length > 0 ? `\`\`\`${language}` : '```'
    return `${fence}\n${body}\n\`\`\``
  }
  if (hasAdfType(node, 'expand')) {
    const title = node.attrs?.title ?? ''
    const open = title.length > 0 ? `::: expand title="${escapeTitle(title)}"` : '::: expand'
    const inner = renderBlocks(node.content)
    return inner.length > 0 ? `${open}\n${inner}\n:::` : `${open}\n:::`
  }
  if (node.type === 'blockCard' || node.type === 'embedCard') {
    return readCardUrl(node)
  }
  // Unknown block node — skip entirely, never throw.
  return null
}

function renderBlocks(nodes: AdfBlockNode[]): string {
  const out: string[] = []
  for (const block of nodes) {
    const text = renderBlock(block)
    if (text === null) continue
    out.push(text)
  }
  return out.join('\n\n')
}

export function adfToPlainText(doc: AdfDocument | string | null | undefined): string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Jira can return either a legacy plain-text description or an ADF document at this decode boundary.
  if (typeof doc === 'string') return doc
  if (!doc || !Array.isArray(doc.content)) return ''
  return renderBlocks(doc.content)
}
