import {
  CircleCheckBig,
  ClipboardList,
  Power,
  ShieldCheck,
  TriangleAlert,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { BAND_DOT, SIM_VECTORS, VECTOR_IDLE, type SimIconKey } from '../data/dashboard'
import type { ScenarioNotice } from './ScenarioPanel'

const ICONS: Record<SimIconKey, LucideIcon> = {
  nominal: CircleCheckBig,
  gate: Zap,
  warn: ShieldCheck,
  critical: TriangleAlert,
  priority: ClipboardList,
  standby: Power,
}

/**
 * The last-result rail.
 *
 * Colour discipline carried over from the scenario panel: amber means the
 * device answered but nothing was written, red means the write was rejected,
 * and the success case is a quiet neutral rather than a green chip. Green is
 * not a state colour in this console, and a run that succeeded is not more
 * interesting than one that failed. The result still reads as success because
 * the tag says STORED.
 */
const NOTICE_RAIL: Record<ScenarioNotice['tone'], string> = {
  live: 'border-l-outline-variant',
  simulated: 'border-l-tertiary',
  error: 'border-l-error',
}

const NOTICE_DOT: Record<ScenarioNotice['tone'], string> = {
  live: 'bg-outline-variant',
  simulated: 'ant-dot-warning',
  error: 'ant-dot-critical',
}

const NOTICE_TAG: Record<ScenarioNotice['tone'], string> = {
  live: 'STORED',
  simulated: 'NO WRITE',
  error: 'REJECTED',
}

const NOTICE_LABEL: Record<ScenarioNotice['tone'], string> = {
  live: 'Stored on the server',
  simulated: 'Nothing was stored',
  error: 'Write rejected',
}

type DashboardSimRailProps = {
  onRun: (id: string) => void
  notice: ScenarioNotice | null
  busy: boolean
  /**
   * False when the dashboard has no live backend state. The triggers are
   * disabled rather than posting to an endpoint whose response nobody could see.
   */
  live: boolean
}

/**
 * SIM-01..06 as a rail of icon-only triggers.
 *
 * The six vectors previously occupied six cards, each one a paragraph. Every
 * word of that prose survives — it is on the tooltip now, where it was always
 * most useful, because a defense panel needs to *ask* what SIM-04 does rather
 * than read six descriptions to find one.
 *
 * Icons carry the vectors apart at a glance, and each is drawn to match its own
 * effect: the gate for the activation request, the shield for the capacity
 * block, the triangle for the overload. The SIM number survives in the tooltip
 * and the accessible name, so a thesis cross-reference to "SIM-04" still lands
 * on the same control.
 */
export function DashboardSimRail({ onRun, notice, busy, live }: DashboardSimRailProps) {
  return (
    <section className="ant-card overflow-hidden" aria-label="Scenario vectors">
      <div className="flex flex-wrap items-center justify-between gap-x-space-lg gap-y-1 border-b border-surface-container px-space-lg py-space-sm">
        <h2 className="font-title-lg text-title-lg font-semibold text-on-surface">Vectors</h2>
        <span className="whitespace-nowrap font-metric-value text-metric-value text-outline">
          POST /api/Dashboard/scenarios/ingest
        </span>
      </div>

      <div className="flex flex-col gap-space-md px-space-lg py-space-md">
        {/*
          Icon triggers wrap rather than clip. Each is 40px square — above the
          24px WCAG 2.2 pointer-target floor and a comfortable touch target on
          a phone — and the row is a wrapping flex collection, so the chip
          collection reflow rule is satisfied without a `+n` disclosure.
        */}
        <div className="flex flex-wrap items-center gap-2">
          {SIM_VECTORS.map((vector) => {
            const Icon = ICONS[vector.icon]
            const tooltip = [
              `${vector.id} · ${vector.name}`,
              vector.intent,
              `Expect: ${vector.expectation}`,
              vector.endpoint,
            ].join('\n')

            return (
              <button
                key={vector.id}
                type="button"
                disabled={busy || !live}
                onClick={() => onRun(vector.id)}
                title={tooltip}
                aria-label={`${vector.id}, ${vector.name}`}
                className="ant-btn ant-btn-default h-10 w-10 !px-0"
              >
                <span
                  className={`flex h-full w-full flex-col items-center justify-center gap-0.5 ${
                    vector.tone === 'critical'
                      ? 'text-error'
                      : vector.tone === 'warning'
                        ? 'text-tertiary-container'
                        : 'text-on-surface-variant'
                  }`}
                >
                  <Icon size={16} aria-hidden="true" />
                  {vector.tone && (
                    <span className={`ant-dot ${BAND_DOT[vector.tone]}`} aria-hidden="true" />
                  )}
                </span>
              </button>
            )
          })}

          {busy && (
            <span className="ml-1 inline-flex items-center gap-1.5 whitespace-nowrap font-body-sm text-body-sm text-on-surface-variant">
              <span className="ant-dot bg-outline animate-ping motion-reduce:animate-none" aria-hidden="true" />
              In flight
            </span>
          )}
        </div>

        {/* The one place on this dashboard that is allowed to be a sentence:
            the server's own report, rendered verbatim and never reworded. */}
        <div
          className={`flex flex-col gap-1 rounded-md border border-l-4 bg-surface-container px-space-md py-space-sm ${
            notice ? NOTICE_RAIL[notice.tone] : 'border-l-outline-variant'
          }`}
          role="status"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-metric-value text-metric-value text-outline">
              {busy ? 'DISPATCH' : notice ? NOTICE_TAG[notice.tone] : 'IDLE'}
            </span>
            {!busy && notice && (
              <span className="flex items-center gap-1.5 font-body-sm text-body-sm text-on-surface-variant">
                <span className={`ant-dot ${NOTICE_DOT[notice.tone]}`} aria-hidden="true" />
                {NOTICE_LABEL[notice.tone]}
              </span>
            )}
          </div>
          <p className="font-body-sm text-body-sm text-on-surface">
            {busy ? 'Posting telemetry batch…' : notice ? notice.text : VECTOR_IDLE}
          </p>
        </div>
      </div>
    </section>
  )
}