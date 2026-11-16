// oxlint-disable anti-slop/no-runtime-typeof -- builds fixture marks from either a name or a full mark.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { JsonValue } from '../json'
import {
  JIRA_ADF_CONVERTER_VERSION,
  adfToMarkdown,
  compareAdf,
  markdownToAdf,
  normalizeAdf,
  type AdfDocument,
  type AdfNode,
} from '../providers/jira-adf'
import { adfSchemaErrors } from './helpers/adf-schema'

const FIXTURES = join(import.meta.dir, 'fixtures', 'jira-adf')

interface Fixture {
  adf: JsonValue
  markdown: string
}

function fixture(name: string): Fixture {
  const adf: JsonValue = JSON.parse(readFileSync(join(FIXTURES, `${name}.adf.json`), 'utf8'))
  const markdown = readFileSync(join(FIXTURES, `${name}.md`), 'utf8').replace(/\n$/, '')
  return { adf, markdown }
}

function doc(...content: AdfNode[]): AdfDocument {
  return { version: 1, type: 'doc', content }
}

function text(value: string, ...marks: Array<string | AdfNode>): AdfNode {
  if (marks.length === 0) return { type: 'text', text: value }
  return {
    type: 'text',
    text: value,
    marks: marks.map((mark) => (typeof mark === 'string' ? { type: mark } : mark)),
  }
}

function p(...content: AdfNode[]): AdfNode {
  return content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' }
}

function li(...content: AdfNode[]): AdfNode {
  return { type: 'listItem', content }
}

function bullets(...items: AdfNode[]): AdfNode {
  return { type: 'bulletList', content: items }
}

// Every converted document must also pass Atlassian's published ADF schema,
// which is what Jira enforces on a write.
function written(markdown: string): AdfDocument {
  const result = markdownToAdf(markdown)
  if (!result.ok) throw new Error(`expected markdown to convert: ${JSON.stringify(result.issues)}`)
  expect(adfSchemaErrors(result.document)).toEqual([])
  return result.document
}

// ADF -> markdown -> ADF must come back structurally equal.
function expectRoundTrip(source: JsonValue): string {
  const read = adfToMarkdown(source)
  expect(read.warnings).toEqual([])
  expect(read.lossless).toBe(true)
  expect(compareAdf(source, written(read.markdown))).toEqual([])
  return read.markdown
}

describe('golden corpus', () => {
  for (const name of ['dxs-ticket', 'comment']) {
    test(`${name}: renders the golden markdown and round-trips structurally`, () => {
      const { adf, markdown } = fixture(name)
      expect(expectRoundTrip(adf)).toBe(markdown)
      // Markdown -> ADF -> markdown is stable too.
      expect(adfToMarkdown(written(markdown)).markdown).toBe(markdown)
    })
  }

  test('unsupported: every unsupported node is a visible marker plus a warning', () => {
    const { adf, markdown } = fixture('unsupported')
    const read = adfToMarkdown(adf)
    expect(read.markdown).toBe(markdown)
    expect(read.lossless).toBe(false)
    expect(read.warnings.map((w) => [w.code, w.nodeType, w.path])).toEqual([
      ['unsupported_node', 'panel', 'content[0]'],
      ['unsupported_node', 'mediaSingle', 'content[1]'],
      ['unsupported_node', 'media', 'content[1].content[0]'],
      ['unsupported_node', 'decisionList', 'content[2]'],
      ['unsupported_node', 'decisionItem', 'content[2].content[0]'],
      ['unsupported_node', 'layoutSection', 'content[3]'],
      ['unsupported_node', 'layoutColumn', 'content[3].content[0]'],
      ['unsupported_node', 'extension', 'content[4]'],
      ['unsupported_node', 'blockCard', 'content[5]'],
      ['unsupported_layout', 'table', 'content[6]'],
      ['unsupported_mark', 'alignment', 'content[7]'],
      ['unsupported_mark', 'backgroundColor', 'content[7].content[1]'],
      ['unsupported_node', 'placeholder', 'content[7].content[3]'],
      ['unsupported_node', 'inlineExtension', 'content[7].content[4]'],
      ['unsupported_node', 'mediaInline', 'content[7].content[5]'],
      ['unsupported_node', 'somethingNew', 'content[8]'],
    ])
    // No text is lost behind a marker.
    for (const kept of [
      'Do not run on production.',
      'Keep the v1 endpoint',
      'Left column',
      'listed',
    ]) {
      expect(read.markdown).toContain(kept)
    }
    // A markdown edit of this read still carries the markers, so writing it is refused.
    const write = markdownToAdf(read.markdown)
    expect(write.ok).toBe(false)
    if (!write.ok) expect(write.issues.every((i) => i.code === 'unsupported_marker')).toBe(true)
  })

  test('results carry the converter version', () => {
    expect(adfToMarkdown(fixture('comment').adf).converterVersion).toBe(JIRA_ADF_CONVERTER_VERSION)
    expect(markdownToAdf('x').converterVersion).toBe(JIRA_ADF_CONVERTER_VERSION)
    expect(JIRA_ADF_CONVERTER_VERSION).toBe('agent-kanban/adf-markdown@3')
  })
})

