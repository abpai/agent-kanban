// Faithful conversion between Jira's Atlassian Document Format (ADF) and
// GitHub-flavored markdown, for descriptions and comments.
//
// Contract:
// - Reading (`adfToMarkdown`) is total. Every node renders to markdown or to a
//   visible `[unsupported Jira content: ...]` marker plus a warning. It never
//   drops content and never throws. `lossless` is true only when the markdown
//   parses back to the same normalized ADF.
// - Writing (`markdownToAdf`) refuses what it cannot represent. Markdown that
//   has no ADF equivalent, or that still carries an unsupported-content marker,
//   returns issues instead of a degraded document.
// - `compareAdf` is the structural check: it diffs two documents after
//   `normalizeAdf` removes presentation-only attributes.
//
// The markdown parser and serializer are the mdast utilities; the ADF mapping
// is ours. docs/providers/jira.md lists the syntax for each node.

import type { JsonValue } from '../../json'
import {
  JIRA_ADF_CONVERTER_VERSION,
  MARKER_PREFIX,
  asNode,
  type AdfMarkdown,
  type MarkdownToAdfResult,
} from './model'
import { compareAdf } from './normalize'
import { parseMarkdown } from './parse'
import { documentContent, renderAdfBlocks, type RenderedMarkdown } from './render'

export {
  JIRA_ADF_CONVERTER_VERSION,
  type AdfConversionWarning,
  type AdfDifference,
  type AdfDocument,
  type AdfMarkdown,
  type AdfNode,
  type MarkdownToAdfResult,
  type MarkdownWriteIssue,
} from './model'
export { compareAdf, describeAdfDifferences, normalizeAdf } from './normalize'

/**
 * Renders a Jira ADF document (or a legacy plain-text description) as markdown.
 * Never throws and never drops content.
 */
export function adfToMarkdown(doc: JsonValue | undefined): AdfMarkdown {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Jira can return a legacy plain-text description or an ADF document at this decode boundary.
  if (typeof doc === 'string') {
    return {
      markdown: doc,
      warnings: [],
      lossless: true,
      converterVersion: JIRA_ADF_CONVERTER_VERSION,
    }
  }
  const content = documentContent(doc)
  if (content === null) {
    const empty = doc === null || doc === undefined
    return {
      markdown: empty ? '' : `[${MARKER_PREFIX}malformed document]`,
      warnings: empty
        ? []
        : [
            {
              code: 'unsupported_node',
              nodeType: asNode(doc)?.type ?? 'unknown',
              path: '',
              message: 'Description is not an ADF doc node; rendered as a marker.',
            },
          ],
      lossless: empty,
      converterVersion: JIRA_ADF_CONVERTER_VERSION,
    }
  }

  let rendered: RenderedMarkdown
  try {
    rendered = renderAdfBlocks(content)
  } catch (err) {
    // The serializer is third-party code; a bug there must not fail a read.
    const message = err instanceof Error ? err.message : String(err)
    return {
      markdown: `[${MARKER_PREFIX}document that failed to render]\n\n${JSON.stringify(doc)}`,
      warnings: [
        {
          code: 'unsupported_node',
          nodeType: 'doc',
          path: '',
          message: `Rendering failed: ${message}`,
        },
      ],
      lossless: false,
      converterVersion: JIRA_ADF_CONVERTER_VERSION,
    }
  }

  const { markdown, warnings } = rendered
  if (warnings.length === 0) {
    const reparsed = parseMarkdown(markdown)
    const differences =
      reparsed.issues.length > 0
        ? []
        : compareAdf({ version: 1, type: 'doc', content }, reparsed.document)
    if (reparsed.issues.length > 0 || differences.length > 0) {
      const first = differences[0]
      warnings.push({
        code: 'round_trip_mismatch',
        nodeType: 'doc',
        path: first?.path ?? '',
        message:
          reparsed.issues[0]?.message ??
          `Markdown does not parse back to the same document at ${first?.path ?? '(root)'}.`,
      })
    }
  }

  return {
    markdown,
    warnings: warnings,
    lossless: warnings.length === 0,
    converterVersion: JIRA_ADF_CONVERTER_VERSION,
  }
}

/**
 * Converts markdown to a Jira ADF document, or refuses with the reasons when
 * the markdown holds something ADF cannot represent.
 */
export function markdownToAdf(markdown: string): MarkdownToAdfResult {
  const { document, issues } = parseMarkdown(markdown)
  if (issues.length > 0) return { ok: false, issues, converterVersion: JIRA_ADF_CONVERTER_VERSION }
  const rendered = adfToMarkdown(document)
  const reparsed = parseMarkdown(rendered.markdown)
  const differences = compareAdf(document, reparsed.document)
  if (differences.length > 0 || reparsed.issues.length > 0) {
    return {
      ok: false,
      issues: [
        {
          code: 'round_trip_mismatch',
          message: 'The converted document does not survive a read back; refusing a lossy write.',
          differences,
        },
        ...reparsed.issues,
      ],
      converterVersion: JIRA_ADF_CONVERTER_VERSION,
    }
  }
  return { ok: true, document, converterVersion: JIRA_ADF_CONVERTER_VERSION }
}
