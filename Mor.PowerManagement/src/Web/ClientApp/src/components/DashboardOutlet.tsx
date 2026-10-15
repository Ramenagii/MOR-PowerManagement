import { useMemo } from 'react'
import { Power } from 'lucide-react'
import {
  DASHBOARD_TIPS,
  UNAVAILABLE,
  relayGpio,
  type LoadBand,
} from '../data/dashboard'
import type { Outlet } from '../types/dashboard'
import { isEnergizedOutlet } from '../utils/dashboard'
import { HISTORY_SPAN_SECONDS } from '../data/telemetry'
import { FLASH_OVERLAY, useValueFlash } from './DashboardMotion'

type DashboardOutletProps = {
  outlet: Outlet
  warning: number
  critical: number
  /** Configured P_limit, so this strip shares the rail's domain. */
  max: number
  /** Recorded watt buckets for this channel, oldest first. */
  history: Array<number | null>
  /**
   * False when the dashboard holds no live backend state. Readings become em
   * dashes and the relay action is disabled rather than posting a command
   * against a session that cannot answer.
   */
  live: boolean
  onToggle: (id: number) => void
}

/**
 * One controlled channel, read as an instrument face rather than a report card.
 *
 * The ordering is the design: watts is the hero and the only thing at display
 * size, with volts and current demoted to a single mono line beneath it. On the
 * original card all three sat at the same weight, which meant the eye had no
 * entry point and read the card as a block instead of a number.
 *
 * Amps is DERIVED here. `GET /Dashboard/state` returns watts and the rated rail
 * voltage, not an amps field, so what is shown is P / V with a power factor of
 * assumed 1. The tooltip says so and the figure is never presented as a direct
 * CT reading.
 *
 * Relay state is spelled out as OPEN / CLOSED rather than left to a dot, because
 * the two states are what an operator acts on and a colour alone would be
 * unreadable to a colour-blind viewer or on a washed-out projector.
 */