describe('every supported node round-trips', () => {
  const cases: Array<[string, AdfDocument]> = [
    ['paragraphs', doc(p(text('one')), p(text('two')))],
    [
      'headings 1-6',
      doc(
        ...[1, 2, 3, 4, 5, 6].map((level) => ({
          type: 'heading',
          attrs: { level },
          content: [text(`H${level}`)],
        })),
      ),
    ],
    ['hard break', doc(p(text('a'), { type: 'hardBreak' }, text('b')))],
    [
      'strong, em, strike, code',
      doc(
        p(
          text('b', 'strong'),
          text(' '),
          text('i', 'em'),
          text(' '),
          text('s', 'strike'),
          text(' '),
          text('c', 'code'),
        ),
      ),
    ],
    [
      'underline, sub, sup, color',
      doc(
        p(
          text('u', 'underline'),
          text('2', { type: 'subsup', attrs: { type: 'sub' } }),
          text('n', { type: 'subsup', attrs: { type: 'sup' } }),
          text('red', { type: 'textColor', attrs: { color: '#ff5630' } }),
        ),
      ),
    ],
    [
      'link with title and nested marks',
      doc(
        p(
          text('go ', { type: 'link', attrs: { href: 'https://x.test/a_(b)', title: 'T' } }),
          text(
            'now',
            { type: 'link', attrs: { href: 'https://x.test/a_(b)', title: 'T' } },
            'strong',
          ),
        ),
      ),
    ],
    [
      'link wrapping code',
      doc(p(text('cfg.ts', { type: 'link', attrs: { href: 'https://x.test' } }, 'code'))),
    ],
    [
      'inlineCard',
      doc(
        p(text('see '), {
          type: 'inlineCard',
          attrs: { url: 'https://acme.atlassian.net/browse/DXS-1' },
        }),
      ),
    ],
    ['mention', doc(p({ type: 'mention', attrs: { id: '557058:abc-def', text: '@Dana Lee' } }))],
    ['emoji', doc(p({ type: 'emoji', attrs: { shortName: ':white_check_mark:', id: '2705' } }))],
    ['status', doc(p({ type: 'status', attrs: { text: 'BLOCKED', color: 'red' } }))],
    ['date', doc(p({ type: 'date', attrs: { timestamp: '1763251200000' } }))],
    [
      'code block with language',
      doc({
        type: 'codeBlock',
        attrs: { language: 'python' },
        content: [text('def f():\n\n    return "```"')],
      }),
    ],
    ['empty code block', doc({ type: 'codeBlock' })],
    [
      'blockquote with list and code',
      doc({
        type: 'blockquote',
        content: [
          p(text('q')),
          bullets(li(p(text('x')))),
          { type: 'codeBlock', content: [text('y')] },
        ],
      }),
    ],
    ['rule', doc(p(text('above')), { type: 'rule' }, p(text('below')))],
    [
      'ordered list with start',
      doc({
        type: 'orderedList',
        attrs: { order: 7 },
        content: [li(p(text('seven'))), li(p(text('eight')))],
      }),
    ],
    [
      '3-deep mixed nesting',
      doc(
        bullets(
          li(p(text('1')), {
            type: 'orderedList',
            content: [
              li(
                p(text('1.1')),
                bullets(
                  li(p(text('1.1.1')), {
                    type: 'orderedList',
                    attrs: { order: 4 },
                    content: [li(p(text('deep')))],
                  }),
                ),
              ),
            ],
          }),
        ),
      ),
    ],
    ['item whose first child is a list', doc(bullets(li(bullets(li(p(text('nested')))))))],
    [
      'item with two paragraphs and code',
      doc(
        bullets(
          li(p(text('a')), p(text('b')), {
            type: 'codeBlock',
            attrs: { language: 'sh' },
            content: [text('ls')],
          }),
        ),
      ),
    ],
    [
      'adjacent lists stay separate',
      doc(bullets(li(p(text('a')))), bullets(li(p(text('b')))), {
        type: 'orderedList',
        content: [li(p(text('c')))],
      }),
    ],
    [
      'table',
      doc({
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', content: [p(text('H|1'))] },
              { type: 'tableHeader', content: [p(text('H2', 'strong'))] },
            ],
          },
          {
            type: 'tableRow',
            content: [
              { type: 'tableCell', content: [p(text('a'))] },
              { type: 'tableCell', content: [p()] },
            ],
          },
        ],
      }),
    ],
    [
      'expand and nested expand',
      doc({
        type: 'expand',
        attrs: { title: 'Why "this"' },
        content: [
          p(text('body')),
          { type: 'nestedExpand', attrs: { title: 'More' }, content: [p(text('deeper'))] },
        ],
      }),
    ],
    [
      'task list with nesting',
      doc({
        type: 'taskList',
        content: [
          { type: 'taskItem', attrs: { state: 'DONE' }, content: [text('done')] },
          {
            type: 'taskList',
            content: [{ type: 'taskItem', attrs: { state: 'TODO' }, content: [text('sub')] }],
          },
          { type: 'taskItem', attrs: { state: 'TODO' }, content: [text('todo')] },
        ],
      }),
    ],
    [
      'markdown-looking text stays text',
      doc(
        p(
          text(
            '# not a heading, 1. not a list, *not em*, `not code`, [not](link), snake_case, a|b, ::: expand, :::',
          ),
        ),
      ),
    ],
    ['plain URL stays plain text', doc(p(text('https://status.example.com and www.example.com')))],
  ]
  for (const [name, source] of cases) {
    test(name, () => {
      expectRoundTrip(source)
    })
  }
})

