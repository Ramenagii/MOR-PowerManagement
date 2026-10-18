import { AlertTriangle, Bell, CheckCircle2, History, X, Zap } from 'lucide-react'
import type { EventLog, Severity } from '../types/dashboard'

type EventLogPanelProps = {
  events: EventLog[]
  /**
   * Rendered at the end of the header row. The log now lives behind the top
   * bar's bell, so the header carries the drawer's dismiss control rather than
   * the body growing a scrollbar next to it.
   */
  onDismiss?: () => void
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
 *
 * This grammar is also why the bell badge stays neutral. Severity now has
 * exactly one home — this list — and a second coloured badge beside the status
 * pill in the top bar would put the same signal in two places at two different
 * scopes, where the operator would have to work out which one is current.
 */
const SEVERITY_VIEWS: Record<Severity, SeverityView> = {
  info: { dot: 'ant-dot bg-outline', Icon: Bell },
  success: { dot: 'ant-dot bg-outline-variant', Icon: CheckCircle2 },
  warning: { dot: 'ant-dot ant-dot-warning', Icon: AlertTriangle },
  critical: { dot: 'ant-dot ant-dot-critical', Icon: Zap },
}

/**
 * The log itself.
 *
 * It used to be a full-width section in the dashboard flow, where it held the
 * page at 1289x640px permanently — the tallest block on the screen, showing
 * eight rows of mostly-historical text that nobody scrolls down to read while
 * the rig is running. It is now the body of the notification centre in the top
 * bar: out of the flow, on demand, and exactly as legible as it was.
 *
 * Nothing about the entry design moved. Icon tile, title, timestamp, severity
 * dot and word, and the backend's verbatim `detail` are all here, because the
 * detail is the one sentence on this console written by the code that raised
 * the event. What changed is where the reader meets it.
 */
export function EventLogPanel({ events, onDismiss }: EventLogPanelProps) {
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
        <div className="flex shrink-0 items-center gap-2">
          {hidden > 0 && (
            <span className="font-body-sm text-body-sm text-on-surface-variant">
              Newest <span className="font-metric-value text-metric-value">{shown.length}</span> shown
            </span>
          )}
          {onDismiss && (
            <button type="button" className="ant-btn ant-btn-default h-8 px-2" onClick={onDismiss}>
              <X size={16} className="text-outline" aria-hidden="true" />
              <span className="sr-only">Close the event log</span>
            </button>
          )}
        </div>
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
            simulator on the dashboard to generate them against the real device.
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
                  {event.actor && <p className="mt-1 font-code text-code text-outline">Changed by {event.actor}</p>}
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
