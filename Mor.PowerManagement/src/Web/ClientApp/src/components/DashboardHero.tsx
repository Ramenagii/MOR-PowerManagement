import { useMemo } from 'react'
import type { TelemetrySeries } from '../api'

type DashboardHeroProps = {
  /** Live total from GET /Dashboard/state. Ignored while `live` is false. */
  load: number
  warning: number
  critical: number
  max: number
  energized: number
  channelCount: number
  series: TelemetrySeries | null
  live: boolean
  /** Freshness label for the newest stored sample, e.g. "Live · 5 s". */
  streamLabel: string
  streamLive: boolean
  onSignIn: () => void
}

const CHART_W = 800
const CHART_H = 170

/**
 * Vertical padding inside the plot, so a full-scale line never touches the frame.
 */
const PLOT_INSET = 6

/**
 * The dash for "there is no configured value to show".
 *
 * Used only where a 0 would be an ARITHMETICALLY TRUE but operationally false
 * number: headroom against a ceiling of 0 is 0 W, which reads as "you are
 * exactly at the trip point" on a rig that has no trip point configured. An em
 * dash cannot be misread as a measurement. Measured figures themselves still
 * read 0 when nothing has been measured — see `live` in Dashboard.
 */
const UNAVAILABLE = '—'

type Domain = { min: number; max: number }

/**
 * Fit the y-domain to the window rather than to 0..P_limit.
 *
 * This is the fix for the flat-line problem. A rig sitting at 67 W against a
 * 4400 W ceiling drew its trace in the bottom hundredth of the plot, so 15
 * minutes of real movement was invisible and the chart read as an empty box.
 *
 * Two guards keep the fit honest:
 *   - The span is floored at a small fraction of P_limit, so a genuinely flat
 *     trace is not magnified into a dramatic ramp that misrepresents the rig.
 *   - The trip ceiling stays in frame whenever the data approaches it, so the
 *     "how close am I" read survives the rescale. The meter and the Headroom
 *     figure carry that job the rest of the time.
 *
 * `limit` is whatever the server reported and is 0 when it reported nothing; the
 * 2% floor below then collapses to the 1 W absolute floor, which is the correct
 * behaviour for a rig with no configured ceiling rather than a silent guess at
 * one. Every figure quoted here was measured against the reference rig's own
 * domain — real jitter uses most of the plot height at every load the rig sees,
 * a truly flat line uses 0% and stays flat, and a few watts of noise is held to
 * the floor rather than filling the box.
 */
function fitDomain(values: Array<number | null>, limit: number): Domain {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const value of values) {
    if (value === null || !Number.isFinite(value)) continue
    if (value < min) min = value
    if (value > max) max = value
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: Math.max(limit, 1) }
  }

  // 2% of the ceiling: large enough that sensor noise around zero cannot be
  // stretched into a mountain range, small enough that real variation still
  // fills the plot.
  const floor = Math.max(limit * 0.02, 1)
  const span = Math.max(max - min, floor)
  const pad = span * 0.12

  // Never let the domain fall below zero: power is not negative, and a floor
  // under zero would draw empty space beneath a trace that never went there.
  const domainMin = Math.max(0, min - pad)
  const domainMax = Math.max(domainMin + floor, max + pad)
  return { min: domainMin, max: domainMax }
}

/**
 * Chart path builder, ported from the reference mock's `path()`.
 *
 * `x = i/(n-1)*w`. On y the reference used `h - min(v/max,1)*(h-4) - 2`, which
 * assumed a zero-based domain; here the domain has a real floor, so the value is
 * normalized into [min,max] first and the same 4px/2px inset is applied to keep
 * the stroke off the frame.
 */