describe('the old failures are fixed', () => {
  test('nested bullets keep every level (DXS-423)', () => {
    const source = doc(
      bullets(
        li(p(text('Parent')), bullets(li(p(text('Child')), bullets(li(p(text('Grandchild'))))))),
      ),
    )
    expect(expectRoundTrip(source)).toBe('- Parent\n  - Child\n    - Grandchild')
  })

  test('a list item that starts with a nested list is not an empty bullet', () => {
    expect(expectRoundTrip(doc(bullets(li(bullets(li(p(text('only nested'))))))))).toBe(
      '- - only nested',
    )
  })

  test('second paragraphs and code blocks inside list items are kept', () => {
    const markdown = expectRoundTrip(
      doc(
        bullets(
          li(p(text('first')), p(text('second')), { type: 'codeBlock', content: [text('x()')] }),
        ),
      ),
    )
    expect(markdown).toBe('- first\n\n  second\n  ```\n  x()\n  ```')
  })

  test('headings render with #, italic and inline code survive', () => {
    expect(
      expectRoundTrip(
        doc(
          { type: 'heading', attrs: { level: 2 }, content: [text('Title')] },
          p(text('it', 'em'), text(' '), text('c', 'code')),
        ),
      ),
    ).toBe('## Title\n\n*it* `c`')
  })

  test('unknown nodes are never skipped silently', () => {
    const read = adfToMarkdown(
      doc(p(text('before')), { type: 'panel', content: [p(text('inside'))] }, p(text('after'))),
    )
    expect(read.markdown).toContain('inside')
    expect(read.markdown).toContain('[unsupported Jira content: panel]')
    expect(read.warnings).toHaveLength(1)
  })

  test('markdown writes headings, quotes, italic, code and indented lists as ADF, not literal characters', () => {
    const document = written('# Plan\n\n> quoted *em*\n\n- a\n  - b\n    1. c `code`')
    expect(document.content.map((node) => node.type)).toEqual([
      'heading',
      'blockquote',
      'bulletList',
    ])
    expect(
      compareAdf(
        document,
        doc(
          { type: 'heading', attrs: { level: 1 }, content: [text('Plan')] },
          { type: 'blockquote', content: [p(text('quoted '), text('em', 'em'))] },
          bullets(
            li(
              p(text('a')),
              bullets(
                li(p(text('b')), {
                  type: 'orderedList',
                  content: [li(p(text('c '), text('code', 'code')))],
                }),
              ),
            ),
          ),
        ),
      ),
    ).toEqual([])
  })

  test('a plain-text description from the previous converter still reads cleanly', () => {
    // The old writer kept soft line breaks as "\n" inside text nodes.
    const legacy = doc(p(text('line one\nline two')), bullets(li(p(text('item')))))
    expect(expectRoundTrip(legacy)).toBe('line one\\\nline two\n\n- item')
  })
})

