import { describe, expect, test } from 'bun:test'

import { taskDescriptionText } from '../provider-runtime'

describe('public task description conversion', () => {
  test('predicts Jira heading, list and paragraph spacing', () => {
    const requested =
      '# Reading path\nRead the attachment.\n1. Open report.txt\n2. Review it\n\nGarage routing:\n- repo: acme/widget@main'
    expect(taskDescriptionText('jira', requested)).toBe(
      '# Reading path\nRead the attachment.\n\n1. Open report.txt\n2. Review it\n\nGarage routing:\n\n- repo: acme/widget@main',
    )
  })

  test('preserves significant code whitespace and does not accept missing content', () => {
    const requested = '```python\n  first()\n\n    second()\n```\n\nRead report.txt'
    const expected = taskDescriptionText('jira', requested)
    expect(expected).toBe(requested)
    expect(expected).not.toBe(
      taskDescriptionText('jira', requested.replace('    second()', 'second()')),
    )
    expect(expected).not.toBe(
      taskDescriptionText('jira', requested.replace('\n\n    second()', '\n    second()')),
    )
    expect(expected).not.toBe(taskDescriptionText('jira', requested.replace('Read report.txt', '')))
  })

  test('local and Linear descriptions keep their exact representation', () => {
    const text = '# Heading\n\n  content  \n- item\n'
    expect(taskDescriptionText('local', text)).toBe(text)
    expect(taskDescriptionText('linear', text)).toBe(text)
  })
})