export function DashboardOutlet({ outlet, warning, critical, max, history, live, onToggle }: DashboardOutletProps) {
  const energized = isEnergizedOutlet(outlet.status)

  const band = useMemo<LoadBand>(() => {
    if (outlet.watts >= critical) return 'critical'
    if (outlet.watts >= warning) return 'warning'
    return 'normal'
  }, [outlet.watts, warning, critical])

  const hasSamples = history.some((value) => value !== null)
  const historyMax = useMemo(() => {
    // Scaled against P_limit, not against this channel's own peak, so two
    // channels side by side are read on one scale instead of each filling its
    // own box and looking equally loaded.
    const peak = history.reduce<number>((max, value) => (value !== null && value > max ? value : max), 0)
    return Math.max(peak, 1)
  }, [history])

  const overAllowance = outlet.allowance > 0 && outlet.watts > outlet.allowance
  const scaledToP = (value: number) => (max > 0 ? Math.min((value / max) * 100, 100) : 0)

  /*
   * Current when the device actually reports a draw. A branch the firmware has
   * measured as drawing nothing is a real 0.00 A and is shown as one — that is
   * the firmware proving the relay is open, not a gap in the data.
   */
  const shownAmps = live && outlet.volts > 0 ? outlet.watts / outlet.volts : null

  // One flash per actual change in this channel's load. Event-driven, so it
  // stops dead when the value settles rather than sitting on as ambient motion.
  const flash = useValueFlash(live ? outlet.watts : 0)

  return (
    <article
      className="ant-card flex flex-col gap-space-sm p-space-md"
      aria-label={`${outlet.name}, relay ${energized ? 'closed' : 'open'} on ${relayGpio(outlet.id)}, ${Math.round(outlet.watts).toLocaleString()} watts`}
    >
      {/*
        Header. The relay state is a COMPACT LABEL, so it is held together on
        one line and never allowed to wrap or clip; the outlet name is the
        variable-length part, so it is the one that shrinks and wraps.

        Both facts are reachable without a pointer: the card's aria-label above
        restates the relay state, the GPIO and the load, so the tooltip is an
        enrichment rather than the only path to the value.
      */}
      <header className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="shrink-0 font-metric-value text-metric-value font-semibold text-on-surface">
            {`CH${String(outlet.id).padStart(2, '0')}`}
          </span>
          <span
            className="min-w-0 break-words font-title-md text-title-md leading-tight text-on-surface-variant"
            title={outlet.name}
          >
            {outlet.name}
          </span>
        </div>
        <span
          className={`shrink-0 whitespace-nowrap font-metric-value text-metric-value font-semibold ${
            energized ? 'text-on-surface' : 'text-outline'
          }`}
          title={`${outlet.relay} on ${relayGpio(outlet.id)} — ${DASHBOARD_TIPS.relay}`}
        >
          {energized ? 'CLOSED' : 'OPEN'}
        </span>
      </header>

      {/* Hero: this channel's load. The unit rides at metric-value, one step
          below the figure, so the digits stay the loudest thing.

          The overlay is absolutely positioned inside a relatively positioned
          box, so a flash can never widen the figure and shove the unit along.
          That is the "reserve space so updates do not shift neighbouring
          content" rule, and it matters here because the value changes at 1 Hz. */}
      <div className="relative flex items-baseline gap-1 self-start">
        {flash && (
          <span
            aria-hidden="true"
            className={`pointer-events-none absolute inset-0 rounded bg-primary/20 ${FLASH_OVERLAY}`}
          />
        )}
        <span
          className={`relative font-metric-display text-metric-display ${
            !live ? 'text-outline' : overAllowance ? 'text-error' : band === 'warning' ? 'text-tertiary-container' : 'text-on-surface'
          }`}
        >
          {live ? Math.round(outlet.watts).toLocaleString() : UNAVAILABLE}
        </span>
        <span className="relative font-metric-value text-metric-value font-semibold text-on-surface-variant">W</span>
      </div>

      {/* Electrical context. Each token is its own nowrap span and the row
          wraps BETWEEN tokens, so "GPIO2" or "0.22A" can never be broken across
          two lines while the line as a whole reflows freely from 360px up. This
          is the long-token wrapping rule: give every token min-inline-size: 0
          and let it wrap, rather than forcing nowrap on the whole string. */}
      <p className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 font-code text-code text-on-surface-variant">
        <span className="whitespace-nowrap" title={DASHBOARD_TIPS.outlet}>
          {`${outlet.volts}V`}
        </span>
        <span className="whitespace-nowrap text-outline">·</span>
        <span className="whitespace-nowrap" title={DASHBOARD_TIPS.amps}>
          {shownAmps === null ? UNAVAILABLE : `${shownAmps.toFixed(2)}A`}
        </span>
        <span className="whitespace-nowrap text-outline">·</span>
        <span className="whitespace-nowrap">{outlet.priority}</span>
        <span className="whitespace-nowrap text-outline">·</span>
        <span className="whitespace-nowrap text-outline">{relayGpio(outlet.id)}</span>
      </p>

      {/* Per-channel strip. Shares the rail's 0-P_limit domain so the two rows
          read as one scale; a channel at 260 W therefore tops out around two
          fifths of its box rather than filling it. Each column wears the band
          its OWN value fell in — colouring the whole history with today's band
          would rewrite the past every time the load crosses a threshold. */}
      {/*
          Columns must never overflow at 360px. The server owns the bucket grid,
          so a 5 s resolution returns ~60 columns for the same five minutes;
          each therefore gets a 2px floor with `basis-0` + `flex-1` and the row
          clips rather than pushing a horizontal scrollbar onto the page.
        `min-w-0` on the row lets it shrink inside the card at all.
      */}
      <div className="h-12" title={DASHBOARD_TIPS.rail}>
        {hasSamples ? (
          <div className="flex h-full min-w-0 items-end gap-px overflow-hidden sm:gap-[2px]">
            {history.map((value, index) =>
              value === null ? (
                <div
                  key={`gap-${index}`}
                  className="min-w-[2px] flex-1 basis-0 border-t border-dashed border-outline-variant"
                />
              ) : (
                <div
                  key={`col-${index}`}
                  className={`min-w-[2px] flex-1 basis-0 rounded-t-sm ${
                    value >= critical ? 'bg-error' : value >= warning ? 'bg-tertiary-container' : 'bg-primary'
                  } opacity-60`}
                  style={{ height: `${Math.max(3, scaledToP(value))}%` }}
                  title={`${Math.round(value).toLocaleString()} W`}
                />
              ),
            )}
          </div>
        ) : (
          <div className="flex h-full min-w-0 items-end gap-px overflow-hidden" aria-hidden="true">
            {Array.from({ length: 16 }).map((_, index) => (
              <div
                key={`sk-${index}`}
                className="min-w-[2px] flex-1 basis-0 rounded-t-sm bg-surface-container-high"
                style={{ height: '12%' }}
              />
            ))}
          </div>
        )}
        <div className="mt-1 flex min-w-0 flex-wrap items-center justify-between gap-x-2 font-code text-code text-outline">
          <span className="whitespace-nowrap">{`${Math.round(HISTORY_SPAN_SECONDS / 60)} min`}</span>
          <span className="whitespace-nowrap text-on-surface-variant">{`${Math.round(historyMax)} W peak`}</span>
        </div>
      </div>

      {/* Allowance. The only bar on this card, and the only place it needs a
          second scale: the rail above answers "how close to the trip", this
          answers "is this branch over its own budget". */}
      <div className="mt-auto flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 font-code text-code">
          <span className="whitespace-nowrap text-outline">{`ALLOW ${Math.round(outlet.allowance)}W`}</span>
          <span className={`whitespace-nowrap ${overAllowance ? 'text-error' : 'text-on-surface-variant'}`}>
            {live ? `${Math.round((outlet.watts / Math.max(outlet.allowance, 1)) * 100)}%` : UNAVAILABLE}
          </span>
        </div>
        <div
          className="ant-meter"
          role="meter"
          aria-valuenow={Math.round((outlet.watts / Math.max(outlet.allowance, 1)) * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${outlet.name} load against its allowance`}
        >
          <div
            className={`ant-meter-fill ${
              overAllowance ? 'bg-error' : energized ? 'bg-primary' : 'bg-outline-variant'
            }`}
            style={{ width: `${Math.min((outlet.watts / Math.max(outlet.allowance, 1)) * 100, 100)}%` }}
          />
        </div>
      </div>

      {/* Activation is a REQUEST the policy engine may deny on capacity
          grounds, so it is deliberately not the primary command on this card.
          Icon-only, with the label in the tooltip and the accessible name. */}
      <button
        type="button"
        className="ant-btn ant-btn-default w-full"
        disabled={!live}
        onClick={() => onToggle(outlet.id)}
        aria-label={energized ? `Disconnect ${outlet.name}` : `Request activation for ${outlet.name}`}
        title={
          live
            ? energized
              ? `Disconnect ${outlet.name}`
              : `Request activation for ${outlet.name}`
            : DASHBOARD_TIPS.offline
        }
      >
        <Power size={16} className={energized ? 'text-outline' : 'text-primary'} aria-hidden="true" />
      </button>
    </article>
  )
}