describe('markdownToAdf refuses lossy writes', () => {
  const refused: Array<[string, string, RegExp]> = [
    ['image', 'see ![d](https://x.test/d.png)', /image cannot be written/],
    ['table alignment', '| a |\n| :-: |\n| b |', /column alignment/],
    ['heading inside a list item', '- # nope', /heading cannot be written inside a list item/],
    ['task items mixed with plain items', '- [ ] task\n- plain', /mixes task items/],
    ['code fence info after the language', '```ts title="x"\ncode\n```', /fence info/],
    ['inline code inside bold', '**`x`**', /inline code can only be combined with a link/],
    [
      'an unsupported-content marker',
      'ok\n\n[unsupported Jira content: panel]\n\nbody',
      /unsupported-Jira-content marker/,
    ],
    [
      'expands nested two deep',
      '::: expand\n::: expand\n::: expand\nx\n:::\n:::\n:::',
      /nested one level deep/,
    ],
    // Shapes the ADF schema rejects: Jira would answer 400 after the request.
    ['a task list inside a quote', '> - [ ] a', /task list cannot be written inside a quote/],
    [
      'a table inside a nested expand',
      '::: expand\n::: expand\n| a |\n| - |\n| b |\n:::\n:::',
      /table cannot be written inside a nested expand/,
    ],
    ['an unknown status color', '[DONE](jira-status:banana)', /'banana' is not one/],
    ['a mention without an account id', '[@x](jira-mention:)', /needs an account id/],
    ['malformed percent-encoding', '[x](jira-mention:%zz)', /malformed percent-encoding/],
    // A marker hidden by formatting or link syntax is still a marker.
    ['a marker split by emphasis', '[unsupported *Jira* content: media]', /marker/],
    [
      'a marker written as a reference link',
      '[unsupported Jira content: media][r]\n\n[r]: https://x.test',
      /marker/,
    ],
    [
      'a marker written as a shortcut reference',
      '[unsupported Jira content: media]\n\n[unsupported Jira content: media]: https://x.test',
      /marker/,
    ],
  ]
  for (const [name, markdown, reason] of refused) {
    test(name, () => {
      const result = markdownToAdf(markdown)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.issues.map((issue) => issue.message).join('\n')).toMatch(reason)
    })
  }

  test('refusals report the markdown line', () => {
    const result = markdownToAdf('fine\n\nstill fine\n\n![img](https://x.test/i.png)')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues[0]?.line).toBe(5)
  })

  test('typical agent markdown converts', () => {
    const plan = [
      '## Plan',
      '',
      'Context from [@Dana Lee](jira-mention:557058:abc): the export drops rows.',
      '',
      '1. Reproduce with `EXPORT_PAGE_SIZE=2000`',
      '   - expect **2001** rows',
      '   - observe 2000',
      '2. Fix the cursor math',
      '',
      '```ts',
      'const next = cursor + pageSize',
      '```',
      '',
      '| Check | Result |',
      '| --- | --- |',
      '| unit | pass |',
      '',
      '- [x] reproduced',
      '- [ ] fixed',
      '',
      '::: expand title="Logs"',
      'trace here',
      ':::',
    ].join('\n')
    const document = written(plan)
    expect(document.content.map((node) => node.type)).toEqual([
      'heading',
      'paragraph',
      'orderedList',
      'codeBlock',
      'table',
      'taskList',
      'expand',
    ])
  })
})