function buildPath(
  values: Array<number | null>,
  w: number,
  h: number,
  domain: Domain,
  close: boolean,
): string {
  const points: string[] = []
  const span = domain.max - domain.min || 1
  const usable = h - PLOT_INSET * 2

  values.forEach((value, i) => {
    if (value === null || !Number.isFinite(value)) return
    const x = values.length <= 1 ? w / 2 : (i / (values.length - 1)) * w
    const ratio = Math.min(Math.max((value - domain.min) / span, 0), 1)
    const y = h - PLOT_INSET - ratio * usable
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`)
  })
  if (points.length === 0) return ''

  const line = `M${points.join(' L')}`
  return close ? `${line} L${w},${h} L0,${h} Z` : line
}

export function DashboardHero({
  load,
  warning,
  critical,
  max,
  energized,
  channelCount,
  series,
  live,
  streamLabel,
  streamLive,
  onSignIn,
}: DashboardHeroProps) {
  const totals = series?.totals.watts ?? []
  const hasData = totals.some((v) => v !== null && Number.isFinite(v))

  const domain = useMemo(() => fitDomain(totals, max), [totals, max])

  const paths = useMemo(
    () => ({
      area: hasData ? buildPath(totals, CHART_W, CHART_H, domain, true) : '',
      line: hasData ? buildPath(totals, CHART_W, CHART_H, domain, false) : '',
    }),
    [totals, domain, hasData],
  )

  /*
   * Threshold rules are drawn only when they fall inside the fitted domain.
   * With the axis scaled to the data, a 4400 W ceiling over a few hundred watts
   * of trace sits far off the top of the plot; drawing it anyway would either
   * clip or squeeze the trace back down to the floor, which is the very bug this
   * change fixes.
   */
  const ruleY = (watts: number): number | null => {
    const span = domain.max - domain.min || 1
    const ratio = (watts - domain.min) / span
    if (ratio < 0 || ratio > 1) return null
    return CHART_H - PLOT_INSET - ratio * (CHART_H - PLOT_INSET * 2)
  }
  const warnY = warning < critical ? ruleY(warning) : null
  const tripY = ruleY(critical)

  /*
   * Two gates, not one, because `maxCapacityWatts` and `criticalThresholdWatts`
   * are two independent settings and the server can legitimately supply either
   * without the other.
   *
   *   hasCapacity  drives the meter's scale and the "N % of M W limit" line.
   *                Both are arithmetic against the CEILING, so
   *                a rig that reports 4400 W of capacity is entitled to see how
   *                full it is even if nobody has set a trip point. Folding
   *                `critical > 0` into this used to blank the meter entirely in
   *                exactly that case, hiding a true reading behind a missing
   *                setting.
   *   hasTripPoint drives headroom and the band colour, both of which are
   *                meaningless without a threshold to be against. With none
   *                reported, headroom prints a dash — 0 W of headroom against a
   *                ceiling of 0 is arithmetically true and operationally a lie.
   *
   * Both are false when the backend has not answered, because `max` and `critical`
   * are both 0 until it has, so an offline hero is entirely dashes. Neither ever
   * falls back to a remembered number: the reference rig's 4400 W ceiling is a
   * SETTING the Framework admin writes, and this console does not hold a copy.
   */
  const hasCapacity = max > 0
  const hasTripPoint = critical > 0
  const percent = hasCapacity ? Math.min((load / max) * 100, 100) : 0
  const headroom = critical - load
  const band = !hasTripPoint ? 'live' : load >= critical ? 'bad' : load >= warning ? 'warn' : 'live'

  const headroomText = !hasTripPoint
    ? UNAVAILABLE
    : headroom <= 0
      ? `${Math.round(Math.abs(headroom))} W over`
      : `${Math.round(headroom).toLocaleString()} W`

  return (
    <>
      <section className="mp-card hero" aria-label="Total load">
        {/* ---- Left: the figure, the meter, the two stats ---- */}
        <div className="hero-l">
          <div>
            <div className="lbl">Total load</div>
            <div className="big">
              {Math.round(load).toLocaleString()}
              <small>W</small>
            </div>
          </div>

          <div>
            <div className="meter" role="meter" aria-valuenow={hasCapacity ? Math.round(percent) : undefined} aria-valuemin={0} aria-valuemax={100} aria-label={hasCapacity ? 'Total load against the configured limit' : 'Total load; no configured limit has been reported, so there is nothing to measure this against'}>
              <i style={{ width: `${live ? percent : 0}%`, background: band === 'bad' ? 'var(--bad)' : band === 'warn' ? 'var(--warn)' : 'var(--live)' }} />
            </div>
            <div className="lbl num" style={{ marginTop: 6 }}>
              <span>{hasCapacity ? Math.round(percent) : UNAVAILABLE}</span>
              {hasCapacity ? ` % of ${Math.round(max).toLocaleString()} W limit` : ' · no limit reported'}
            </div>
          </div>

          <div className="stats">
            <div>
              <span className="lbl">Headroom</span>
              <b>{headroomText}</b>
            </div>
            <div>
              <span className="lbl">Energized</span>
              <b>{`${energized} / ${channelCount}`}</b>
            </div>
          </div>
        </div>

        {/*
          Right half. The plot and caption stay in normal flow so
          nothing can overlap anything. The previous version absolutely
          positioned the caption over the plot, which is what made the hero read
          as a stack of overlapping layers.
        */}
        <div className="hero-r">
          <div className="hero-plot">
            <svg
              viewBox={`0 0 ${CHART_W} ${CHART_H}`}
              preserveAspectRatio="none"
              aria-label="Total load, last 15 minutes"
              role="img"
            >
              {hasData ? (
                <>
                  {tripY !== null && (
                    <line x1="0" x2={CHART_W} y1={tripY} y2={tripY} stroke="var(--bad)" strokeWidth="1.2" strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
                  )}
                  {warnY !== null && (
                    <line x1="0" x2={CHART_W} y1={warnY} y2={warnY} stroke="var(--warn)" strokeWidth="1.2" strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
                  )}
                  <path d={paths.area} fill="var(--live)" opacity=".12" />
                  <path
                    d={paths.line}
                    fill="none"
                    stroke="var(--live)"
                    strokeWidth="2"
                    vectorEffect="non-scaling-stroke"
                    strokeLinejoin="round"
                  />
                </>
              ) : (
                // Offline the plot sits on an honest zero baseline instead of a
                // mid-box line: the rig reports nothing, so the trace is 0 W.
                <line x1="0" x2={CHART_W} y1={live ? CHART_H / 2 : CHART_H - PLOT_INSET} y2={live ? CHART_H / 2 : CHART_H - PLOT_INSET} stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
              )}
            </svg>
          </div>

          <div className="chart-cap">
            <span className="num">−15 min</span>
            <span className="mp-pill num" style={{ padding: '2px 9px' }}>
              <span className={`dot ${streamLive ? 'live' : 'off'}`} />
              {streamLabel}
            </span>
          </div>
        </div>
      </section>

      {/*
        OFFLINE appears only when the state endpoint actually failed, and it
        carries the way back in. Every measurement above reads as a dash in this
        state, so the console never looks live while it is not.
      */}
      {!live && (
        <div className="mp-banner" role="status">
          <span className="num" style={{ color: 'var(--mute)' }}>
            Dashboard offline. Readings and controls are unavailable.
          </span>
          <button type="button" className="mp-btn" onClick={onSignIn}>
            Sign in
          </button>
        </div>
      )}
    </>
  )
}

export { CHART_W, CHART_H, buildPath, UNAVAILABLE }
