import type { Priority } from '../types'

interface StatusBadgeProps {
  priority: Priority
}

export function StatusBadge({ priority }: StatusBadgeProps) {
  if (priority === 'medium') return null
  return <span className="statusBadge">{priority}</span>
}