describe('reading never throws', () => {
  const inputs: Array<[string, JsonValue | undefined]> = [
    ['null', null],
    ['undefined', undefined],
    ['legacy string', 'plain *legacy* text'],
    ['number', 42],
    ['doc without content', { type: 'doc' }],
    ['non-doc node', { type: 'paragraph', content: [] }],
    [
      'garbage children',
      {
        version: 1,
        type: 'doc',
        content: [
          null,
          3,
          'x',
          { noType: true },
          { type: 'paragraph', content: [{ type: 'text' }, { type: 'text', text: 5 }] },
        ],
      },
    ],
    [
      'empty containers',
      {
        version: 1,
        type: 'doc',
        content: [
          { type: 'bulletList', content: [] },
          { type: 'table', content: [] },
          { type: 'blockquote', content: [] },
        ],
      },
    ],
  ]
  for (const [name, input] of inputs) {
    test(name, () => {
      expect(() => adfToMarkdown(input)).not.toThrow()
    })
  }

  test('legacy strings pass through and a non-doc shows a marker', () => {
    expect(adfToMarkdown('plain *legacy* text').markdown).toBe('plain *legacy* text')
    expect(adfToMarkdown(null)).toMatchObject({ markdown: '', lossless: true, warnings: [] })
    const malformed = adfToMarkdown({ type: 'paragraph' })
    expect(malformed.markdown).toBe('[unsupported Jira content: malformed document]')
    expect(malformed.warnings).toHaveLength(1)
  })
})

describe('the ADF schema is the authority', () => {
  test('the schema check rejects an invalid document', () => {
    expect(
      adfSchemaErrors({ version: 1, type: 'doc', content: [{ type: 'blockquote', content: [] }] }),
    ).not.toEqual([])
  })

  test('a task list inside a list item round-trips', () => {
    expect(
      expectRoundTrip(
        doc(
          bullets(
            li(p(text('parent')), {
              type: 'taskList',
              attrs: { localId: 'l' },
              content: [
                { type: 'taskItem', attrs: { localId: 't', state: 'DONE' }, content: [text('b')] },
              ],
            }),
          ),
        ),
      ),
    ).toBe('- parent\n  - [x] b')
  })

  test('a status with a hex color round-trips', () => {
    expect(
      expectRoundTrip(
        doc(p({ type: 'status', attrs: { text: 'CUSTOM', color: '#ff5630', localId: 's' } })),
      ),
    ).toBe('[CUSTOM](jira-status:%23ff5630)')
  })

  test('a text color around a link is valid ADF', () => {
    written('<span style="color: #ff0000">[a](https://x.test)</span>')
  })
})

describe('HTML is written as literal text', () => {
  // Jira has no HTML, so the faithful write is the characters as typed. They
  // read back escaped, and writing that escaped markdown again changes nothing.
  const cases: Array<[string, string, AdfDocument, string]> = [
    [
      'a placeholder in a sentence',
      'preserving the current_count=<integer> format.',
      doc(p(text('preserving the current_count=<integer> format.'))),
      'preserving the current_count=\\<integer> format.',
    ],
    [
      'a component name inside bold',
      'Wrap it in **<Suspense>** first.',
      doc(p(text('Wrap it in '), text('<Suspense>', 'strong'), text(' first.'))),
      'Wrap it in **\\<Suspense>** first.',
    ],
    [
      'an unknown tag pair and a stray close tag',
      'a <kbd>K</kbd> and </span>',
      doc(p(text('a <kbd>K</kbd> and </span>'))),
      'a \\<kbd>K\\</kbd> and \\</span>',
    ],
    [
      'an HTML block',
      '<div>\nhi\n</div>',
      doc(
        p(text('<div>'), { type: 'hardBreak' }, text('hi'), { type: 'hardBreak' }, text('</div>')),
      ),
      '\\<div>\\\nhi\\\n\\</div>',
    ],
    ['an HTML comment', '<!-- note -->', doc(p(text('<!-- note -->'))), '\\<!-- note -->'],
  ]

  for (const [name, markdown, expected, readBack] of cases) {
    test(name, () => {
      const document = written(markdown)
      expect(compareAdf(expected, document)).toEqual([])
      const read = adfToMarkdown(document)
      expect(read.lossless).toBe(true)
      expect(read.markdown).toBe(readBack)
      // Re-writing what was read back is the same document and the same markdown.
      const again = written(read.markdown)
      expect(compareAdf(document, again)).toEqual([])
      expect(adfToMarkdown(again).markdown).toBe(readBack)
    })
  }

  test('HTML blocks inside a list item and a quote become paragraphs', () => {
    const document = written('- item\n\n  <details>\n  </details>\n\n> <aside>\n> x\n> </aside>')
    expect(adfToMarkdown(document).lossless).toBe(true)
    expect(JSON.stringify(document)).toContain('<details>')
    expect(JSON.stringify(document)).toContain('<aside>')
  })

  test('re-writing the read-back stores the identical raw document', () => {
    // Jira stores text runs as sent and the description hash covers them, so a
    // re-save of what was read must not split or merge runs differently.
    const document = written('Wrap **<Suspense>** and current_count=<integer> </span>.')
    expect(written(adfToMarkdown(document).markdown)).toEqual(document)
    expect(document.content[0]).toEqual(
      p(text('Wrap '), text('<Suspense>', 'strong'), text(' and current_count=<integer> </span>.')),
    )
  })

  test('the recognized tags are still marks', () => {
    expect(
      compareAdf(doc(p(text('u', 'underline'), text(' <b>'))), written('<u>u</u> <b>')),
    ).toEqual([])
  })
})

