import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { Activity, TriangleAlert } from 'lucide-react'
import type { TelemetrySeries } from '../api'
import {
  BAND_DOT,
  BAND_FILL,
  BAND_HEX,
  BAND_INK,
  BAND_LABEL,
  BAND_RULE,
  DASHBOARD_TIPS,
  UNAVAILABLE,
  type LoadBand,
} from '../data/dashboard'
import { FLASH_OVERLAY, PULSE_RING, useValueFlash } from './DashboardMotion'

/** Window the rail plots. Matches the endpoint it polls and the "−15 min" axis. */
const WINDOW_MINUTES = 15

type HistoryBucket = {
  watts: number | null
  /** UTC clock label for the bucket, or null when the server sent nothing. */
  label: string
}

export type DashboardRailProps = {
  /** Live total from GET /Dashboard/state. Ignored while `live` is false. */
  load: number
  warning: number
  critical: number
  max: number
  series: TelemetrySeries | null
  status: 'loading' | 'ready' | 'error'
  /**
   * True when the stream is not currently delivering. The live marker stops
   * pulsing while this holds: a marker that keeps pulsing over stale data would
   * be claiming freshness the rig no longer has.
   */
  stale: boolean
  /**
   * False when the dashboard has no live state from the backend. Every
   * measurement then renders as an em dash instead of the seeded rig baseline:
   * a 260 W figure the firmware never reported is a mock, not a reading.
   */
  live: boolean
  /** Staleness label from the telemetry window, e.g. "Live · 5 s". */
  streamLabel: string
  /** True while the telemetry poll is succeeding; gates the streaming dot. */
  streamLive: boolean
  /** Energized relay count, or null when it is not known. */
  energized: number | null
  /** Wired channel count on this bench. */
  channelCount: number
}

/**
 * One cell of the Headroom / Energized / P_limit trio.
 *
 * A real <dt>/<dd> pair inside the parent <dl>, so the grouping is semantic
 * rather than three loose divs that merely happen to sit in a row.
 */
function StatCell({ label, title, children }: { label: string; title: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 border-l-2 border-outline-variant pl-2">
      <dt
        className="whitespace-nowrap font-body-sm text-body-sm uppercase tracking-wide text-outline"
        title={title}
      >
        {label}
      </dt>
      <dd className="min-w-0 truncate">{children}</dd>
    </div>
  )
}

/**
 * The calibrated load rail — the one instrument this dashboard is built around.
 *
 * The design decision: the history strip and the live reading share a single
 * fixed 0-P_limit axis. The newest recorded bucket and the current state
 * therefore sit in the same coordinate system, so "the load is climbing" and
 * "the load is near the trip point" are one glance instead of two charts the
 * operator has to reconcile.
 *
 * The domain is FIXED, not fitted to the data. An auto-fitted axis would rescale
 * every minute, which makes a flat 440 W trace look like a dramatic ramp and
 * would let the same picture represent a healthy rig and an overloaded one. A
 * calibrated scale is the only kind that can be read honestly across time.
 *
 * Sourcing is kept visibly separate. The columns are recorded buckets from
 * Postgres; the bright marker on the right is the live state read, which is up
 * to a full bucket older than the last column. They are drawn as different
 * objects precisely because they are different claims — folding them into one
 * line would imply a precision the rig does not have.
 */
