import type { CliOutput, BoardView, Task, TaskComment, Column } from './types'

export function success<T>(data: T): CliOutput<T> {
  return { ok: true, data }
}

export function error(code: string, message: string): CliOutput<never> {
  return { ok: false, error: { code, message } }
}

export function formatOutput(result: CliOutput, pretty: boolean): string {
  if (!pretty) return JSON.stringify(result)
  if (!result.ok) return `Error [${result.error.code}]: ${result.error.message}`
  return formatPrettyData(result.data)
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- CLI commands share one polymorphic output envelope; formatting selects its domain view here.
function formatPrettyData(data: unknown): string {
  if (Array.isArray(data)) {
    if (data.length === 0) return 'No items found.'
    if ('column_id' in data[0]) return data.map(formatTaskLine).join('\n')
    if ('task_id' in data[0]) return data.map(formatCommentLine).join('\n')
    if ('position' in data[0]) return data.map(formatColumnLine).join('\n')
    return JSON.stringify(data, null, 2)
  }
  if (!data || typeof data !== 'object') return JSON.stringify(data, null, 2)
  if ('columns' in data) {
    // SAFETY: The board command produces BoardView; columns distinguishes it from other CLI results.
    return formatBoard(data as BoardView)
  }
  if ('column_id' in data) {
    // SAFETY: Task commands return the Task contract, identified by its column_id field.
    return formatTaskDetail(data as Task)
  }
  if ('task_id' in data) {
    // SAFETY: Comment commands return TaskComment, identified by its parent task_id field.
    return formatCommentDetail(data as TaskComment)
  }
  if ('moved' in data) return `Moved ${data.moved} task(s).`
  if ('deleted' in data) return `Deleted ${data.deleted} task(s).`
  if ('position' in data && 'name' in data) {
    // SAFETY: Column commands return Column; position and name distinguish it from task/comment results.
    return formatColumnLine(data as Column)
  }
  if ('message' in data && typeof data.message === 'string') return data.message
  return JSON.stringify(data, null, 2)
}

const PRIORITY_ICONS = new Map([
  ['urgent', '!!!'],
  ['high', '!! '],
  ['medium', '!  '],
  ['low', '.  '],
])

function formatTaskLine(task: Task): string {
  const pri = PRIORITY_ICONS.get(task.priority) ?? '   '
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

function formatCommentLine(comment: TaskComment): string {
  const author = comment.author ? ` @${comment.author}` : ''
  return `  ${comment.id}${author}  ${comment.body}`
}

function formatCommentDetail(comment: TaskComment): string {
  const lines = [
    `Comment: ${comment.id}`,
    `Task: ${comment.task_id}`,
    ...(comment.author ? [`Author: ${comment.author}`] : []),
    `Body: ${comment.body}`,
    `Created: ${comment.created_at}`,
    `Updated: ${comment.updated_at}`,
  ]
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
        const pri = PRIORITY_ICONS.get(task.priority) ?? '   '
        const assignee = task.assignee ? ` @${task.assignee}` : ''
        const project = task.project ? ` [${task.project}]` : ''
        lines.push(`  [${pri}] ${task.id}  ${task.title}${assignee}${project}`)
      }
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}