describe('content in unexpected places is never dropped', () => {
  test('a paragraph inside a task item keeps its text between markers', () => {
    const read = adfToMarkdown(
      doc({
        type: 'taskList',
        attrs: { localId: 'l' },
        content: [
          {
            type: 'taskItem',
            attrs: { localId: 't', state: 'TODO' },
            content: [p(text('hello world'))],
          },
        ],
      }),
    )
    expect(read.markdown).toContain('hello world')
    expect(read.markdown).toContain('[unsupported Jira content: paragraph]')
    expect(read.lossless).toBe(false)
  })

  test('an unknown inline node keeps its text', () => {
    const read = adfToMarkdown(
      doc(p(text('a '), { type: 'futureInline', content: [text('SECRET')] })),
    )
    expect(read.markdown).toBe(
      'a [unsupported Jira content: futureInline]SECRET[end unsupported Jira content: futureInline]',
    )
    expect(read.warnings.map((w) => w.nodeType)).toEqual(['futureInline'])
  })

  test('a non-text node inside a code block keeps its text and is reported', () => {
    const read = adfToMarkdown(
      doc({
        type: 'codeBlock',
        content: [text('call '), { type: 'mention', attrs: { id: '1', text: '@bob' } }],
      }),
    )
    expect(read.markdown).toBe('```\ncall \n```')
    expect(read.warnings).toEqual([
      expect.objectContaining({ code: 'unsupported_node', nodeType: 'mention' }),
    ])
  })

  test('content entries that are not nodes render as markers with their JSON', () => {
    const read = adfToMarkdown({
      version: 1,
      type: 'doc',
      content: [p(text('ok')), 'raw string'],
    })
    expect(read.markdown).toContain('ok')
    expect(read.markdown).toContain('[unsupported Jira content: invalid text="\\"raw string\\""]')
    expect(read.lossless).toBe(false)
  })

  test('a date outside the Date range becomes a marker for that node only', () => {
    const read = adfToMarkdown(
      doc(p({ type: 'date', attrs: { timestamp: '99999999999999999999' } }), p(text('other'))),
    )
    expect(read.markdown).toBe(
      '[unsupported Jira content: date timestamp="99999999999999999999"]\n\nother',
    )
  })

  test('a link with a malformed jira- scheme reads without throwing', () => {
    const read = adfToMarkdown(
      doc(p(text('x', { type: 'link', attrs: { href: 'jira-mention:%zz' } }))),
    )
    expect(read.markdown).toBe('[x](jira-mention:%zz)')
    expect(read.lossless).toBe(false)
  })

  test('an email autolink is a plain link, not a smart link', () => {
    expect(written('<bob@example.com>').content).toEqual([
      p(text('bob@example.com', { type: 'link', attrs: { href: 'mailto:bob@example.com' } })),
    ])
  })
})

