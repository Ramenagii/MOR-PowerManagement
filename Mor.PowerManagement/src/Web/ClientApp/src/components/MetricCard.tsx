import type { ReactNode } from 'react'

type MetricCardProps = {
  icon: ReactNode
  label: string
  value: string
  note: string
}

export function MetricCard({ icon, label, value, note }: MetricCardProps) {
  return (
    <article className="metric-card">
      <div className="metric-icon">{icon}</div>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
        <span>{note}</span>
      </div>
    </article>
  )
}
