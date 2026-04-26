// Pure ADF (Atlassian Document Format) translation helpers.
//
// This module is intentionally dependency-free: no imports from the rest of the
// provider stack, no bun:sqlite, no fetch. It models only the subset of ADF
// that agent-kanban writes, plus a few Jira nodes it must preserve on read:
//
//   doc > { paragraph | bulletList | orderedList | codeBlock | heading | card }
//   paragraph / heading / codeBlock > text(inline) | inlineCard | hardBreak
//   bulletList / orderedList > listItem > paragraph > text
//
// Other unknown node types are tolerated on the read path (skipped silently)
// and never emitted on the write path.

export interface AdfDocument {
  version: 1
  type: 'doc'
  content: AdfBlockNode[]
}

export interface AdfMark {
  type: string
  attrs?: Record<string, unknown>
}

export interface AdfTextNode {
  type: 'text'
  text: string
  marks?: AdfMark[]
}

export interface AdfUnknownInlineNode {
  type: string
  [key: string]: unknown
}

export type AdfInlineNode = AdfTextNode | AdfUnknownInlineNode

export interface AdfParagraphNode {
  type: 'paragraph'
  content?: AdfInlineNode[]
}

export interface AdfListItemNode {
  type: 'listItem'
  content: AdfBlockNode[]
}

export interface AdfBulletListNode {
  type: 'bulletList'
  content: AdfListItemNode[]
}

export interface AdfOrderedListNode {
  type: 'orderedList'
  content: AdfListItemNode[]
  attrs?: { order?: number }
}

export interface AdfCodeBlockNode {
  type: 'codeBlock'
  attrs?: { language?: string }
  content?: AdfInlineNode[]
}

export interface AdfHeadingNode {
  type: 'heading'
  attrs: { level: number }
  content?: AdfInlineNode[]
}

export interface AdfUnknownBlockNode {
  type: string
  [key: string]: unknown
}

export type AdfBlockNode =
  | AdfParagraphNode
  | AdfBulletListNode
  | AdfOrderedListNode
  | AdfCodeBlockNode
  | AdfHeadingNode
  | AdfUnknownBlockNode

// Public AdfNode union covers every node shape this module recognizes.
export type AdfNode = AdfDocument | AdfBlockNode | AdfListItemNode | AdfInlineNode