export function DashboardRail({
  load,
  warning,
  critical,
  max,
  series,
  status,
  stale,
  live,
  streamLabel,
  streamLive,
  energized,
  channelCount,
}: DashboardRailProps) {
  const band = useMemo<LoadBand>(() => {
    if (load >= critical) return 'critical'
    if (load >= warning) return 'warning'
    return 'normal'
  }, [load, warning, critical])

  const { buckets, spanMinutes } = useMemo(() => {
    const bucketSeconds = series?.bucketSeconds ?? 0
    const values = series?.totals.watts ?? []
    if (!series || bucketSeconds <= 0 || values.length === 0) {
      return { buckets: [] as HistoryBucket[], spanMinutes: WINDOW_MINUTES }
    }

    /*
     * The WHOLE 15 m window is drawn, not a five-minute tail. The reference
     * console labels this strip "−15 min", and it already polls the 15 m window,
     * so trimming it would throw away real history and mislabel what is left.
     * Columns are therefore whatever the server resolved, and the axis caption
     * reports the span those columns actually cover rather than assuming one.
     */
    const timestamps = series.timestamps ?? []
    return {
      buckets: values.map((watts, index) => ({
        watts,
        label: clockLabel(timestamps[index]),
      })),
      spanMinutes: Math.round((values.length * bucketSeconds) / 60),
    }
  }, [series])

  /*
   * Column gap follows column count. At a 5 s resolution the 15 m window is 180
   * columns; a fixed 2px gap would spend 358px on gaps alone and push the
   * newest buckets out of view on a phone. The gap therefore narrows as density
   * rises, and the row clips as a last-resort guarantee that no page-level
   * horizontal scroll can ever appear.
   */
  const columnGap = buckets.length > 90 ? 0 : buckets.length > 40 ? 1 : 2

  const headroom = critical - load
  const loadPercent = max > 0 ? Math.min((load / max) * 100, 100) : 0
  /** True when the live total has passed P_limit and the marker pins to the top. */
  const overloaded = live && load > max
  /** Fires once per change in the live total; decoration only. */
  const flash = useValueFlash(live ? load : 0)

  const hasHistory = buckets.length > 0 && buckets.some((b) => b.watts !== null)
  const showSkeleton = !hasHistory && status === 'loading'
  const showEmpty = !hasHistory && status !== 'loading'

  const pct = (value: number) => (max > 0 ? Math.min(Math.max((value / max) * 100, 0), 100) : 0)

  /*
   * Every measurement renders as an em dash while the dashboard holds no live
   * state. The rig baseline seeded into `data/dashboard.ts` is a fixture for
   * tests and the pre-login paint; rendering it as though the firmware had
   * reported it is exactly the mock this console must never show.
   */
  const shownLoad = live ? Math.round(load).toLocaleString() : UNAVAILABLE

  return (
    <section className="ant-card overflow-hidden" aria-label="Bus load rail">
      {/* ---- Block 1: total load hero, then the metric trio ------------------
          Order is fixed by the reference console: label, value, "% of limit",
          then Headroom / Energized / P_limit underneath. Nothing is added
          between them, so the eye lands on the one number that matters and
          walks down a single column. ---- */}
      <div className="flex flex-col gap-space-md border-b border-surface-container px-space-lg py-space-md">
        <div className="flex flex-wrap items-baseline justify-between gap-x-space-lg gap-y-1">
          <span
            className="font-body-sm text-body-sm uppercase tracking-wide text-outline"
            title={DASHBOARD_TIPS.total}
          >
            Total load
          </span>

          {/* Band rides the hero's own row rather than becoming its own block,
              so the warning/critical state is adjacent to the figure it
              qualifies without disturbing the specified order. */}
          <span
            className="flex items-center gap-1.5 whitespace-nowrap"
            title={`${BAND_LABEL[band]} — ${DASHBOARD_TIPS.bands}`}
          >
            <span className={`ant-dot shrink-0 ${BAND_DOT[band]}`} aria-hidden="true" />
            <span
              className={`font-metric-value text-metric-value font-semibold uppercase tracking-wide ${
                band === 'critical'
                  ? 'text-error'
                  : band === 'warning'
                    ? 'text-tertiary-container'
                    : 'text-on-surface-variant'
              }`}
            >
              {BAND_LABEL[band]}
            </span>
          </span>
        </div>

        {/* relative anchor for the flash overlay */}
        <div className="relative flex items-baseline gap-1 self-start">
          {flash && live && (
            <span
              aria-hidden="true"
              className={`pointer-events-none absolute inset-0 rounded bg-primary/20 ${FLASH_OVERLAY}`}
            />
          )}
          <span
            className={`relative font-metric-display text-metric-display ${
              live ? BAND_INK[band] : 'text-outline'
            }`}
            aria-label={live ? `${shownLoad} watts total` : 'Total load unavailable'}
          >
            {shownLoad}
          </span>
          <span className="relative font-metric-value text-metric-value font-semibold text-on-surface-variant">
            W
          </span>
        </div>

        <span className="font-metric-value text-metric-value text-outline">
          {live ? `${Math.round(loadPercent)}% of ${Math.round(max).toLocaleString()} W limit` : UNAVAILABLE}
        </span>

        {/* Trio. Each cell is a label over a value, in a 3-up grid that
            collapses to a single column on a phone — the grid carries the
            alignment so no cell needs its own label row. */}
        <dl className="grid grid-cols-1 gap-space-sm sm:grid-cols-3">
          <StatCell label="Headroom" title={DASHBOARD_TIPS.headroom}>
            <span
              className={`font-metric-value text-metric-value font-semibold ${
                !live
                  ? 'text-outline'
                  : headroom <= 0
                    ? 'text-error'
                    : band === 'warning'
                      ? 'text-tertiary-container'
                      : 'text-on-surface'
              }`}
            >
              {!live
                ? UNAVAILABLE
                : headroom <= 0
                  ? `${Math.round(Math.abs(headroom)).toLocaleString()} W over`
                  : `${Math.round(headroom).toLocaleString()} W`}
            </span>
          </StatCell>

          <StatCell label="Energized" title={DASHBOARD_TIPS.energized}>
            <span
              className={`font-metric-value text-metric-value font-semibold ${
                energized === null ? 'text-outline' : 'text-on-surface'
              }`}
            >
              {energized === null ? UNAVAILABLE : `${energized}/${channelCount}`}
            </span>
          </StatCell>

          <StatCell label="P_limit" title={DASHBOARD_TIPS.pLimit}>
            <span className="font-metric-value text-metric-value font-semibold text-on-surface">
              {`${Math.round(max).toLocaleString()} W`}
            </span>
          </StatCell>
        </dl>
      </div>

      {/* ---- The rail ---- */}
      <div className="px-space-lg py-space-md">
        {/* Plot height steps with the viewport rather than being fixed: 128px is
            already legible on a phone, and a taller rail is wasted height where
            there is no second thing competing for it. `min-w-0` lets the plot
            shrink inside the card at 360px. */}
        <div
          className="relative h-32 min-w-0 select-none sm:h-40 lg:h-44"
          title={DASHBOARD_TIPS.rail}
          role="img"
          aria-label={`Bus load rail: ${Math.round(load).toLocaleString()} watts of ${max} W capacity, warning at ${warning} W, critical at ${critical} W.`}
        >
          {/* Critical and warning are drawn as ruled lines across the whole plot
              rather than as two numbers in a legend: margin to trip should be
              read as a position on a scale, not as a comparison the operator
              does in their head. */}
          {/*
            Critical sits at 100% of the plot, so its caption hangs BELOW the
            line and warning's hangs ABOVE it. Swapping them would push the
            critical label out through the top of the rail and put the two
            captions within a few pixels of each other.
          */}
          <RuleLine value={critical} max={max} color={BAND_HEX.critical} label={`${critical} W · ${BAND_RULE.critical}`} align="below" />
          <RuleLine value={warning} max={max} color={BAND_HEX.warning} label={`${warning} W · ${BAND_RULE.warning}`} align="above" />

          {/*
            Skeleton is stable, not randomly-sized: the heights are a fixed
            repeating pattern, not a random bar chart, so the panel does not
            look like it is already showing data. `aria-busy` marks the wait
            for assistive tech without adding visible text.
          */}
          {showSkeleton && (
            <div
              className="absolute bottom-0 left-0 right-2 top-0 flex items-end gap-px overflow-hidden pb-px sm:gap-[2px]"
              aria-hidden="true"
            >
              {Array.from({ length: 12 }).map((_, index) => (
                <div
                  key={`sk-${index}`}
                  className="min-w-0 flex-1 basis-0 rounded-t-sm bg-surface-container-high"
                  style={{ height: `${18 + ((index * 13) % 22)}%` }}
                />
              ))}
            </div>
          )}

          {showEmpty && (
            <div className="absolute inset-x-0 bottom-0 top-0 flex items-center justify-center">
              <p className="font-body-sm text-body-sm text-on-surface-variant">
                {status === 'error' ? 'History request failed' : 'No buckets in this window'}
              </p>
            </div>
          )}

          {hasHistory && (
            <>
              {/*
            Recorded buckets. Two rules here:
            - A null bucket renders as a baseline hairline, never a zero-height
              column: a gap the device did not report would otherwise read as a
              measured zero load.
            - They are deliberately drawn muted. The live marker on the right is
              the only fully-saturated thing on the rail, so "where the rig is"
              never has to be hunted for among "where it has been".
            Columns carry a 2px floor and `basis-0`, so a 5 s resolution (~60
            columns for five minutes) still fits 360px without a scrollbar.
          */}
              <div
              className="absolute bottom-0 left-0 right-2 top-0 flex min-w-0 items-end overflow-hidden pb-px"
              style={{ gap: `${columnGap}px` }}
            >
                {buckets.map((bucket, index) => {
                  if (bucket.watts === null) {
                    return (
                      <div
                        key={`gap-${index}`}
                        className="min-w-0 flex-1 basis-0 border-t border-dashed border-outline-variant"
                        title={`${bucket.label} · not reported`}
                      />
                    )
                  }

                  const bucketBand: LoadBand =
                    bucket.watts >= critical ? 'critical' : bucket.watts >= warning ? 'warning' : 'normal'
                  const over = bucket.watts > max

                  return (
                    <div
                      key={`col-${index}`}
                      className={`relative min-w-0 flex-1 basis-0 rounded-t-sm ${BAND_FILL[bucketBand]} opacity-55`}
                      style={{ height: `${over ? 100 : pct(bucket.watts)}%` }}
                      title={`${bucket.label} · ${Math.round(bucket.watts).toLocaleString()} W${
                        over ? ' (over P_limit)' : ''
                      }`}
                    >
                      {over && (
                        <TriangleAlert
                          size={9}
                          className="absolute left-1/2 top-0.5 -translate-x-1/2 text-error"
                          aria-hidden="true"
                        />
                      )}
                    </div>
                  )
                })}
              </div>

              {/*
                Live marker — the one saturated element on the rail, and the
                only continuous animation here besides the header dot. It is
                drawn in its own 8px gutter (the plot above is inset by pr-2)
                so it can never sit on top of the newest column, and the cap
                carries a slow pulse ring so an operator can see at a glance
                that the stream is actually still flowing. It stops pulsing the
                moment polling fails, because a marker that keeps pulsing while
                the data is stale would be lying about the rig.
              */}
              <div
                className="pointer-events-none absolute bottom-0 right-0 top-0 w-2"
                aria-hidden="true"
              >
                <div
                  className="absolute right-1 w-[3px] rounded-full bg-primary"
                  style={{ bottom: 0, height: `${overloaded ? 100 : pct(load)}%` }}
                />
                <span
                  className="absolute right-[5px] h-2.5 w-2.5 rounded-full bg-primary"
                  style={{ bottom: `calc(${overloaded ? 100 : pct(load)}% - 5px)` }}
                />
                {!stale && (
                  <span
                    className={`absolute right-[6px] h-2.5 w-2.5 rounded-full bg-primary ${PULSE_RING}`}
                    style={{ bottom: `calc(${overloaded ? 100 : pct(load)}% - 5px)` }}
                  />
                )}
              </div>
            </>
          )}
        </div>

        {/*
            Axis captions, exactly the pair the reference console shows: the span
            on the left, the stream's freshness on the right. The staleness label
            is the same one the Telemetry view renders ("Live · 5 s"), so the two
            views can never disagree about how old the newest sample is.
            Wraps to two lines at 360px rather than clipping either value.
          */}
        <div className="mt-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 font-code text-code text-outline">
          <span className="whitespace-nowrap">{`−${spanMinutes} min`}</span>
          {/*
            Streaming dot — continuous animation #1 of 2 (the rail's live marker
            is #2). It sits beside the freshness label because that is where the
            reference console puts "Live · 5 s", and because a pulse next to a
            claim about freshness is a claim about freshness. It stops the moment
            polling fails rather than continuing to advertise a dead stream.
          */}
          <span className="flex min-w-0 items-center gap-1.5" title={DASHBOARD_TIPS.live}>
            <span className="relative flex h-2 w-2 shrink-0 items-center justify-center" aria-hidden="true">
              <span className={`h-2 w-2 rounded-full ${streamLive ? 'bg-primary' : 'bg-outline'}`} />
              {streamLive && (
                <span className={`absolute h-2 w-2 rounded-full bg-primary ${PULSE_RING}`} />
              )}
            </span>
            <Activity size={11} className="shrink-0" aria-hidden="true" />
            <span className="truncate">{streamLabel}</span>
          </span>
        </div>
      </div>
    </section>
  )
}

/**
 * One threshold rule. `align` flips the caption above or below the line so the
 * warning and critical labels never collide at these proportions, and both are
 * left-aligned to stay clear of the live marker at the right edge.
 */
function RuleLine({
  value,
  max,
  color,
  label,
  align,
}: {
  value: number
  max: number
  color: string
  label: string
  align: 'above' | 'below'
}) {
  const offset = max > 0 ? Math.min(Math.max((value / max) * 100, 0), 100) : 0

  return (
    <div
      className="pointer-events-none absolute inset-x-0"
      style={{ bottom: `${offset}%` }}
      aria-hidden="true"
    >
      <div className="relative border-t border-dashed" style={{ borderColor: color }}>
        <span
          className="absolute left-0 whitespace-nowrap font-code"
          style={{
            fontSize: 10,
            color,
            fontWeight: 600,
            ...(align === 'above' ? { bottom: 3 } : { top: 3 }),
          }}
        >
          {label}
        </span>
      </div>
    </div>
  )
}

function clockLabel(stamp: string | undefined): string {
  if (!stamp) return '--:--'
  const date = new Date(stamp)
  if (Number.isNaN(date.getTime())) return '--:--'
  return [date.getUTCHours(), date.getUTCMinutes()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')
}