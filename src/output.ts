import type { CliOutput, BoardView, Task, TaskWithColumn, Column } from './types'

export function success<T>(data: T): CliOutput<T> {
  return { ok: true, data }
}

export function error(code: string, message: string): CliOutput<never> {
  return { ok: false, error: { code, message } }
}

export function formatOutput(result: CliOutput, pretty: boolean): string {
  if (!pretty) return JSON.stringify(result)
  if (!result.ok) return formatError(result.error)
  return formatPrettyData(result.data)
}

function formatError(err: { code: string; message: string }): string {
  return `Error [${err.code}]: ${err.message}`
}

function formatPrettyData(data: unknown): string {
  if (data && typeof data === 'object' && 'columns' in data) {
    return formatBoard(data as BoardView)
  }
  if (Array.isArray(data)) {
    if (data.length === 0) return 'No items found.'
    if ('column_id' in data[0]) return data.map(formatTaskLine).join('\n')
    if ('position' in data[0]) return data.map(formatColumnLine).join('\n')
    return JSON.stringify(data, null, 2)
  }
  if (data && typeof data === 'object' && 'column_id' in data) {
    return formatTaskDetail(data as TaskWithColumn)
  }
  if (data && typeof data === 'object' && 'moved' in data) {
    return `Moved ${(data as { moved: number }).moved} task(s).`
  }
  if (data && typeof data === 'object' && 'deleted' in data) {
    return `Deleted ${(data as { deleted: number }).deleted} task(s).`
  }
  if (data && typeof data === 'object' && 'position' in data && 'name' in data) {
    return formatColumnLine(data as Column)
  }
  if (data && typeof data === 'object' && 'message' in data) {
    return (data as { message: string }).message
  }
  return JSON.stringify(data, null, 2)
}

const PRIORITY_ICONS: Record<string, string> = {
  urgent: '!!!',
  high: '!! ',
  medium: '!  ',
  low: '.  ',
}

function formatTaskLine(task: Task): string {
  const pri = PRIORITY_ICONS[task.priority] ?? '   '
  const assignee = task.assignee ? ` @${task.assignee}` : ''
  const project = task.project ? ` [${task.project}]` : ''
  const ref = task.externalRef && task.externalRef !== task.id ? ` (${task.externalRef})` : ''
  return `  [${pri}] ${task.id}${ref}  ${task.title}${assignee}${project}`
}

function formatTaskDetail(task: Task): string {
  const lines = [
    `Task: ${task.id}`,
    ...(task.externalRef && task.externalRef !== task.id ? [`Ref: ${task.externalRef}`] : []),
    `Title: ${task.title}`,
    `Priority: ${task.priority}`,
  ]
  if ('column_name' in task && task.column_name) lines.push(`Column: ${task.column_name}`)
  if (task.assignee) lines.push(`Assignee: ${task.assignee}`)
  if (task.project) lines.push(`Project: ${task.project}`)
  if (task.description) lines.push(`Description: ${task.description}`)
  if (task.metadata !== '{}') lines.push(`Metadata: ${task.metadata}`)
  if (task.url) lines.push(`URL: ${task.url}`)
  lines.push(`Created: ${task.created_at}`)
  lines.push(`Updated: ${task.updated_at}`)
  return lines.join('\n')
}

function formatColumnLine(col: Column): string {
  const color = col.color ? ` (${col.color})` : ''
  return `  ${col.position}. ${col.name}${color}  [${col.id}]`
}

function formatBoard(board: BoardView): string {
  const lines: string[] = []
  for (const col of board.columns) {
    const count = col.tasks.length
    lines.push(`── ${col.name} (${count}) ──`)
    if (count === 0) {
      lines.push('  (empty)')
    } else {
      for (const task of col.tasks) {
        const pri = PRIORITY_ICONS[task.priority] ?? '   '
        const assignee = task.assignee ? ` @${task.assignee}` : ''
        const project = task.project ? ` [${task.project}]` : ''
        lines.push(`  [${pri}] ${task.id}  ${task.title}${assignee}${project}`)
      }
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}
