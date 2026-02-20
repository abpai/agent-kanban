import { useStore } from '../store'
import type { ActivityAction } from '../types'

const ACTION_ICONS: Record<ActivityAction, string> = {
  created: '+',
  moved: '>',
  updated: '~',
  deleted: 'x',
  assigned: '@',
  prioritized: '!',
}

function formatTime(timestamp: string): string {
  const d = new Date(timestamp + 'Z')
  const h = d.getHours().toString().padStart(2, '0')
  const m = d.getMinutes().toString().padStart(2, '0')
  return `${h}:${m}`
}

function describeAction(
  action: ActivityAction,
  field: string | null,
  oldVal: string | null,
  newVal: string | null,
): string {
  switch (action) {
    case 'created':
      return `created "${newVal}"`
    case 'deleted':
      return `deleted "${oldVal}"`
    case 'moved':
      return `moved ${oldVal} → ${newVal}`
    case 'assigned':
      return oldVal ? `reassigned ${oldVal} → ${newVal}` : `assigned to ${newVal}`
    case 'prioritized':
      return `priority ${oldVal} → ${newVal}`
    case 'updated':
      return `updated ${field ?? 'field'}`
    default:
      return action
  }
}

export function ActivityLog() {
  const activity = useStore((s) => s.activity)

  return (
    <div className="section">
      <h2 className="sectionTitle">Activity Log</h2>
      {activity.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No activity yet</div>
      ) : (
        <ul className="activityList">
          {activity.slice(0, 30).map((entry) => (
            <li key={entry.id} className="activityItem">
              <span className="activityIcon">{ACTION_ICONS[entry.action]}</span>
              <span className="activityTime">{formatTime(entry.timestamp)}</span>
              <span className="activityBody">
                <span style={{ fontFamily: 'monospace', fontSize: 11, marginRight: 6 }}>
                  {entry.task_id}
                </span>
                {describeAction(
                  entry.action,
                  entry.field_changed,
                  entry.old_value,
                  entry.new_value,
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
