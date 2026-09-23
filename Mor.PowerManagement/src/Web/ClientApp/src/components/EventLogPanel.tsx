import { AlertTriangle, Bell, CheckCircle2, History, Zap } from 'lucide-react'
import type { EventLog, Severity } from '../types/dashboard'

type EventLogPanelProps = {
  events: EventLog[]
}

function severityIcon(severity: Severity) {
  if (severity === 'success') return <CheckCircle2 size={16} />
  if (severity === 'warning') return <AlertTriangle size={16} />
  if (severity === 'critical') return <Zap size={16} />
  return <Bell size={16} />
}

export function EventLogPanel({ events }: EventLogPanelProps) {
  return (
    <section className="event-panel" aria-label="Event log and notifications">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Output actions</p>
          <h2>Event log and notifications</h2>
        </div>
        <History size={20} />
      </div>
      <div className="event-list">
        {events.slice(0, 8).map((event) => (
          <article className={`event-item ${event.severity}`} key={event.id}>
            <div className="event-icon">{severityIcon(event.severity)}</div>
            <div>
              <div className="event-title-row">
                <h3>{event.title}</h3>
                <time>{event.time}</time>
              </div>
              <p>{event.detail}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
