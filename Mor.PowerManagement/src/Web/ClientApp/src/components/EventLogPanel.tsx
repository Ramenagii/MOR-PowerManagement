import { AlertTriangle, Bell, CheckCircle2, History, Zap } from 'lucide-react'
import type { EventLog, Severity } from '../types/dashboard'

type EventLogPanelProps = {
  events: EventLog[]
}

/** How many rows the panel shows. The header states the rest, never hides it. */
const VISIBLE_EVENTS = 8

type SeverityView = { dot: string; Icon: typeof Bell }

/**
 * One status dot per row, and nothing else. The dot is the only place severity
 * is allowed to show as colour, so a row reads at a glance without stacking a
 * second coloured pill beside it.
 *
 * Info and success both wear the neutral outline dot. Green is not a state
 * colour in this console: a successful event is not healthier than an
 * informational one, it is just older news, so it gets the same quiet grey and
 * the palette stays neutral + blue + amber + red. `.ant-dot-normal` is still
 * `bg-secondary` in the shared ant.css, so the neutral is applied as a utility
 * here rather than by editing shared CSS.
 */
const SEVERITY_VIEWS: Record<Severity, SeverityView> = {
  info: { dot: 'ant-dot bg-outline', Icon: Bell },
  success: { dot: 'ant-dot bg-outline-variant', Icon: CheckCircle2 },
  warning: { dot: 'ant-dot ant-dot-warning', Icon: AlertTriangle },
  critical: { dot: 'ant-dot ant-dot-critical', Icon: Zap },
}

export function EventLogPanel({ events }: EventLogPanelProps) {
  const shown = events.slice(0, VISIBLE_EVENTS)
  const hidden = events.length - shown.length

  return (
    <section className="ant-card overflow-hidden" aria-label="Event log and notifications">
      <div className="ant-card-header">
        <div className="flex min-w-0 items-center gap-space-sm">
          <History size={18} className="shrink-0 text-primary" aria-hidden="true" />
          <h2 className="font-title-lg text-title-lg font-semibold text-on-surface">
            Event log and notifications
          </h2>
          <span className="shrink-0 font-body-sm text-body-sm text-on-surface-variant">
            <span className="font-metric-value text-metric-value">{events.length}</span> total
          </span>
        </div>
        {hidden > 0 && (
          <span className="shrink-0 font-body-sm text-body-sm text-on-surface-variant">
            Newest <span className="font-metric-value text-metric-value">{shown.length}</span> shown
          </span>
        )}
      </div>

      {shown.length === 0 ? (
        <div className="ant-card-body flex flex-col items-start gap-2">
          <div className="flex items-center gap-2">
            <span className="ant-dot ant-dot-warning" aria-hidden="true" />
            <span className="font-title-md text-title-md font-semibold text-on-surface">Nothing logged yet</span>
          </div>
          <p className="max-w-2xl font-body-md text-body-md text-on-surface-variant">
            No relay action, threshold crossing or shed decision has been recorded since this console
            connected. Events appear the moment the policy engine makes one — run a scenario from the
            simulator above to generate them against the real device.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-outline-variant">
          {shown.map((event) => {
            const view = SEVERITY_VIEWS[event.severity]
            const Icon = view.Icon
            return (
              <li key={event.id} className="flex items-start gap-space-sm px-space-lg py-space-md">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-surface-container-low text-on-surface-variant">
                  <Icon size={16} aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-space-sm gap-y-1">
                    <h3 className="font-title-md text-title-md font-semibold text-on-surface">{event.title}</h3>
                    <time className="shrink-0 font-metric-value text-metric-value text-on-surface-variant">
                      {event.time}
                    </time>
                  </div>
                  <p className="mt-0.5 font-body-sm text-body-sm text-on-surface-variant">{event.detail}</p>
                </div>
                <span className="inline-flex shrink-0 items-center gap-1.5 pt-0.5">
                  <span className={view.dot} aria-hidden="true" />
                  <span className="font-body-sm text-body-sm uppercase text-on-surface-variant">{event.severity}</span>
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}