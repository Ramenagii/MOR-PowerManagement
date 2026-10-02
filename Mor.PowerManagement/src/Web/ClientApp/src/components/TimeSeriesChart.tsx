import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import {
  formatTick,
  formatValue,
  niceDomain,
  pickTickIndices,
  roundToStep,
  toAreaPath,
  toPaths,
  type Unit,
} from '../utils/telemetry'

export type ChartSeries = {
  id: string
  label: string
  color: string
  /** SVG stroke-dasharray. A second encoding so the chart survives colour blindness. */
  dash?: string
  values: Array<number | null>
  /** Tooltip swatch glyph: measured / derived / simulated. */
  glyph?: string
  title?: string
}

type TimeSeriesChartProps = {
  series: ChartSeries[]
  timestamps: string[]
  unit: Unit
  title: string
  /** Overrides the CSS `--chart-h` when set; normally left unset. */
  height?: number
  /** Only for the single-series total chart. */
  showArea?: boolean
  formatValue?: (value: number, unit: Unit) => string
  emptyMessage?: string
}

/**
 * Hand-rolled SVG time-series primitive. ~200 lines of typed SVG so the whole
 * signal path is inspectable, with no charting dependency.
 *
 * Contract (consumed by TelemetryView — if this changes, only this file and its
 * caller change):
 * - `series[i].values` is index-aligned to `timestamps`. `null` means "no sample
 *   in this bucket" and renders as a break in the line, never a zero.
 * - Renders an empty state, never a crash, for an empty axis or all-null data.
 * - Width comes from a ResizeObserver with a 720 px default, so the first paint
 *   is never zero-width and axis labels stay at their true px size at 390 px.
 * - Height comes from the CSS custom property `--chart-h` on `.chart-wrap`, so
 *   the responsive breakpoints own it (240 px, dropping to 190 px under 420 px)
 *   rather than a JS breakpoint that would have to be kept in sync by hand.
 *   Pass `height` to override.
 */
const MARGIN = { left: 48, right: 12, top: 10, bottom: 26 }
const DEFAULT_WIDTH = 720
const DEFAULT_HEIGHT = 240
const SR_ONLY_COLUMNS = 8

