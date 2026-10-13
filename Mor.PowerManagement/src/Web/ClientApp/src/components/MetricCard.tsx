import type { ReactNode } from 'react'

type MetricCardProps = {
  icon: ReactNode
  label: string
  value: string
  note: string
  /**
   * `critical` means the figure could not be measured at all, not that it is
   * large. The distinction is why the card takes a tone rather than deriving
   * one: an unreadable reading must never wear the accent that says "you are
   * near a limit".
   */
  tone?: 'critical'
}

/**
 * One reading in the dashboard summary.
 *
 * The label is a micro-label, the value is the one figure on the card, and the
 * note is where the caveat lives. `value` is a string rather than a number
 * because "No reading" has to be expressible here — a numeric prop would force
 * the faulted state to render as `0 W`, which is the exact lie this console
 * exists to avoid.
 */
export function MetricCard({ icon, label, value, note, tone }: MetricCardProps) {
  const critical = tone === 'critical'
  return (
    <article className="metric-card" aria-label={label} data-tone={tone ?? 'neutral'}>
      <div className="metric-icon" style={critical ? { color: '#C24136' } : undefined}>
        {icon}
      </div>
      <div>
        <p style={critical ? { color: '#C24136' } : undefined}>{label}</p>
        <strong
          style={
            critical
              ? { fontSize: '1.5rem', lineHeight: '1.75rem', letterSpacing: '-0.015em' }
              : undefined
          }
        >
          {value}
        </strong>
        <span>{note}</span>
      </div>
    </article>
  )
}