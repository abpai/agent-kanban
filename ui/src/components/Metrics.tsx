import { useStore } from '../store'
import { MetricCard } from './MetricCard'

export function Metrics() {
  const metrics = useStore((s) => s.metrics)
  if (!metrics) return null

  const avgTime =
    metrics.avgCompletionHours != null ? `${metrics.avgCompletionHours.toFixed(1)}h` : '-'

  return (
    <div className="section">
      <h2 className="sectionTitle">Metrics</h2>
      <div className="metricsGrid">
        <MetricCard label="Total Tasks" value={metrics.totalTasks} />
        <MetricCard label="Completed" value={metrics.completedTasks} />
        <MetricCard label="Avg Completion" value={avgTime} />
        {metrics.tasksByPriority.map((p) => (
          <MetricCard key={p.priority} label={p.priority} value={p.count} />
        ))}
      </div>
    </div>
  )
}
