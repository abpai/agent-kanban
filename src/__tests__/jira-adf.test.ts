import { describe, expect, test } from 'bun:test'
import { adfToPlainText, plainTextToAdf, type AdfDocument } from '../providers/jira-adf.ts'

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

  test('inline text marks are stripped on read', () => {
    const doc: AdfDocument = {
      version: 1,
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
            { type: 'text', text: ' normal' },
          ],
        },
      ],
    }
    expect(adfToPlainText(doc)).toBe('bold normal')
  })

  test('bullet item containing digits-dot substring is still a bullet', () => {
    const input = '- item containing 1. something'
    const doc = plainTextToAdf(input)
    expect(doc.content[0]?.type).toBe('bulletList')
    expect(adfToPlainText(doc)).toBe(input)
  })
})
