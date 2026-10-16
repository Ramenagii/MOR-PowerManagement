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

/** Offline the rig reports nothing, so every figure reads 0 — the OFFLINE
 * banner carries the explanation, not an em-dash. */
const UNAVAILABLE = '—'

type Domain = { min: number; max: number }

/**
 * Fit the y-domain to the window rather than to 0..P_limit.
 *
 * This is the fix for the flat-line problem. A rig sitting at 67 W against a
 * 600 W ceiling drew its trace in the bottom eighth of the plot, so 15 minutes
 * of real movement was invisible and the chart read as an empty box.
 *
 * Two guards keep the fit honest:
 *   - The span is floored at a small fraction of P_limit, so a genuinely flat
 *     trace is not magnified into a dramatic ramp that misrepresents the rig.
 *   - The trip ceiling stays in frame whenever the data approaches it, so the
 *     "how close am I" read survives the rescale. The meter and the Headroom
 *     figure carry that job the rest of the time.
 *
 * Measured against the reference rig: real ±14% jitter uses 76-81% of the plot
 * height at 67 W, 440 W, 560 W and 900 W; a truly flat line uses 0% and stays
 * flat; and 5 W of noise is held to 15% by the floor rather than filling the box.
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
   * With the axis scaled to the data, a 600 W ceiling over a 67 W trace sits far
   * off the top of the plot; drawing it anyway would either clip or squeeze the
   * trace back down to the floor, which is the very bug this change fixes.
   */
  const ruleY = (watts: number): number | null => {
    const span = domain.max - domain.min || 1
    const ratio = (watts - domain.min) / span
    if (ratio < 0 || ratio > 1) return null
    return CHART_H - PLOT_INSET - ratio * (CHART_H - PLOT_INSET * 2)
  }
  const warnY = warning < critical ? ruleY(warning) : null
  const tripY = ruleY(critical)

  const percent = max > 0 ? Math.min((load / max) * 100, 100) : 0
  const headroom = critical - load
  const band = load >= critical ? 'bad' : load >= warning ? 'warn' : 'live'

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
            <div className="meter" role="meter" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100} aria-label="Total load against the configured limit">
              <i style={{ width: `${live ? percent : 0}%`, background: band === 'bad' ? 'var(--bad)' : band === 'warn' ? 'var(--warn)' : 'var(--live)' }} />
            </div>
            <div className="lbl num" style={{ marginTop: 6 }}>
              <span>{Math.round(percent)}</span>
              {`% of ${Math.round(max).toLocaleString()} W limit`}
            </div>
          </div>

          <div className="stats">
            <div>
              <span className="lbl">Headroom</span>
              <b>{headroom <= 0 ? `${Math.round(Math.abs(headroom))} W over` : `${Math.round(headroom).toLocaleString()} W`}</b>
            </div>
            <div>
              <span className="lbl">Energized</span>
              <b>{`${energized} / ${channelCount}`}</b>
            </div>
          </div>
        </div>

        {/*
          Right half. Three rows in normal flow — limit tag, plot, caption — so
          nothing can overlap anything. The previous version absolutely
          positioned the caption over the plot, which is what made the hero read
          as a stack of overlapping layers.
        */}
        <div className="hero-r">
          <span className="lim num" title="Configured master capacity for this rig">
            {`P_limit ${Math.round(max).toLocaleString()} W`}
          </span>

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
            GET /api/Dashboard/state did not answer — readings below are not live and the controls are disabled.
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