export function TimeSeriesChart({
  series,
  timestamps,
  unit,
  title,
  height,
  showArea = false,
  formatValue: formatValueProp,
  emptyMessage = 'No telemetry in this window.',
}: TimeSeriesChartProps) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const [cssHeight, setCssHeight] = useState<number | null>(null)
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const prefersReducedMotion = useReducedMotion()

  useEffect(() => {
    const element = wrapperRef.current
    if (!element || typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const next = Math.max(240, Math.round(entry.contentRect.width))
      setWidth((current) => (current === next ? current : next))
    })

    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // The responsive chart height is CSS's job (§3.9), so read --chart-h back out
  // rather than hard-coding 240 and leaving the 390 px breakpoint dead. Re-read
  // on resize; the setState guard stops this feeding itself, since the svg height
  // is itself derived from the value being read.
  useEffect(() => {
    const element = wrapperRef.current
    if (!element) return

    const read = () => {
      const parsed = Number.parseFloat(
        getComputedStyle(element).getPropertyValue('--chart-h'),
      )
      setCssHeight(Number.isFinite(parsed) && parsed > 0 ? parsed : null)
    }

    read()
    window.addEventListener('resize', read)
    return () => window.removeEventListener('resize', read)
  }, [])

  const resolvedHeight = height ?? cssHeight ?? DEFAULT_HEIGHT

  const plotWidth = Math.max(1, width - MARGIN.left - MARGIN.right)
  const plotHeight = Math.max(1, resolvedHeight - MARGIN.top - MARGIN.bottom)
  const count = timestamps.length

  // Domain spans every visible series so the four charts share a vertical frame.
  const domain = useMemo(() => {
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY

    for (const entry of series) {
      for (const value of entry.values) {
        if (value === null || !Number.isFinite(value)) continue
        if (value < min) min = value
        if (value > max) max = value
      }
    }

    if (!Number.isFinite(min) || !Number.isFinite(max)) return null
    return niceDomain(min, max)
  }, [series])

  const hasData = count > 0 && domain !== null

  const xScale = (i: number) => (count <= 1 ? MARGIN.left + plotWidth / 2 : MARGIN.left + (i / (count - 1)) * plotWidth)
  const yScale = (value: number) => {
    if (!domain) return MARGIN.top + plotHeight / 2
    const span = domain.max - domain.min || 1
    return MARGIN.top + (1 - (value - domain.min) / span) * plotHeight
  }

  const visible = hoverIndex !== null && hoverIndex >= 0 && hoverIndex < count ? hoverIndex : null
  const valueFormatter = formatValueProp ?? formatValue

  const handlePointer = (event: React.PointerEvent<SVGSVGElement>) => {
    if (count === 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    if (plotWidth <= 0) return
    const ratio = (event.clientX - rect.left - MARGIN.left) / plotWidth
    const index = Math.round(ratio * (count - 1))
    setHoverIndex(Math.min(Math.max(index, 0), count - 1))
  }

  const tooltipOnRight = visible !== null && xScale(visible) > width * 0.6
  const xTickIndices = pickTickIndices(count, 5)
  const yTicks = useMemo(() => {
    if (!domain || domain.step <= 0) return []
    const ticks: number[] = []
    // Cap the tick count so a 0.05 step on a flat nominal rail cannot flood the axis.
    for (let value = domain.min, guard = 0; value <= domain.max + domain.step / 2 && guard < 12; value += domain.step, guard += 1) {
      ticks.push(value)
    }
    return ticks
  }, [domain])

  const empty = !hasData

  return (
    <motion.figure
      className="chart-figure"
      initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
      aria-label={title}
    >
      <figcaption>
        {title}
        <span className="chart-unit">{unit}</span>
      </figcaption>

      <div className="chart-wrap" ref={wrapperRef}>
        {empty ? (
          <div className="chart-empty" style={{ height: resolvedHeight }}>
            <p>{emptyMessage}</p>
          </div>
        ) : (
          <>
            <svg
              width={width}
              height={resolvedHeight}
              viewBox={`0 0 ${width} ${resolvedHeight}`}
              role="img"
              aria-label={`${title}. ${series.length} series, ${timestamps.length} points from ${timestamps[0] ?? ''} to ${timestamps[count - 1] ?? ''}.`}
              onPointerMove={handlePointer}
              onPointerLeave={() => setHoverIndex(null)}
            >
              {/* Horizontal hairlines + y tick labels. */}
              {yTicks.map((tick) => (
                <g key={`y-${tick}`}>
                  <line
                    x1={MARGIN.left}
                    x2={MARGIN.left + plotWidth}
                    y1={yScale(tick)}
                    y2={yScale(tick)}
                    stroke="var(--border)"
                    strokeWidth={1}
                  />
                  <text
                    x={MARGIN.left - 8}
                    y={yScale(tick) + 3}
                    textAnchor="end"
                    fontSize={10}
                    fill="var(--faint)"
                    fontFamily="var(--mono)"
                  >
                    {formatTick(roundToStep(tick, domain!.step), unit)}
                  </text>
                </g>
              ))}

              {/* X tick labels. */}
              {xTickIndices.map((i) => (
                <text
                  key={`x-${i}`}
                  x={xScale(i)}
                  y={resolvedHeight - 8}
                  textAnchor={i === 0 ? 'start' : i === count - 1 ? 'end' : 'middle'}
                  fontSize={10}
                  fill="var(--muted)"
                  fontFamily="var(--mono)"
                >
                  {formatBucketLabel(timestamps[i], windowSpanMs(timestamps))}
                </text>
              ))}

              {/* Area fill, single-series total chart only. */}
              {showArea &&
                series.map((entry) => (
                  <g key={`area-${entry.id}`}>
                    {toAreaPath(entry.values, xScale, yScale, MARGIN.top + plotHeight).map((path, index) => (
                      <path key={index} d={path} fill={entry.color} fillOpacity={0.12} stroke="none" />
                    ))}
                  </g>
                ))}

              {/* One path per contiguous non-null run, so gaps render as breaks. */}
              {series.map((entry) => (
                <g key={`line-${entry.id}`}>
                  {toPaths(entry.values, xScale, yScale).map((path, index) => (
                    <path
                      key={index}
                      d={path}
                      fill="none"
                      stroke={entry.color}
                      strokeWidth={series.length > 4 ? 1.25 : 1.75}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                      strokeDasharray={entry.dash || undefined}
                    />
                  ))}
                </g>
              ))}

              {/* Crosshair. */}
              {visible !== null && (
                <line
                  x1={xScale(visible)}
                  x2={xScale(visible)}
                  y1={MARGIN.top}
                  y2={MARGIN.top + plotHeight}
                  stroke="var(--border-strong)"
                  strokeWidth={1}
                />
              )}
            </svg>

            {visible !== null && (
              <div className={`chart-tooltip ${tooltipOnRight ? 'flip' : ''}`} role="status">
                <p className="chart-tooltip-time">
                  {formatBucketLong(timestamps[visible], windowSpanMs(timestamps))}
                </p>
                <dl>
                  {series.map((entry) => (
                    <div key={`tt-${entry.id}`}>
                      <dt>
                        <span className="legend-swatch" style={{ background: entry.color }} aria-hidden="true" />
                        {entry.glyph ? `${entry.glyph} ` : ''}
                        {entry.label}
                      </dt>
                      <dd>
                        {entry.values[visible] === null || entry.values[visible] === undefined
                          ? '—'
                          : `${valueFormatter(entry.values[visible] as number, unit)} ${unit}`}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
          </>
        )}
      </div>

      {/* Screen-reader story: the numbers, reachable without reading the pixels.
          Visually hidden (clip, not display:none) and bounded to the last
          SR_ONLY_COLUMNS buckets so the DOM stays small. */}
      {!empty && (
        <table className="sr-only">
          <caption>{`${title} — last ${Math.min(SR_ONLY_COLUMNS, count)} buckets`}</caption>
          <thead>
            <tr>
              <th scope="col">Series</th>
              {timestamps.slice(-SR_ONLY_COLUMNS).map((stamp) => (
                <th scope="col" key={stamp}>
                  {formatBucketLong(stamp, windowSpanMs(timestamps))}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {series.map((entry) => (
              <tr key={`sr-${entry.id}`}>
                <th scope="row">
                  {entry.label}
                  {entry.title ? ` — ${entry.title}` : ''}
                </th>
                {entry.values.slice(-SR_ONLY_COLUMNS).map((value, i) => (
                  <td key={i}>{value === null || value === undefined ? 'no sample' : `${valueFormatter(value, unit)} ${unit}`}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </motion.figure>
  )
}

/** How wide the visible window is, so the x labels pick an appropriate format. */
function windowSpanMs(timestamps: string[]): number {
  if (timestamps.length < 2) return 0
  return Date.parse(timestamps[timestamps.length - 1]) - Date.parse(timestamps[0])
}

function formatBucketLabel(stamp: string | undefined, spanMs: number): string {
  if (!stamp) return ''
  const date = new Date(stamp)
  if (Number.isNaN(date.getTime())) return ''
  // Past a day the clock time alone is ambiguous, so include the date.
  return spanMs > 24 * 60 * 60 * 1000
    ? date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatBucketLong(stamp: string | undefined, spanMs: number): string {
  if (!stamp) return '—'
  const date = new Date(stamp)
  if (Number.isNaN(date.getTime())) return '—'
  return spanMs > 24 * 60 * 60 * 1000
    ? date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
