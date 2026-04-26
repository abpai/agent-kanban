import { describe, expect, test } from 'bun:test'
import {
  adfToPlainText,
  plainTextToAdf,
  type AdfBulletListNode,
  type AdfCodeBlockNode,
  type AdfDocument,
  type AdfExpandNode,
  type AdfInlineNode,
  type AdfParagraphNode,
} from '../providers/jira-adf'

function firstParagraphContent(doc: AdfDocument): AdfInlineNode[] {
  const paragraph = doc.content[0] as AdfParagraphNode
  expect(paragraph.type).toBe('paragraph')
  return paragraph.content ?? []
}

function firstCodeBlock(doc: AdfDocument): AdfCodeBlockNode {
  const code = doc.content[0] as AdfCodeBlockNode
  expect(code.type).toBe('codeBlock')
  return code
}

function firstBulletList(doc: AdfDocument): AdfBulletListNode {
  const list = doc.content[0] as AdfBulletListNode
  expect(list.type).toBe('bulletList')
  return list
}

describe('plainTextToAdf / adfToPlainText', () => {
  test('empty doc round-trip', () => {
    const doc = plainTextToAdf('')
    expect(doc).toEqual({ version: 1, type: 'doc', content: [] })
    expect(adfToPlainText(doc)).toBe('')
  })

  test('single paragraph round-trip', () => {
    const input = 'hello world'
    const doc = plainTextToAdf(input)
    expect(doc).toEqual({
      version: 1,
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] }],
    })
    expect(adfToPlainText(doc)).toBe(input)
  })

  test('multi-paragraph round-trip (blank-line separated)', () => {
    const input = 'first paragraph\n\nsecond paragraph\n\nthird'
    const doc = plainTextToAdf(input)
    expect(doc.content).toHaveLength(3)
    expect(doc.content[0]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: 'first paragraph' }],
    })
    expect(adfToPlainText(doc)).toBe(input)
  })

  test('bullet list round-trip (- and * both accepted, - emitted)', () => {
    const input = '- one\n* two\n- three'
    const doc = plainTextToAdf(input)
    expect(doc.content).toHaveLength(1)
    const list = doc.content[0] as { type: string; content: unknown[] }
    expect(list.type).toBe('bulletList')
    expect(list.content).toHaveLength(3)
    // Output always uses `- `.
    expect(adfToPlainText(doc)).toBe('- one\n- two\n- three')
  })

  test('ordered list round-trip starting at 1', () => {
    const input = '1. first\n2. second\n3. third'
    const doc = plainTextToAdf(input)
    const list = doc.content[0] as {
      type: string
      attrs?: { order?: number }
      content: unknown[]
    }
    expect(list.type).toBe('orderedList')
    expect(list.attrs).toBeUndefined()
    expect(list.content).toHaveLength(3)
    expect(adfToPlainText(doc)).toBe(input)
  })

  test('ordered list preserves non-default attrs.order', () => {
    const input = '5. fifth\n6. sixth'
    const doc = plainTextToAdf(input)
    const list = doc.content[0] as {
      type: string
      attrs?: { order?: number }
    }
    expect(list.type).toBe('orderedList')
    expect(list.attrs?.order).toBe(5)
    expect(adfToPlainText(doc)).toBe(input)
  })

  test('fenced code block round-trip without language', () => {
    const input = '```\nconst x = 1\nconst y = 2\n```'
    const doc = plainTextToAdf(input)
    const code = doc.content[0] as {
      type: string
      attrs?: { language?: string }
    }
    expect(code.type).toBe('codeBlock')
    expect(code.attrs).toBeUndefined()
    expect(adfToPlainText(doc)).toBe(input)
  })

  test('fenced code block round-trip with language tag', () => {
    const input = '```ts\nconst x: number = 1\n```'
    const doc = plainTextToAdf(input)
    const code = doc.content[0] as {
      type: string
      attrs?: { language?: string }
    }
    expect(code.type).toBe('codeBlock')
    expect(code.attrs?.language).toBe('ts')
    expect(adfToPlainText(doc)).toBe(input)
  })

  test('garage-baton fenced comment round-trips byte-for-byte', () => {
    const input =
      'garage-triage: ✅ Accepted — abpai/garage-band\n\nIncrement SMOKE_TEST_TASK.md from current_count=1 to 2.\n\n```garage-baton\n{"v":1,"accepted":true,"repo":{"owner":"abpai","name":"garage-band"},"questions":[],"summary":"Increment smoke counter."}\n```'
    const doc = plainTextToAdf(input)
    const code = doc.content.find((node) => node.type === 'codeBlock') as
      | { type: string; attrs?: { language?: string } }
      | undefined

    expect(code?.attrs?.language).toBe('garage-baton')
    expect(adfToPlainText(doc)).toBe(input)
  })

  test('mixed content (paragraph + list + code block) round-trip', () => {
    const input = 'intro paragraph\n\n- a\n- b\n\n```js\nconsole.log(1)\n```\n\nouttro'
    const doc = plainTextToAdf(input)
    expect(doc.content).toHaveLength(4)
    expect(doc.content[0]?.type).toBe('paragraph')
    expect(doc.content[1]?.type).toBe('bulletList')
    expect(doc.content[2]?.type).toBe('codeBlock')
    expect(doc.content[3]?.type).toBe('paragraph')
    expect(adfToPlainText(doc)).toBe(input)
  })

  test('heading flattened to plain text (read path)', () => {
    const doc: AdfDocument = {
      version: 1,
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'Big Title' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'body' }],
        },
      ],
    }
    // Heading renders as bare inner text (no `#` prefix).
    expect(adfToPlainText(doc)).toBe('Big Title\n\nbody')
  })

  test('unknown block node type is gracefully skipped, no throw', () => {
    const doc: AdfDocument = {
      version: 1,
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'before' }],
        },
        { type: 'mediaSingle', attrs: { layout: 'center' } },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'after' }],
        },
      ],
    }
    expect(() => adfToPlainText(doc)).not.toThrow()
    expect(adfToPlainText(doc)).toBe('before\n\nafter')
  })

  test('strong + link marks survive on read as markdown', () => {
    const doc: AdfDocument = {
      version: 1,
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
            { type: 'text', text: ' ' },
            {
              type: 'text',
              text: 'click',
              marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
            },
          ],
        },
      ],
    }
    expect(adfToPlainText(doc)).toBe('**bold** [click](https://example.com)')
  })

  test('write path emits **bold** as a strong mark', () => {
    const input = 'hello **world**'
    const doc = plainTextToAdf(input)
    expect(firstParagraphContent(doc)).toEqual([
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world', marks: [{ type: 'strong' }] },
    ])
    expect(adfToPlainText(doc)).toBe(input)
  })

  test('write path emits [label](https://...) as a link mark', () => {
    const input = 'see [docs](https://example.com/x)'
    const doc = plainTextToAdf(input)
    expect(firstParagraphContent(doc)).toEqual([
      { type: 'text', text: 'see ' },
      {
        type: 'text',
        text: 'docs',
        marks: [{ type: 'link', attrs: { href: 'https://example.com/x' } }],
      },
    ])
    expect(adfToPlainText(doc)).toBe(input)
  })

  test('write path emits side-by-side bold and link as adjacent text nodes', () => {
    const input = '**PR opened** — [repo#1](https://github.com/o/r/pull/1)'
    const doc = plainTextToAdf(input)
    expect(firstParagraphContent(doc)).toEqual([
      { type: 'text', text: 'PR opened', marks: [{ type: 'strong' }] },
      { type: 'text', text: ' — ' },
      {
        type: 'text',
        text: 'repo#1',
        marks: [{ type: 'link', attrs: { href: 'https://github.com/o/r/pull/1' } }],
      },
    ])
    expect(adfToPlainText(doc)).toBe(input)
  })

  test('write path bolds bullet item field-name prefix', () => {
    const input = '- **Marker:** drift:HUMAN REVIEW:516652'
    const doc = plainTextToAdf(input)
    const list = firstBulletList(doc)
    const itemParagraph = list.content[0]!.content[0] as AdfParagraphNode
    const itemContent = itemParagraph.content ?? []
    expect(itemContent).toEqual([
      { type: 'text', text: 'Marker:', marks: [{ type: 'strong' }] },
      { type: 'text', text: ' drift:HUMAN REVIEW:516652' },
    ])
    expect(adfToPlainText(doc)).toBe(input)
  })

  test('inline tokenizer does NOT run inside fenced code blocks', () => {
    const input = '```ts\nconst s = "**not bold** [x](https://e.com)"\n```'
    const doc = plainTextToAdf(input)
    const code = firstCodeBlock(doc)
    const codeContent = code.content ?? []
    expect(codeContent).toHaveLength(1)
    expect(codeContent[0]?.text).toBe('const s = "**not bold** [x](https://e.com)"')
    expect(codeContent[0]?.marks).toBeUndefined()
    expect(adfToPlainText(doc)).toBe(input)
  })

  test('read: code block text marks stay literal', () => {
    const doc: AdfDocument = {
      version: 1,
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          content: [
            { type: 'text', text: '**not bold**', marks: [{ type: 'strong' }] },
            {
              type: 'text',
              text: '\nhttps://example.com',
              marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
            },
          ],
        },
      ],
    }
    expect(adfToPlainText(doc)).toBe('```\n**not bold**\nhttps://example.com\n```')
  })

  test('non-http link target is left as literal text (no link mark)', () => {
    const input = 'see [docs](mailto:dev@example.com)'
    const doc = plainTextToAdf(input)
    expect(firstParagraphContent(doc)).toEqual([{ type: 'text', text: input }])
  })

  test('read: paragraph containing inlineCard emits the URL inline', () => {
    const doc: AdfDocument = {
      version: 1,
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Repo: ' },
            { type: 'inlineCard', attrs: { url: 'https://github.com/abpai/garage-band' } },
          ],
        },
      ],
    }
    expect(adfToPlainText(doc)).toBe('Repo: https://github.com/abpai/garage-band')
  })

  test('read: split strong field label keeps colon inside markdown', () => {
    const doc: AdfDocument = {
      version: 1,
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Repo', marks: [{ type: 'strong' }] },
            { type: 'text', text: ': ' },
            { type: 'inlineCard', attrs: { url: 'https://github.com/abpai/garage-band' } },
          ],
        },
      ],
    }
    expect(adfToPlainText(doc)).toBe('**Repo:** https://github.com/abpai/garage-band')
  })

  test('read: blockCard renders as a standalone block with the URL', () => {
    const doc: AdfDocument = {
      version: 1,
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'before' }] },
        { type: 'blockCard', attrs: { url: 'https://github.com/abpai/garage-band' } },
        { type: 'paragraph', content: [{ type: 'text', text: 'after' }] },
      ],
    }
    expect(adfToPlainText(doc)).toBe('before\n\nhttps://github.com/abpai/garage-band\n\nafter')
  })

  test('read: embedCard also emits its URL', () => {
    const doc: AdfDocument = {
      version: 1,
      type: 'doc',
      content: [{ type: 'embedCard', attrs: { url: 'https://example.com/embed' } }],
    }
    expect(adfToPlainText(doc)).toBe('https://example.com/embed')
  })

  test('read: DXS-12-shaped description preserves smart-link Repo URL', () => {
    // Captured shape from a real Jira description where a user pasted a URL
    // and Jira auto-converted it to an inlineCard. Before the fix,
    // adfToPlainText returned "Repo: " with the URL silently dropped.
    const doc: AdfDocument = {
      version: 1,
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Repo', marks: [{ type: 'strong' }] },
            { type: 'text', text: ': ' },
            { type: 'inlineCard', attrs: { url: 'https://github.com/abpai/garage-band' } },
          ],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Please make one minimal change.' }],
        },
        {
          type: 'heading',
          attrs: { level: 3 },
          content: [{ type: 'text', text: 'Acceptance criteria:' }],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'Change only SMOKE_TEST_TASK.md.' }],
                },
              ],
            },
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'Increment current_count by exactly one.' }],
                },
              ],
            },
          ],
        },
      ],
    }
    const out = adfToPlainText(doc)
    expect(out).toContain('Repo:')
    expect(out).toContain('https://github.com/abpai/garage-band')
    // Repo line carries the URL — agents grepping for the URL recover it.
    const repoLine = out.split('\n').find((l) => l.includes('Repo:'))
    expect(repoLine).toBe('**Repo:** https://github.com/abpai/garage-band')
  })

  test('read: hardBreak between text runs emits newline', () => {
    const doc: AdfDocument = {
      version: 1,
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'first line' },
            { type: 'hardBreak' },
            { type: 'text', text: 'second line' },
          ],
        },
      ],
    }
    expect(adfToPlainText(doc)).toBe('first line\nsecond line')
  })

  test('bullet item containing digits-dot substring is still a bullet', () => {
    const input = '- item containing 1. something'
    const doc = plainTextToAdf(input)
    expect(doc.content[0]?.type).toBe('bulletList')
    expect(adfToPlainText(doc)).toBe(input)
  })
})

