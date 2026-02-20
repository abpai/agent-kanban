interface MetricCardProps {
  label: string
  value: string | number
}

export function MetricCard({ label, value }: MetricCardProps) {
  return (
    <div className="metricCard">
      <div className="metricValue">{value}</div>
      <div className="metricLabel">{label}</div>
    </div>
  )
}
