import { Database } from 'bun:sqlite'
import { generateId } from './id'
import type { ActivityEntry, ActivityAction } from './types'

export function logActivity(
  db: Database,
  taskId: string,
  action: ActivityAction,
  opts: { field?: string; old_value?: string | null; new_value?: string | null } = {},
): void {
  db.query(
    `INSERT INTO activity_log (id, task_id, action, field_changed, old_value, new_value)
     VALUES ($id, $task_id, $action, $field, $old, $new)`,
  ).run({
    $id: generateId('a'),
    $task_id: taskId,
    $action: action,
    $field: opts.field ?? null,
    $old: opts.old_value ?? null,
    $new: opts.new_value ?? null,
  })
}

export function listActivity(
  db: Database,
  opts: { limit?: number; taskId?: string } = {},
): ActivityEntry[] {
  const conditions: string[] = []
  const params: Record<string, string | number> = {}

  if (opts.taskId) {
    conditions.push('task_id = $task_id')
    params['$task_id'] = opts.taskId
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = opts.limit ? `LIMIT ${opts.limit}` : 'LIMIT 50'

  return db
    .query(`SELECT * FROM activity_log ${where} ORDER BY timestamp DESC, rowid DESC ${limit}`)
    .all(params as Record<string, string>) as ActivityEntry[]
}

export function enterColumn(db: Database, taskId: string, columnId: string): void {
  db.query(
    `INSERT INTO column_time_tracking (id, task_id, column_id)
     VALUES ($id, $task_id, $col)`,
  ).run({
    $id: generateId('ct'),
    $task_id: taskId,
    $col: columnId,
  })
}

export function exitColumn(db: Database, taskId: string, columnId: string): void {
  db.query(
    `UPDATE column_time_tracking SET exited_at = datetime('now')
     WHERE task_id = $task_id AND column_id = $col AND exited_at IS NULL`,
  ).run({
    $task_id: taskId,
    $col: columnId,
  })
}