const BULLET_MARKER = /^[-*] (.*)$/
const ORDERED_MARKER = /^(\d+)\. (.*)$/
// Opening/closing fence: `` ``` `` optionally followed by a language tag with
// no whitespace before it. Fence must occupy the whole line.
const FENCE_OPEN = /^```([^\s`]*)$/
const FENCE_CLOSE = /^```$/

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
  const blocks: AdfBlockNode[] = []

  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''

    // Blank line separates blocks — consume and move on.
    if (line === '') {
      i += 1
      continue
    }

    // Fenced code block.
    const fenceOpen = line.match(FENCE_OPEN)
    if (fenceOpen) {
      const language = fenceOpen[1] ?? ''
      const codeLines: string[] = []
      let j = i + 1
      let closed = false
      while (j < lines.length) {
        const inner = lines[j] ?? ''
        if (FENCE_CLOSE.test(inner)) {
          closed = true
          break
        }
        codeLines.push(inner)
        j += 1
      }
      if (closed) {
        const node: AdfCodeBlockNode = { type: 'codeBlock' }
        if (language.length > 0) {
          node.attrs = { language }
        }
        const code = codeLines.join('\n')
        if (code.length > 0) {
          node.content = [{ type: 'text', text: code }]
        }
        blocks.push(node)
        i = j + 1
        continue
      }
      // Unterminated fence — fall through and treat as a paragraph.
    }

    // Bullet list run.
    if (BULLET_MARKER.test(line)) {
      const items: AdfListItemNode[] = []
      while (i < lines.length) {
        const current = lines[i] ?? ''
        const match = current.match(BULLET_MARKER)
        if (!match) break
        items.push(listItemFromText(match[1] ?? ''))
        i += 1
      }
      blocks.push({ type: 'bulletList', content: items })
      continue
    }

    // Ordered list run.
    const orderedFirst = line.match(ORDERED_MARKER)
    if (orderedFirst) {
      const items: AdfListItemNode[] = []
      const firstNumber = Number.parseInt(orderedFirst[1] ?? '1', 10)
      items.push(listItemFromText(orderedFirst[2] ?? ''))
      i += 1
      while (i < lines.length) {
        const current = lines[i] ?? ''
        const match = current.match(ORDERED_MARKER)
        if (!match) break
        items.push(listItemFromText(match[2] ?? ''))
        i += 1
      }
      const node: AdfOrderedListNode = { type: 'orderedList', content: items }
      if (firstNumber !== 1) {
        node.attrs = { order: firstNumber }
      }
      blocks.push(node)
      continue
    }

    // Paragraph: consume until blank line or a block-starting line.
    const paragraphLines: string[] = [line]
    i += 1
    while (i < lines.length) {
      const current = lines[i] ?? ''
      if (
        current === '' ||
        BULLET_MARKER.test(current) ||
        ORDERED_MARKER.test(current) ||
        FENCE_OPEN.test(current)
      ) {
        break
      }
      paragraphLines.push(current)
      i += 1
    }
    blocks.push(paragraphFromText(paragraphLines.join('\n')))
  }

  return { version: 1, type: 'doc', content: blocks }
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
    if (node.type === 'text') {
      const textNode = node as AdfTextNode
      if (!renderMarks) {
        out += textNode.text
        continue
      }
      const nextNode = nodes[i + 1]
      const labelColon = readPlainTextLeadingColon(nextNode)
      if (labelColon && hasMark(textNode, 'strong')) {
        out += renderTextNode({ ...textNode, text: `${textNode.text}:` })
        out += labelColon.remainder
        i += 1
        continue
      }
      out += renderTextNode(textNode)
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
  if (!node || node.type !== 'text') return null
  const textNode = node as AdfTextNode
  if (textNode.marks && textNode.marks.length > 0) return null
  if (!textNode.text.startsWith(':')) return null
  return { remainder: textNode.text.slice(1) }
}

function renderTextNode(node: AdfTextNode): string {
  if (!node.marks || node.marks.length === 0) return node.text
  const link = node.marks.find((m) => m.type === 'link')
  let out = node.text
  if (link) {
    const href = link.attrs?.['href']
    if (typeof href === 'string' && href.length > 0) out = `[${out}](${href})`
  }
  if (hasMark(node, 'strong')) {
    out = `**${out}**`
  }
  return out
}

function readCardUrl(node: AdfInlineNode | AdfBlockNode): string | null {
  const attrs = (node as { attrs?: Record<string, unknown> }).attrs
  if (!attrs) return null
  const url = attrs['url']
  return typeof url === 'string' && url.length > 0 ? url : null
}

function listItemInnerText(item: AdfListItemNode): string {
  // Each list item wraps a paragraph (or nested blocks). We flatten to the
  // first paragraph's inline text, which is all the write path produces.
  for (const child of item.content) {
    if (child.type === 'paragraph') {
      return inlineText((child as AdfParagraphNode).content)
    }
  }
  return ''
}

function renderBlock(node: AdfBlockNode): string | null {
  switch (node.type) {
    case 'paragraph':
      return inlineText((node as AdfParagraphNode).content)
    case 'bulletList': {
      const list = node as AdfBulletListNode
      const lines = list.content.map((item) => `- ${listItemInnerText(item)}`)
      return lines.join('\n')
    }
    case 'orderedList': {
      const list = node as AdfOrderedListNode
      const start = list.attrs?.order ?? 1
      const lines = list.content.map((item, idx) => `${start + idx}. ${listItemInnerText(item)}`)
      return lines.join('\n')
    }
    case 'codeBlock': {
      const code = node as AdfCodeBlockNode
      const language = code.attrs?.language ?? ''
      const body = inlineText(code.content, { renderMarks: false })
      const fence = language.length > 0 ? `\`\`\`${language}` : '```'
      return `${fence}\n${body}\n\`\`\``
    }
    case 'heading':
      return inlineText((node as AdfHeadingNode).content)
    case 'blockCard':
    case 'embedCard': {
      const url = readCardUrl(node)
      return url ?? null
    }
    default:
      // Unknown block node — skip entirely, never throw.
      return null
  }
}

export function adfToPlainText(doc: AdfDocument): string {
  const rendered: string[] = []
  for (const block of doc.content) {
    const text = renderBlock(block)
    if (text === null) continue
    rendered.push(text)
  }
  return rendered.join('\n\n')
}
