// Board metrics need to know which columns mean "done" and "in progress", but
// columns are just (name, position) with no role metadata. Names vary across
// boards (custom local columns, Jira/Linear statuses, KANBAN_DEFAULT_COLUMNS),
// so we classify by a normalized name plus a small synonym set rather than an
// exact 'done' / 'in-progress' string match.

export interface ClassifiableColumn {
  id: string
  name: string
  position: number
}

const DONE_NAMES = new Set([
  'done',
  'complete',
  'completed',
  'closed',
  'resolved',
  'shipped',
  'merged',
])

const IN_PROGRESS_NAMES = new Set([
  'inprogress',
  'doing',
  'wip',
  'started',
  'indevelopment',
  'inreview',
])

// Lowercase and drop separators so 'In Progress', 'in-progress', and
// 'in_progress' all normalize to the same token.
function normalizeColumnName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function selectDoneColumnIds(columns: ClassifiableColumn[]): string[] {
  const matched = columns.filter((c) => DONE_NAMES.has(normalizeColumnName(c.name)))
  if (matched.length > 0) return matched.map((c) => c.id)
  // No recognizable "done" name: fall back to the terminal column (the kanban
  // convention) so completion metrics aren't silently zero under custom names.
  const terminal = columns.reduce<ClassifiableColumn | null>(
    (best, c) => (best === null || c.position > best.position ? c : best),
    null,
  )
  return terminal ? [terminal.id] : []
}

export function selectInProgressColumnIds(columns: ClassifiableColumn[]): string[] {
  return columns.filter((c) => IN_PROGRESS_NAMES.has(normalizeColumnName(c.name))).map((c) => c.id)
}
