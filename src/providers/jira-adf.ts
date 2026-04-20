// Pure ADF (Atlassian Document Format) translation helpers.
//
// This module is intentionally dependency-free: no imports from the rest of the
// provider stack, no bun:sqlite, no fetch. It models only the subset of ADF
// that agent-kanban round-trips through plain text:
//
//   doc > { paragraph | bulletList | orderedList | codeBlock | heading }
//   paragraph / heading / codeBlock > text(inline)
//   bulletList / orderedList > listItem > paragraph > text
//
// Unknown node types are tolerated on the read path (skipped silently) and
// never emitted on the write path.

export interface AdfDocument {
  version: 1
  type: 'doc'
  content: AdfBlockNode[]
}

export interface AdfTextNode {
  type: 'text'
  text: string
  marks?: unknown[]
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
    content: [{ type: 'text', text }],
  }
}

function listItemFromText(text: string): AdfListItemNode {
  return {
    type: 'listItem',
    content: [paragraphFromText(text)],
  }
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

function inlineText(nodes: AdfInlineNode[] | undefined): string {
  if (!nodes) return ''
  let out = ''
  for (const node of nodes) {
    if (node.type === 'text') {
      out += (node as AdfTextNode).text
    }
    // Unknown inline nodes (mentions, emoji, hardBreak, etc.) are skipped.
  }
  return out
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
      const body = inlineText(code.content)
      const fence = language.length > 0 ? `\`\`\`${language}` : '```'
      return `${fence}\n${body}\n\`\`\``
    }
    case 'heading':
      return inlineText((node as AdfHeadingNode).content)
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