describe('compareAdf', () => {
  test('ignores ids, layout, default attrs, spacer paragraphs and mark order', () => {
    const jira = doc(
      p(),
      {
        type: 'table',
        attrs: { localId: 'x', layout: 'wide', isNumberColumnEnabled: false, width: 900 },
        content: [
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableHeader',
                attrs: { colspan: 1, rowspan: 1, colwidth: [120] },
                content: [p(text('h'))],
              },
            ],
          },
        ],
      },
      {
        type: 'orderedList',
        attrs: { order: 1, localId: 'y' },
        content: [li(p(text('a', 'em', 'strong')))],
      },
      p({ type: 'hardBreak' }),
    )
    const ours = doc(
      {
        type: 'table',
        content: [
          { type: 'tableRow', content: [{ type: 'tableHeader', content: [p(text('h'))] }] },
        ],
      },
      { type: 'orderedList', content: [li(p(text('a', 'strong', 'em')))] },
    )
    expect(compareAdf(jira, ours)).toEqual([])
  })

  test('reports the path of a real difference', () => {
    const differences = compareAdf(
      doc(p(text('hello'))),
      doc(p(text('hello'), text('!', 'strong'))),
    )
    expect(differences).toEqual([
      {
        path: 'content[0].content[1]',
        expected: undefined,
        actual: { type: 'text', text: '!', marks: [{ type: 'strong' }] },
      },
    ])
  })

  test('normalizeAdf merges text runs and splits newlines into breaks', () => {
    expect(normalizeAdf(doc(p(text('a'), text('b\nc'))))).toEqual(
      doc(p(text('ab'), { type: 'hardBreak' }, text('c'))),
    )
  })
})