describe('jira-adf expand block', () => {
  test('write: expand wrapping a fenced code block produces nested ADF', () => {
    const input =
      '::: expand title="garage-baton (machine-readable)"\n' +
      '```garage-baton\n' +
      '{"v":1}\n' +
      '```\n' +
      ':::'
    const doc = plainTextToAdf(input)
    expect(doc.content).toHaveLength(1)
    const expand = doc.content[0] as AdfExpandNode
    expect(expand.type).toBe('expand')
    expect(expand.attrs?.title).toBe('garage-baton (machine-readable)')
    expect(expand.content).toHaveLength(1)
    const code = expand.content[0] as AdfCodeBlockNode
    expect(code.type).toBe('codeBlock')
    expect(code.attrs?.language).toBe('garage-baton')
    expect(code.content?.[0]).toEqual({ type: 'text', text: '{"v":1}' })
  })

  test('read: ADF expand wrapping a codeBlock renders back to the wire format', () => {
    const doc: AdfDocument = {
      version: 1,
      type: 'doc',
      content: [
        {
          type: 'expand',
          attrs: { title: 'garage-baton (machine-readable)' },
          content: [
            {
              type: 'codeBlock',
              attrs: { language: 'garage-baton' },
              content: [{ type: 'text', text: '{"v":1}' }],
            },
          ],
        },
      ],
    }
    expect(adfToPlainText(doc)).toBe(
      '::: expand title="garage-baton (machine-readable)"\n' +
        '```garage-baton\n' +
        '{"v":1}\n' +
        '```\n' +
        ':::',
    )
  })

  test('write: bare ::: expand emits empty title', () => {
    const input = '::: expand\nbody paragraph\n:::'
    const doc = plainTextToAdf(input)
    const expand = doc.content[0] as AdfExpandNode
    expect(expand.type).toBe('expand')
    expect(expand.attrs?.title).toBe('')
    expect(expand.content[0]?.type).toBe('paragraph')
  })

  test('read: bare ::: expand renders without title attribute', () => {
    const doc: AdfDocument = {
      version: 1,
      type: 'doc',
      content: [
        {
          type: 'expand',
          attrs: { title: '' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }],
        },
      ],
    }
    expect(adfToPlainText(doc)).toBe('::: expand\nbody\n:::')
  })

  test('read: expand without attrs renders as a bare expand block', () => {
    const doc: AdfDocument = {
      version: 1,
      type: 'doc',
      content: [
        {
          type: 'expand',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }],
        },
      ],
    }
    expect(adfToPlainText(doc)).toBe('::: expand\nbody\n:::')
  })

  test('write: unterminated ::: expand falls through to paragraph', () => {
    const input = '::: expand title="oops"\nstray text without close'
    const doc = plainTextToAdf(input)
    // Both lines collapse into a single paragraph; no expand node.
    expect(doc.content.every((b) => b.type !== 'expand')).toBe(true)
    expect(doc.content[0]?.type).toBe('paragraph')
  })

  test('round-trip: typed-comment-shaped string is byte-stable', () => {
    const input =
      'garage-triage: **Accepted** — abpai/garage-band\n' +
      '\n' +
      'Increment current_count by 1.\n' +
      '\n' +
      '**Next:** Handing off to planner.\n' +
      '\n' +
      '::: expand title="garage-baton (machine-readable)"\n' +
      '```garage-baton\n' +
      '{"v":1,"accepted":true}\n' +
      '```\n' +
      ':::'
    expect(adfToPlainText(plainTextToAdf(input))).toBe(input)
  })

  test('round-trip: nested paragraph and bullet list inside expand survive', () => {
    const input =
      '::: expand title="details"\n' +
      'first paragraph\n' +
      '\n' +
      '- bullet one\n' +
      '- bullet two\n' +
      ':::'
    expect(adfToPlainText(plainTextToAdf(input))).toBe(input)
  })

  test('write: expand title preserves escaped quote', () => {
    const input = '::: expand title="quoted \\"title\\""\nx\n:::'
    const doc = plainTextToAdf(input)
    const expand = doc.content[0] as AdfExpandNode
    expect(expand.attrs?.title).toBe('quoted "title"')
    // Round-trip emits the same escaping.
    expect(adfToPlainText(doc)).toBe(input)
  })

  test('write: text followed by ::: expand on the next line is two blocks', () => {
    const input = 'leading paragraph\n' + '::: expand title="x"\n' + 'inside\n' + ':::'
    const doc = plainTextToAdf(input)
    expect(doc.content).toHaveLength(2)
    expect(doc.content[0]?.type).toBe('paragraph')
    expect(doc.content[1]?.type).toBe('expand')
  })
})