// A deterministic generator over every supported node with hostile text.
describe('generated documents round-trip', () => {
  let seed = 7
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const pick = <T>(values: T[]): T => values[Math.floor(random() * values.length)]!
  const words = [
    'alpha',
    'snake_case',
    '*star*',
    '_under_',
    '1. one',
    '# hash',
    '- dash',
    '`tick`',
    'a|b',
    '[x](y)',
    ' lead',
    'trail ',
    '<tag>',
    '<u>',
    '</span>',
    '<!-- c -->',
    '<div>',
    '&amp;',
    '::: expand',
    'http://e.com',
    '+ plus',
    '> gt',
    '~~s~~',
    '😀',
    'end.',
  ]
  const markSets: Array<Array<string | AdfNode>> = [
    [],
    [],
    ['strong'],
    ['em'],
    ['strike'],
    ['code'],
    ['underline'],
    ['strong', 'em'],
    [{ type: 'link', attrs: { href: 'https://ex.com/p' } }],
    [{ type: 'link', attrs: { href: 'https://ex.com/p' } }, 'strong'],
    [{ type: 'textColor', attrs: { color: '#ff5630' } }],
  ]
  const inline = (count: number, breaks: boolean): AdfNode[] =>
    Array.from({ length: count }, () => {
      const r = random()
      if (r < 0.08 && breaks) return { type: 'hardBreak' }
      if (r < 0.12)
        return {
          type: 'mention',
          attrs: { id: `5570:${Math.floor(random() * 99)}`, text: '@Some One' },
        }
      if (r < 0.14)
        return {
          type: 'inlineCard',
          attrs: { url: `https://acme.atlassian.net/browse/DXS-${Math.floor(random() * 999)}` },
        }
      if (r < 0.16) return { type: 'emoji', attrs: { shortName: ':rocket:', id: '1f680' } }
      if (r < 0.18)
        return {
          type: 'status',
          attrs: { text: pick(['DONE', 'in review']), color: pick(['green', '#ff5630']) },
        }
      if (r < 0.2) return { type: 'date', attrs: { timestamp: '1763251200000' } }
      return text(pick(words) + (random() < 0.5 ? ' ' : ''), ...pick(markSets))
    })
  const paragraph = (breaks = true): AdfNode => p(...inline(1 + Math.floor(random() * 5), breaks))
  const list = (depth: number): AdfNode => {
    const ordered = random() < 0.4
    const items = Array.from({ length: 1 + Math.floor(random() * 3) }, () => {
      const content: AdfNode[] = []
      if (random() > 0.1 || depth === 0) content.push(paragraph())
      if (random() < 0.2) content.push(paragraph())
      if (random() < 0.15) content.push({ type: 'codeBlock', content: [text('x = 1\n  y')] })
      if (depth > 0 && random() < 0.5) content.push(list(depth - 1))
      if (content.length === 0) content.push(list(depth - 1))
      return li(...content)
    })
    if (!ordered) return bullets(...items)
    const start = random() < 0.3 ? { attrs: { order: 2 + Math.floor(random() * 5) } } : {}
    return { type: 'orderedList', ...start, content: items }
  }
  const block = (): AdfNode => {
    const r = random()
    if (r < 0.3) return paragraph()
    if (r < 0.45) return list(3)
    if (r < 0.52)
      return {
        type: 'heading',
        attrs: { level: 1 + Math.floor(random() * 6) },
        content: inline(2, false),
      }
    if (r < 0.6)
      return { type: 'blockquote', content: [paragraph(), ...(random() < 0.5 ? [list(1)] : [])] }
    if (r < 0.68)
      return {
        type: 'codeBlock',
        content: [text(pick(['a\n\n  b', '```\nx', ':::', '- not list']))],
      }
    if (r < 0.72) return { type: 'rule' }
    if (r < 0.8) {
      const width = 1 + Math.floor(random() * 3)
      return {
        type: 'table',
        content: Array.from({ length: 1 + Math.floor(random() * 3) }, (_, row) => ({
          type: 'tableRow',
          content: Array.from({ length: width }, () => ({
            type: row === 0 ? 'tableHeader' : 'tableCell',
            content: [paragraph(false)],
          })),
        })),
      }
    }
    if (r < 0.86)
      return {
        type: 'expand',
        attrs: { title: pick(['', 'T "q"']) },
        content: [
          paragraph(),
          ...(random() < 0.3
            ? [{ type: 'nestedExpand', attrs: { title: 'n' }, content: [paragraph()] }]
            : []),
        ],
      }
    return {
      type: 'taskList',
      content: [
        { type: 'taskItem', attrs: { state: pick(['TODO', 'DONE']) }, content: inline(2, false) },
      ],
    }
  }

  test('300 generated documents are lossless both ways', () => {
    const failures: string[] = []
    for (let i = 0; i < 300; i += 1) {
      const source = doc(...Array.from({ length: 1 + Math.floor(random() * 4) }, block))
      const read = adfToMarkdown(source)
      const write = markdownToAdf(read.markdown)
      const differences = write.ok ? compareAdf(source, write.document) : ['refused']
      const schema = write.ok ? adfSchemaErrors(write.document) : []
      if (!read.lossless || differences.length > 0 || schema.length > 0) {
        failures.push(
          JSON.stringify({
            warnings: read.warnings.map((w) => w.message),
            differences: differences.slice(0, 3),
            schema,
          }),
        )
      }
    }
    expect(failures).toEqual([])
  })

  // Hostile reads: content Jira might send that we cannot render. A read never
  // throws, never drops text, and is never called lossless while it warns.
  const hostile = (): AdfNode => {
    const r = random()
    if (r < 0.2) return { type: 'panel', attrs: { panelType: 'info' }, content: [paragraph()] }
    if (r < 0.35) return p(text('a '), { type: 'futureInline', content: [text('KEEP_INLINE')] })
    if (r < 0.5)
      return p(
        text('x', { type: 'link', attrs: { href: pick(['jira-mention:%zz', 'jira-date:x']) } }),
      )
    if (r < 0.6) return { type: 'codeBlock', content: [text('KEEP_CODE'), { type: 'hardBreak' }] }
    if (r < 0.7) return p({ type: 'date', attrs: { timestamp: '99999999999999999999' } })
    if (r < 0.8) return { type: 'paragraph', content: ['KEEP_RAW'] }
    return block()
  }

  test('300 hostile documents read without throwing or dropping text', () => {
    const failures: string[] = []
    for (let i = 0; i < 300; i += 1) {
      const source = doc(...Array.from({ length: 1 + Math.floor(random() * 4) }, hostile))
      const read = adfToMarkdown(source)
      const json = JSON.stringify(source)
      for (const needle of ['KEEP_INLINE', 'KEEP_CODE', 'KEEP_RAW']) {
        if (json.includes(needle) && !read.markdown.includes(needle))
          failures.push(`${needle} lost`)
      }
      if (read.lossless && read.warnings.length > 0) failures.push('lossless with warnings')
      if (read.lossless) {
        const write = markdownToAdf(read.markdown)
        if (!write.ok || compareAdf(source, write.document).length > 0) {
          failures.push(`lossless but not round-tripping: ${read.markdown}`)
        }
      }
    }
    expect(failures).toEqual([])
  })
})
