import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  CircleCheckBig,
  ClipboardList,
  Database,
  FlaskConical,
  Info,
  Play,
  Power,
  Radio,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Timer,
  TriangleAlert,
  Waves,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import {
  ApiError,
  fetchDashboardState,
  fetchTelemetrySeries,
  type DashboardSnapshot,
  type TelemetrySeries,
} from '../api'
import {
  backoffMs,
  niceDomain,
  pickTickIndices,
  seriesStats,
  toAreaPath,
  toPaths,
} from '../utils/telemetry'

export type ScenarioNotice = {
  /**
   * live      - the batch was stored and the policy engine answered
   * simulated - the backend was unreachable, so nothing was written
   * error     - the write was attempted and rejected
   */
  tone: 'live' | 'simulated' | 'error'
  text: string
}

type ScenarioPanelProps = {
  onNormal: () => void
  onActivate: () => void
  onBlock: () => void
  onOverload: () => void
  onSelective: () => void
  onIdle: () => void
  notice: ScenarioNotice | null
  busy: boolean
}

/**
 * Scenario Simulator & HIL Validation.
 *
 * Five of the six vectors post a real telemetry batch to
 * POST /api/Dashboard/scenarios/ingest; the sixth (activation) posts to
 * POST /api/Dashboard/outlets/{id}/activation. The server stores the rows,
 * refreshes outlet state and evaluates its own policy engine, so every event
 * shown here is the engine's output and the trace below moves in step with the
 * control action rather than being animated alongside it.
 *
 * The honesty rules this file is built around:
 * - `notice` is rendered verbatim. It is never reworded, prettified or
 *   supplemented with a friendlier summary than the backend produced.
 * - The run log is append-only and is constructed *only* from `notice`
 *   transitions (plus a dispatch marker when a request goes in flight and one
 *   "no runs yet" line at session start). No entry is ever invented, and a
 *   failed or unreachable run is logged exactly as it came back.
 * - Everything in the connection banner is a value this browser actually
 *   measured: the round-trip time is timed around the telemetry request, and
 *   the counts come from the response body.
 * - The mockup's free-form JSON injector is deliberately absent. There is no
 *   client-callable endpoint for POST /api/Device/telemetry (it is gated on
 *   the device shared secret, which the SPA must never hold), so instead of a
 *   text box that would fake a 200, the injector offers the six vectors that
 *   do have real endpoints.
 */

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Matches POLL_INTERVAL_MS['15m'] so the trace here and the Telemetry view agree. */
const TRACE_POLL_MS = 10_000
/** Thresholds change only from the admin console, so they are polled slowly. */
const STATE_POLL_MS = 30_000
/** Consecutive misses before the trace is declared stale rather than merely delayed. */
const STALE_AFTER_ATTEMPTS = 3
/** Terminal scrollback. Older lines are dropped off the top, never rewritten. */
const LOG_LIMIT = 60

const TRACE_HEIGHT = 188
const TRACE_MARGIN = { left: 52, right: 16, top: 16, bottom: 26 }
const DEFAULT_TRACE_WIDTH = 520

type DispatchMode = 'injection' | 'readonly'

type VectorSpec = {
  id: string
  name: string
  /** What this vector physically does to the rig, in the terms the builder uses. */
  intent: string
  /** The honest expectation — a claim about the engine, never a promised number. */
  expectation: string
  /** The endpoint this vector really hits. */
  endpoint: string
  icon: LucideIcon
  /** Plain descriptor. Metadata, so it is neutral text — never a coloured pill. */
  label: string
  /**
   * Status dot, and only where the vector actually drives the rig into one of
   * the three states the palette reserves colour for. Vectors that merely
   * describe a mechanism (capacity gate, priority order, standby) carry no
   * dot at all, because a coloured dot there would invent a severity.
   */
  severityDot?: string
  buttonClass: string
  run: () => void
}

type LogEntry = {
  id: number
  /** Wall clock at which this browser observed the event. */
  at: Date
  tag: string
  text: string
  tone: 'live' | 'simulated' | 'error' | 'dispatch'
}

/**
 * Colour discipline for this file: amber means the device answered but nothing
 * was written, red means the write was rejected, and "the batch is on the
 * server" — the success case — is a quiet neutral rather than a green chip.
 * Green is not a state colour in this console, and a run that succeeded is not
 * more interesting than a run that did not. The stored result still reads as
 * success because the tag says STORED and the rail is drawn beside it.
 */
const TAG_TONE: Record<ScenarioNotice['tone'], { tag: string; chip: string }> = {
  live: { tag: 'STORED', chip: 'text-on-surface-variant' },
  simulated: { tag: 'NO WRITE', chip: 'text-tertiary' },
  error: { tag: 'REJECTED', chip: 'text-error' },
}

/**
 * The last-result block carries a single 4px status rail rather than a filled
 * coloured card. The outcome is still unmissable — it is the one place a write
 * result is announced — but it no longer floods the panel with tone.
 */
const NOTICE_RAIL: Record<ScenarioNotice['tone'], string> = {
  live: 'border-l-outline-variant',
  simulated: 'border-l-tertiary',
  error: 'border-l-error',
}

const LOG_CHIP: Record<LogEntry['tone'], string> = {
  live: 'text-on-surface-variant',
  simulated: 'text-tertiary',
  error: 'text-error',
  dispatch: 'text-outline',
}

/**
 * One declaration for every axis label in the inline trace.
 *
 * SVG <text> has no Tailwind size utility that survives the viewBox coordinate
 * system, and TimeSeriesChart.tsx — which this trace deliberately matches — sets
 * the same 10px/--mono pair for its ticks. Naming it once keeps the exception to
 * a single documented line instead of four scattered attributes, and keeps the
 * two charts pixel-identical on the same axis.
 */
const AXIS_LABEL = {
  fontSize: 10,
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
} as const

let logSequence = 0

function nextLogId(): number {
  logSequence += 1
  return logSequence
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** "14:22:01.002" — the terminal's own clock, never a server-supplied one. */
function clockStamp(at: Date): string {
  const time = [at.getHours(), at.getMinutes(), at.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')
  return `${time}.${String(at.getMilliseconds()).padStart(3, '0')}`
}

function clockOnly(at: Date): string {
  return [at.getHours(), at.getMinutes(), at.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')
}

/** Whole watts, thousands-separated. Nulls stay null — a gap is not a zero. */
function wattsOrDash(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : Math.round(value).toLocaleString()
}

function roundTrip(durationMs: number | null): string {
  return durationMs === null ? '—' : `${durationMs.toFixed(1)} ms`
}

function percent(value: number): string {
  return `${value.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
}

// ---------------------------------------------------------------------------
// Live trace
// ---------------------------------------------------------------------------

type TraceProps = {
  series: TelemetrySeries | null
  warningWatts: number | null
  criticalWatts: number | null
  hasError: boolean
  loading: boolean
}

/**
 * Total-load trace for the 15 m window, with the configured warning and
 * critical thresholds drawn as real lines at whatever value the server
 * returned — there is no compiled-in wattage anywhere in this file.
 *
 * The pulsing ring on the newest bucket is an emphasis affordance copied from
 * the mockup, not a reading; it is labelled as such on screen so nobody reads
 * it as a measurement the device did not make.
 */
function LoadTrace({ series, warningWatts, criticalWatts, hasError, loading }: TraceProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(DEFAULT_TRACE_WIDTH)

  useEffect(() => {
    const element = wrapRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const next = Math.max(280, Math.round(entry.contentRect.width))
      setWidth((current) => (current === next ? current : next))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const values = series?.totals.watts ?? []
  const timestamps = series?.timestamps ?? []
  const count = timestamps.length
  const plotWidth = Math.max(1, width - TRACE_MARGIN.left - TRACE_MARGIN.right)
  const plotHeight = Math.max(1, TRACE_HEIGHT - TRACE_MARGIN.top - TRACE_MARGIN.bottom)

  // The thresholds join the domain so their lines are always on screen. Without
  // a trace the domain is the thresholds alone, which still renders as two
  // labelled rules rather than an empty axis that could read as a zero load.
  const domain = useMemo(() => {
    const candidates: number[] = []
    for (const value of values) {
      if (value === null || !Number.isFinite(value)) continue
      candidates.push(value)
    }
    if (warningWatts !== null) candidates.push(warningWatts)
    if (criticalWatts !== null) candidates.push(criticalWatts)
    if (candidates.length === 0) return null
    return niceDomain(Math.min(...candidates), Math.max(...candidates), 4)
  }, [values, warningWatts, criticalWatts])

  const stats = useMemo(() => seriesStats(values), [values])
  const lastIndex = useMemo(() => {
    for (let i = values.length - 1; i >= 0; i -= 1) {
      const value = values[i]
      if (value !== null && Number.isFinite(value)) return i
    }
    return null
  }, [values])

  const xScale = (i: number) =>
    count <= 1 ? TRACE_MARGIN.left + plotWidth / 2 : TRACE_MARGIN.left + (i / (count - 1)) * plotWidth
  const yScale = (value: number) => {
    if (!domain) return TRACE_MARGIN.top + plotHeight / 2
    const span = domain.max - domain.min || 1
    return TRACE_MARGIN.top + (1 - (value - domain.min) / span) * plotHeight
  }

  const tickIndices = pickTickIndices(count, 4)
  const yTicks = useMemo(() => {
    if (!domain || domain.step <= 0) return []
    const ticks: number[] = []
    for (let v = domain.min, guard = 0; v <= domain.max + domain.step / 2 && guard < 12; v += domain.step, guard += 1) {
      ticks.push(Number(v.toFixed(2)))
    }
    return ticks
  }, [domain])

  const hasTrace = count > 0 && domain !== null && stats.last !== null

  return (
    <div ref={wrapRef} className="w-full">
      {!hasTrace ? (
        <div className="flex h-[188px] flex-col items-start justify-center gap-space-sm rounded-md bg-surface-container-low p-space-md">
          <div className="flex items-center gap-space-sm">
            <Activity
              size={18}
              className={hasError ? 'text-error' : 'text-primary'}
              aria-hidden="true"
            />
            <p className="font-title-md text-title-md text-on-surface">
              {hasError ? 'Total-load trace unavailable' : loading ? 'Reading the 15 min window' : 'No total-load samples yet'}
            </p>
          </div>
          <p className="max-w-[64ch] font-body-sm text-body-sm text-on-surface-variant">
            {hasError
              ? 'The window request failed, so nothing is drawn. Run a vector above, or open the Telemetry view for the full polling and provenance detail.'
              : 'Nothing is plotted until the server returns a bucket. An empty axis here would read as a zero load that was never measured.'}
          </p>
        </div>
      ) : (
        <svg
          width={width}
          height={TRACE_HEIGHT}
          viewBox={`0 0 ${width} ${TRACE_HEIGHT}`}
          role="img"
          aria-label={`Total bus load over the ${series?.windowLabel ?? '15 min'} window against the configured warning and critical thresholds.`}
          className="block"
        >
          {yTicks.map((tick) => (
            <g key={`y-${tick}`}>
              <line
                x1={TRACE_MARGIN.left}
                x2={TRACE_MARGIN.left + plotWidth}
                y1={yScale(tick)}
                y2={yScale(tick)}
                stroke="#e5e2e1"
                strokeWidth={1}
              />
              <text
                x={TRACE_MARGIN.left - 8}
                y={yScale(tick) + 3}
                textAnchor="end"
                fill="#727786"
                {...AXIS_LABEL}
              >
                {Math.round(tick)}
              </text>
            </g>
          ))}

          {/* Threshold rules, drawn at the configured values. */}
          {criticalWatts !== null && domain && (
            <g>
              <line
                x1={TRACE_MARGIN.left}
                x2={TRACE_MARGIN.left + plotWidth}
                y1={yScale(criticalWatts)}
                y2={yScale(criticalWatts)}
                stroke="#ba1a1a"
                strokeWidth={1}
                strokeDasharray="5 4"
              />
              <text
                x={TRACE_MARGIN.left + 4}
                y={yScale(criticalWatts) - 5}
                fill="#ba1a1a"
                fontWeight={600}
                {...AXIS_LABEL}
              >
                CRITICAL {Math.round(criticalWatts)} W
              </text>
            </g>
          )}
          {warningWatts !== null && domain && (
            <g>
              <line
                x1={TRACE_MARGIN.left}
                x2={TRACE_MARGIN.left + plotWidth}
                y1={yScale(warningWatts)}
                y2={yScale(warningWatts)}
                stroke="#7d5400"
                strokeWidth={1}
                strokeDasharray="5 4"
              />
              <text
                x={TRACE_MARGIN.left + 4}
                y={yScale(warningWatts) + 12}
                fill="#7d5400"
                fontWeight={600}
                {...AXIS_LABEL}
              >
                WARNING {Math.round(warningWatts)} W
              </text>
            </g>
          )}

          {toAreaPath(values, xScale, yScale, TRACE_MARGIN.top + plotHeight).map((path, index) => (
            <path key={`area-${index}`} d={path} fill="#0057c2" fillOpacity={0.12} stroke="none" />
          ))}
          {toPaths(values, xScale, yScale).map((path, index) => (
            <path
              key={`line-${index}`}
              d={path}
              fill="none"
              stroke="#0057c2"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}

          {lastIndex !== null && (
            <g>
              <circle
                cx={xScale(lastIndex)}
                cy={yScale(values[lastIndex] as number)}
                r={4}
                fill="#0057c2"
                className="animate-ping motion-reduce:animate-none"
                opacity={0.55}
              />
              <circle cx={xScale(lastIndex)} cy={yScale(values[lastIndex] as number)} r={3} fill="#0057c2" />
            </g>
          )}

          {/* Timeline markers: the real bucket boundaries the server returned. */}
          {tickIndices.map((i) => (
            <g key={`x-${i}`}>
              <line
                x1={xScale(i)}
                x2={xScale(i)}
                y1={TRACE_MARGIN.top + plotHeight}
                y2={TRACE_MARGIN.top + plotHeight + 4}
                stroke="#c1c6d7"
                strokeWidth={1}
              />
              <text
                x={xScale(i)}
                y={TRACE_HEIGHT - 6}
                textAnchor={i === 0 ? 'start' : i === count - 1 ? 'end' : 'middle'}
                fill={i === lastIndex ? '#0057c2' : '#727786'}
                fontWeight={i === lastIndex ? 600 : 400}
                {...AXIS_LABEL}
              >
                {clockLabel(timestamps[i])}
              </text>
            </g>
          ))}
        </svg>
      )}
    </div>
  )
}

function clockLabel(stamp: string | undefined): string {
  if (!stamp) return '--:--:--'
  const date = new Date(stamp)
  if (Number.isNaN(date.getTime())) return '--:--:--'
  return clockOnly(date)
}

// ---------------------------------------------------------------------------
// Scenario Simulator & HIL Validation
// ---------------------------------------------------------------------------

export function ScenarioPanel({
  onNormal,
  onActivate,
  onBlock,
  onOverload,
  onSelective,
  onIdle,
  notice,
  busy,
}: ScenarioPanelProps) {
  const [mode, setMode] = useState<DispatchMode>('injection')
  const [series, setSeries] = useState<TelemetrySeries | null>(null)
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null)
  const [traceStatus, setTraceStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [traceError, setTraceError] = useState<string | null>(null)
  const [roundTripMs, setRoundTripMs] = useState<number | null>(null)
  const [failedAttempts, setFailedAttempts] = useState(0)
  const [completedRuns, setCompletedRuns] = useState(0)

  const abortRef = useRef<AbortController | null>(null)
  const failuresRef = useRef(0)
  const logRef = useRef<HTMLDivElement>(null)
  const lastNoticeRef = useRef<ScenarioNotice | null>(null)
  const busyRef = useRef(false)

  /**
   * Append-only run log. It starts with an honest "nothing has run yet" line
   * and gains exactly two kinds of entry afterwards: a dispatch marker when a
   * request goes in flight, and the notice the server returned when it comes
   * back — verbatim, whatever its tone.
   */
  const [log, setLog] = useState<LogEntry[]>(() => [
    {
      id: nextLogId(),
      at: new Date(),
      tag: 'INIT',
      text: 'Scenario console opened. No runs recorded in this session yet — run a vector below to produce the first record.',
      tone: 'dispatch',
    },
  ])

  // --- Trace polling --------------------------------------------------------

  const loadTrace = useCallback(async (isRefresh: boolean) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    if (!isRefresh) setTraceStatus('loading')

    try {
      const startedAt = performance.now()
      const payload = await fetchTelemetrySeries('15m', undefined, controller.signal)
      const elapsed = performance.now() - startedAt

      setSeries(payload)
      setRoundTripMs(elapsed)
      setTraceError(null)
      failuresRef.current = 0
      setFailedAttempts(0)
      setTraceStatus('ready')
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return

      setTraceError(
        cause instanceof ApiError && cause.status === 0
          ? 'Backend unreachable'
          : cause instanceof ApiError
            ? `Request failed: ${cause.status}`
            : String(cause),
      )
      failuresRef.current += 1
      setFailedAttempts(failuresRef.current)
      // The last good trace stays on screen through a transient miss, exactly
      // as in the Telemetry view; only the banner changes.
      setTraceStatus('error')
    }
  }, [])

  useEffect(() => {
    void loadTrace(false)

    let timer: number | undefined
    let cancelled = false

    const tick = () => {
      if (cancelled) return
      if (!document.hidden) void loadTrace(true)
      const failures = failuresRef.current
      const delay = failures > 0 ? Math.max(TRACE_POLL_MS, backoffMs(failures)) : TRACE_POLL_MS
      timer = window.setTimeout(tick, delay)
    }

    timer = window.setTimeout(tick, TRACE_POLL_MS)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
      abortRef.current?.abort()
    }
  }, [loadTrace])

  // Thresholds and device liveness come from the dashboard state, which only
  // the admin console changes — a third of the trace cadence is enough.
  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()

    const load = async () => {
      try {
        const payload = await fetchDashboardState()
        if (cancelled) return
        setSnapshot(payload)
      } catch {
        // Keep the previous thresholds rather than dropping the rules off the
        // chart; the banner keeps showing the trace's own status.
      }
    }

    void load()
    const timer = window.setInterval(() => {
      if (!document.hidden) void load()
    }, STATE_POLL_MS)

    return () => {
      cancelled = true
      controller.abort()
      window.clearInterval(timer)
    }
  }, [])

  // --- Run log --------------------------------------------------------------

  useEffect(() => {
    if (!busy) {
      busyRef.current = false
      return
    }
    if (busyRef.current) return
    busyRef.current = true
    setLog((current) => [
      ...current,
      {
        id: nextLogId(),
        at: new Date(),
        tag: 'DISPATCH',
        text: 'Telemetry batch posted to POST /api/Dashboard/scenarios/ingest. Awaiting the server response…',
        tone: 'dispatch',
      },
    ])
  }, [busy])

  useEffect(() => {
    if (!notice) return
    if (lastNoticeRef.current === notice) return
    lastNoticeRef.current = notice
    setCompletedRuns((current) => current + 1)
    setLog((current) => [
      ...current,
      {
        id: nextLogId(),
        at: new Date(),
        tag: TAG_TONE[notice.tone].tag,
        text: notice.text,
        tone: notice.tone,
      },
    ])
  }, [notice])

  // Keep the newest line in view without stealing focus.
  useEffect(() => {
    const box = logRef.current
    if (box) box.scrollTop = box.scrollHeight
  }, [log])

  const appendLine = useCallback((entry: Omit<LogEntry, 'id' | 'at'>) => {
    setLog((current) => [...current, { ...entry, id: nextLogId(), at: new Date() }])
  }, [])

  // --- Derived trace facts --------------------------------------------------

  const values = series?.totals.watts ?? []
  const traceStats = useMemo(() => seriesStats(values), [values])
  const lastWatts = traceStats.last
  const warningWatts = snapshot?.thresholds.warning ?? null
  const criticalWatts = snapshot?.thresholds.critical ?? null

  const headroom = criticalWatts !== null && lastWatts !== null ? criticalWatts - lastWatts : null
  const tripMarginPercent =
    criticalWatts !== null && criticalWatts > 0 && lastWatts !== null
      ? ((criticalWatts - lastWatts) / criticalWatts) * 100
      : null

  const loadPercent =
    criticalWatts !== null && criticalWatts > 0 && lastWatts !== null
      ? Math.min((lastWatts / criticalWatts) * 100, 100)
      : 0

  const loadTone = lastWatts === null ? 'ant-meter-fill bg-outline' : lastWatts >= (criticalWatts ?? Infinity)
    ? 'ant-meter-fill bg-error'
    : warningWatts !== null && lastWatts >= warningWatts
      ? 'ant-meter-fill bg-tertiary'
      : // Below warning is a measured load, not a health verdict, so the bar
        // wears the measurement colour (blue) rather than a green "all good".
        'ant-meter-fill bg-primary'

  // --- Vectors --------------------------------------------------------------

  const vectors = useMemo<VectorSpec[]>(
    () => [
      {
        id: 'SIM-01',
        name: 'Normal operation baseline',
        intent:
          'Replays every energized channel at the draw it is already reporting, with no injected watts and no shed channels.',
        expectation: 'The engine should store the batch and raise nothing, because no threshold is crossed.',
        endpoint: 'POST /api/Dashboard/scenarios/ingest',
        icon: CircleCheckBig,
        label: 'Nominal',
        severityDot: 'bg-outline-variant',
        buttonClass: 'ant-btn ant-btn-default',
        run: onNormal,
      },
      {
        id: 'SIM-02',
        name: 'Activation request',
        intent:
          'Sends a real activation request for the bench outlet through the outlet activation route, with no telemetry batch.',
        expectation:
          'The backend admits or denies it from its own projected-load check. If it is denied, the reason comes back in the event log.',
        endpoint: 'POST /api/Dashboard/outlets/{id}/activation',
        icon: Zap,
        label: 'Capacity gate',
        buttonClass: 'ant-btn ant-btn-primary',
        run: onActivate,
      },
      {
        id: 'SIM-03',
        name: 'Capacity block rehearsal',
        intent:
          'Drives every non-disconnected channel to 82% of its current draw, so the rig sits inside the warning band before the next activation attempt.',
        expectation:
          'A following activation request should be genuinely refused, because the load really is near the threshold.',
        endpoint: 'POST /api/Dashboard/scenarios/ingest',
        icon: ShieldCheck,
        label: 'Warning band',
        severityDot: 'ant-dot-warning',
        buttonClass: 'ant-btn ant-btn-default',
        run: onBlock,
      },
      {
        id: 'SIM-04',
        name: 'Post-activation overload',
        intent:
          'Takes every live channel to 105% of its draw and adds a 900 W injection on one channel, forcing the measured total past the critical threshold.',
        expectation:
          'The server sheds on its own terms. Which channels it drops, and what it reports as total watts, is the engine\'s answer — not this screen\'s.',
        endpoint: 'POST /api/Dashboard/scenarios/ingest',
        icon: TriangleAlert,
        label: 'Critical shed',
        severityDot: 'ant-dot-critical',
        buttonClass: 'ant-btn ant-btn-danger',
        run: onOverload,
      },
      {
        id: 'SIM-05',
        name: 'Selective response',
        intent:
          'Sheds the lowest-priority energized channel, ordered by the same Low → Critical rank the policy engine uses.',
        expectation: 'Load drops by exactly the shed channel\'s contribution. The remainder stays energized.',
        endpoint: 'POST /api/Dashboard/scenarios/ingest',
        icon: ClipboardList,
        label: 'Priority shed',
        buttonClass: 'ant-btn ant-btn-default',
        run: onSelective,
      },
      {
        id: 'SIM-06',
        name: 'Idle timeout cutoff',
        intent:
          'Reports the low-draw channels at 5% of their draw and closes their relays, so the server\'s idle timer sees a genuine low-load period.',
        expectation:
          'The idle timer runs on the server\'s own clock. This vector supplies the readings it reads; it cannot shorten the wait.',
        endpoint: 'POST /api/Dashboard/scenarios/ingest',
        icon: Power,
        label: 'Standby',
        buttonClass: 'ant-btn ant-btn-default',
        run: onIdle,
      },
    ],
    [onNormal, onActivate, onBlock, onOverload, onSelective, onIdle],
  )

  const dispatchBlocked = mode === 'readonly'
  const controlsDisabled = busy || dispatchBlocked

  const requestRun = (vector: VectorSpec) => {
    if (dispatchBlocked) {
      appendLine({
        tag: 'BLOCKED',
        text: `${vector.id} was not sent: this browser is in Hardware Read-Only mode. Switch back to Active Injection to dispatch. Nothing was posted.`,
        tone: 'dispatch',
      })
      return
    }
    vector.run()
  }

  const traceDot =
    traceStatus === 'error' ? 'ant-dot-critical' : failedAttempts > 0 ? 'ant-dot-warning' : 'bg-outline-variant'

  const traceLabel =
    traceStatus === 'error'
      ? failedAttempts >= STALE_AFTER_ATTEMPTS
        ? 'Trace stale'
        : 'Trace delayed'
      : traceStatus === 'loading'
        ? 'Connecting'
        : 'Trace live'

  return (
    <section className="mx-auto flex w-full max-w-[1440px] flex-col gap-space-lg" aria-label="Scenario simulator and HIL validation">
      {/* ---------------- Header ---------------- */}
      <header className="flex flex-col gap-space-md xl:flex-row xl:items-end xl:justify-between">
        <div className="flex flex-col gap-space-xs">
          <h1 className="font-headline-md text-headline-md text-on-surface">
            Scenario Simulator &amp; HIL Validation
          </h1>
          <p className="max-w-[76ch] font-body-md text-body-md text-on-surface-variant">
            Deterministic load-shed rehearsal against the live policy engine. Every vector below is a
            real request; the result line quotes the server back verbatim.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-space-sm">
          <div className="ant-segmented" role="group" aria-label="Dispatch mode">
            <button
              type="button"
              aria-pressed={mode === 'readonly'}
              onClick={() => setMode('readonly')}
              className={`ant-segmented-item font-body-sm ${
                mode === 'readonly'
                  ? 'ant-segmented-item-active font-semibold text-primary'
                  : 'hover:text-on-surface'
              }`}
            >
              Hardware read-only
            </button>
            <button
              type="button"
              aria-pressed={mode === 'injection'}
              onClick={() => setMode('injection')}
              className={`ant-segmented-item font-body-sm ${
                mode === 'injection'
                  ? 'ant-segmented-item-active font-semibold text-primary'
                  : 'hover:text-on-surface'
              }`}
            >
              <span
                className={`ant-dot ${mode === 'injection' ? 'bg-outline-variant animate-ping motion-reduce:animate-none' : 'bg-outline-variant'}`}
                aria-hidden="true"
              />
              Active injection
            </button>
          </div>

          <div
            className="flex h-8 items-center gap-2 rounded-lg border border-surface-container bg-surface-container-low px-2.5"
            title="Round trip measured in this browser around GET /api/Dashboard/telemetry"
          >
            <Timer size={15} className="text-outline" aria-hidden="true" />
            <span className="font-body-sm text-body-sm uppercase tracking-wide text-outline">Trace round trip</span>
            <span className="font-metric-value text-metric-value font-semibold text-on-surface">
              {roundTrip(roundTripMs)}
            </span>
          </div>

          <button
            type="button"
            className="ant-btn ant-btn-default w-8 !px-0"
            aria-label="Refresh the total-load trace now"
            onClick={() => void loadTrace(true)}
          >
            <RefreshCw size={16} aria-hidden="true" />
          </button>
        </div>
      </header>

      {/* ---------------- Honesty nameplate ---------------- */}
      <div className="flex items-start gap-space-md rounded-lg border border-outline-variant bg-surface-container-lowest p-space-md">
        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-outline-variant bg-surface-container">
          <Database size={14} className="text-outline" aria-hidden="true" />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="font-title-md text-title-md font-semibold text-on-surface">
            What these buttons actually do
          </span>
          <p className="max-w-[96ch] font-body-sm text-body-sm text-on-surface-variant">
            Five vectors post a real telemetry batch to{' '}
            <span className="font-metric-value text-metric-value">POST /api/Dashboard/scenarios/ingest</span>;
            the server persists the rows and its own policy engine raises the events, so the trace below
            moves in step with the action instead of being animated next to it. Read-only mode blocks
            dispatch in this browser only — it changes nothing server-side, and the server forces
            simulated metering mode on every batch regardless.
          </p>
        </div>
      </div>

      {/* ---------------- Two-column body ---------------- */}
      <div className="grid grid-cols-1 items-start gap-space-lg lg:grid-cols-12">
        {/* --- Left: the vectors --- */}
        <div className="flex flex-col gap-space-md lg:col-span-7">
          <article className="ant-card overflow-hidden">
            <div className="ant-card-header">
              <div className="flex items-center gap-space-sm">
                <FlaskConical size={20} className="text-primary" aria-hidden="true" />
                <div className="flex flex-col">
                  <h2 className="font-title-lg text-title-lg text-on-surface">Prescribed test vectors</h2>
                  <p className="font-body-sm text-body-sm text-on-surface-variant">
                    Deterministic load profiles built from the rig&apos;s current outlet state at
                    dispatch time.
                  </p>
                </div>
              </div>
              <span className="font-body-sm text-body-sm font-semibold uppercase tracking-wide text-on-surface-variant">
                <span className="font-metric-value text-metric-value">{vectors.length}</span> vectors
              </span>
            </div>

            <div className="ant-card-body flex flex-col gap-space-md">
              <div className="grid grid-cols-1 gap-space-md md:grid-cols-2">
                {vectors.map((vector) => {
                  const Icon = vector.icon
                  return (
                    <article
                      key={vector.id}
                      className="flex flex-col justify-between gap-space-md rounded-md border border-outline-variant bg-surface-container-low p-space-md transition-colors hover:bg-surface-container"
                    >
                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-center justify-between gap-space-sm">
                          <span className="font-metric-value text-metric-value font-semibold uppercase tracking-wide text-on-surface">
                            {vector.id}
                          </span>
                          <span className="flex items-center gap-1.5 font-body-sm text-body-sm text-on-surface-variant">
                            {vector.severityDot && (
                              <span
                                className={`ant-dot ${vector.severityDot}`}
                                aria-hidden="true"
                              />
                            )}
                            <Icon size={12} className="text-outline" aria-hidden="true" />
                            {vector.label}
                          </span>
                        </div>
                        <h3 className="font-title-md text-title-md text-on-surface">{vector.name}</h3>
                        <p className="font-body-sm text-body-sm text-on-surface-variant">{vector.intent}</p>
                        <div className="mt-1 flex flex-col gap-1 rounded bg-surface-container-lowest px-space-sm py-2">
                          <div className="flex justify-between gap-space-sm">
                            <span className="font-body-sm text-body-sm text-outline">Expects</span>
                            <span className="max-w-[26ch] text-right font-body-sm text-body-sm text-on-surface-variant">
                              {vector.expectation}
                            </span>
                          </div>
                          <div className="flex justify-between gap-space-sm">
                            <span className="font-body-sm text-body-sm text-outline">Endpoint</span>
                            <span className="font-metric-value text-metric-value text-on-surface">
                              {vector.endpoint}
                            </span>
                          </div>
                        </div>
                      </div>

                      <button
                        type="button"
                        className={`${vector.buttonClass} w-full`}
                        disabled={controlsDisabled}
                        onClick={() => requestRun(vector)}
                      >
                        <Play size={16} aria-hidden="true" />
                        {busy ? 'Vector in flight…' : `Run ${vector.id}`}
                      </button>
                    </article>
                  )
                })}
              </div>

              {dispatchBlocked && (
                <p className="flex items-start gap-space-sm rounded-md border border-tertiary-fixed-dim bg-tertiary-fixed px-space-md py-space-sm font-body-sm text-body-sm text-on-tertiary-fixed">
                  <Info size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                  <span>
                    Read-only is a client-side guard: pressing a vector records a blocked attempt in the
                    run log and sends nothing. Switch to Active injection to dispatch to the backend.
                  </span>
                </p>
              )}

              {/* --- Last result, verbatim --- */}
              <div
                className={`flex flex-col gap-space-sm rounded-md border border-l-4 bg-surface-container px-space-md py-space-sm ${
                  notice ? NOTICE_RAIL[notice.tone] : 'border-l-outline-variant'
                }`}
                role="status"
              >
                <div className="flex flex-wrap items-center gap-space-sm">
                  <span className="font-body-sm text-body-sm font-semibold uppercase tracking-wide text-on-surface-variant">
                    Last result
                  </span>
                  {busy && (
                    <span className="inline-flex items-center gap-1.5 font-body-sm text-body-sm text-on-surface-variant">
                      <span
                        className="ant-dot bg-outline animate-ping motion-reduce:animate-none"
                        aria-hidden="true"
                      />
                      In flight
                    </span>
                  )}
                  {!busy && notice && (
                    <span className="inline-flex items-center gap-1.5 font-body-sm text-body-sm text-on-surface-variant">
                      <span
                        className={`ant-dot ${
                          notice.tone === 'live'
                            ? 'bg-outline-variant'
                            : notice.tone === 'error'
                              ? 'ant-dot-critical'
                              : 'ant-dot-warning'
                        }`}
                        aria-hidden="true"
                      />
                      {notice.tone === 'live'
                        ? 'Stored on the server'
                        : notice.tone === 'error'
                          ? 'Write rejected'
                          : 'Nothing was stored'}
                    </span>
                  )}
                </div>
                <p className="font-body-md text-body-md text-on-surface">
                  {busy
                    ? 'Posting telemetry batch — the line below is replaced by the server\'s own report.'
                    : notice
                      ? notice.text
                      : 'No vector has been run in this session. The result below will quote the server\'s response verbatim — rows stored, total watts, and the rules the engine raised.'}
                </p>
              </div>
            </div>
          </article>
        </div>

        {/* --- Right: run log + live trace --- */}
        <div className="flex flex-col gap-space-lg lg:col-span-5">
          {/* Connection meta + terminal */}
          <article className="ant-card overflow-hidden">
            <div className="ant-card-header">
              <div className="flex items-center gap-space-sm">
                <Terminal size={18} className="text-primary" aria-hidden="true" />
                <h2 className="font-title-lg text-title-lg text-on-surface">Run log</h2>
              </div>
              <span className="flex items-center gap-1.5 font-body-sm text-body-sm font-semibold text-on-surface-variant">
                <span className={`ant-dot ${traceDot}`} aria-hidden="true" />
                {traceLabel}
              </span>
            </div>

            <div className="ant-card-body flex flex-col gap-space-sm">
              {/* Connection meta — every value below is measured, not assumed. */}
              <div className="flex flex-wrap items-center justify-between gap-2 rounded bg-surface-container-low px-space-md py-space-xs font-body-sm text-body-sm">
                <div className="flex items-center gap-1.5">
                  <span className={`ant-dot ${traceDot}`} aria-hidden="true" />
                  {traceStatus === 'error' ? (
                    <span className="font-medium text-on-surface">
                      {`Trace request failed${traceError ? `: ${traceError}` : ''}`}
                    </span>
                  ) : series ? (
                    <span className="font-metric-value text-metric-value font-medium text-on-surface">
                      GET /api/Dashboard/telemetry
                    </span>
                  ) : (
                    <span className="font-medium text-on-surface">Opening the 15 m window</span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-3 text-outline">
                  <span>
                    Buckets:{' '}
                    <strong className="font-metric-value text-metric-value text-on-surface">
                      {series ? `${series.bucketCount} × ${series.bucketSeconds}s` : '—'}
                    </strong>
                  </span>
                  <span>
                    Samples:{' '}
                    <strong className="font-metric-value text-metric-value text-on-surface">
                      {series ? series.rawSampleCount.toLocaleString() : '—'}
                    </strong>
                  </span>
                  <span>
                    Runs:{' '}
                    <strong className="font-metric-value text-metric-value text-on-surface">
                      {completedRuns}
                    </strong>
                  </span>
                  <span className="font-metric-value text-metric-value text-outline">
                    POST /api/Dashboard/scenarios/ingest
                  </span>
                </div>
              </div>

              {/* Terminal */}
              <div
                ref={logRef}
                role="log"
                aria-live="polite"
                aria-label="Scenario run log"
                className="h-64 space-y-1.5 overflow-y-auto rounded border border-outline-variant bg-surface-container-lowest p-space-md"
              >
                {log.map((entry) => (
                  <p key={entry.id} className="font-body-sm text-body-sm leading-tight text-outline">
                    <span className="font-metric-value text-metric-value text-on-surface-variant">
                      [{clockStamp(entry.at)}]
                    </span>{' '}
                    <span className={`font-semibold ${LOG_CHIP[entry.tone]}`}>[{entry.tag}]</span>{' '}
                    <span className="text-on-surface-variant">{entry.text}</span>
                  </p>
                ))}
                {log.length > LOG_LIMIT && (
                  <p className="font-body-sm text-body-sm text-outline">
                    … older lines scrolled out of the{' '}
                    <span className="font-metric-value text-metric-value">{LOG_LIMIT}</span>-line buffer.
                  </p>
                )}
              </div>

              {/* Quick payload injector — presets only, because only presets have endpoints. */}
              <div className="flex flex-col gap-1.5 rounded-md border border-outline-variant bg-surface-container p-space-sm">
                <div className="flex items-center justify-between">
                  <span className="font-title-md text-title-md text-on-surface">Quick payload injector</span>
                  <span className="font-metric-value text-metric-value text-outline">
                    POST /api/Dashboard/scenarios/ingest
                  </span>
                </div>
                <p className="font-body-sm text-body-sm text-on-surface-variant">
                  Each preset dispatches one of the vectors above. There is no free-form JSON field
                  here on purpose: the device telemetry route is gated on a device shared secret the
                  browser must never hold, so a typed payload could only ever have been a faked
                  success.
                </p>
                <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
                  {vectors.map((vector) => (
                    <button
                      key={`inject-${vector.id}`}
                      type="button"
                      className="ant-btn ant-btn-default justify-start px-2 font-metric-value text-metric-value"
                      disabled={controlsDisabled}
                      onClick={() => requestRun(vector)}
                    >
                      <Radio size={14} className="text-outline" aria-hidden="true" />
                      {vector.id}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </article>

          {/* Live trace */}
          <article className="ant-card overflow-hidden">
            <div className="ant-card-header">
              <div className="flex items-center gap-space-sm">
                <Waves size={18} className="text-primary" aria-hidden="true" />
                <h2 className="font-title-lg text-title-lg text-on-surface">Bus load response</h2>
              </div>
              <span className="font-metric-value text-metric-value font-medium text-outline">
                {series ? `${series.windowLabel} @ ${series.bucketSeconds}s buckets` : 'Window 15m'}
              </span>
            </div>

            <div className="ant-card-body flex flex-col gap-space-md">
              <p className="font-body-sm text-body-sm text-on-surface-variant">
                Total bus load from the same Postgres rollups the policy engine reads, against the
                thresholds the dashboard is currently configured with. Metering mode reported by the
                device:{' '}
                <span className="font-body-sm text-body-sm text-on-surface">
                  {series?.meteringMode ?? 'unknown'}
                </span>
              </p>

              <LoadTrace
                series={series}
                warningWatts={warningWatts}
                criticalWatts={criticalWatts}
                hasError={traceStatus === 'error'}
                loading={traceStatus === 'loading'}
              />

              <p className="font-body-sm text-body-sm text-on-surface-variant">
                <span className="font-semibold text-on-surface">On the pulsing ring:</span> it marks the
                newest non-empty bucket so the live edge is findable. It is an emphasis affordance, not
                an extra measurement — the value at that point is the bucket above it.
              </p>

              {/* Telemetry summary bar. The newest bucket is the one hero figure
                  on this view — it is the number the operator is waiting for —
                  so it is the only metric-display here; headroom and trip margin
                  are peer readings at metric-value. */}
              <div className="grid grid-cols-1 gap-space-sm sm:grid-cols-3">
                <div className="flex flex-col gap-0.5 rounded bg-surface-container-low px-space-sm py-2">
                  <span className="font-body-sm text-body-sm uppercase tracking-wide text-outline">
                    Newest bucket
                  </span>
                  <span className="font-metric-display text-metric-display font-semibold text-on-surface">
                    {wattsOrDash(lastWatts)} W
                  </span>
                </div>
                <div className="flex flex-col gap-0.5 rounded bg-surface-container-low px-space-sm py-2">
                  <span className="font-body-sm text-body-sm uppercase tracking-wide text-outline">
                    Headroom to critical
                  </span>
                  <span
                    className={`font-metric-value text-metric-value font-semibold ${
                      headroom === null
                        ? 'text-on-surface'
                        : headroom <= 0
                          ? 'text-error'
                          : warningWatts !== null && headroom <= criticalWatts! - warningWatts
                            ? 'text-tertiary'
                            : 'text-on-surface-variant'
                    }`}
                  >
                    {headroom === null
                      ? '—'
                      : headroom <= 0
                        ? `${Math.abs(Math.round(headroom))} W over`
                        : `${Math.round(headroom).toLocaleString()} W`}
                  </span>
                </div>
                <div className="flex flex-col gap-0.5 rounded bg-surface-container-low px-space-sm py-2">
                  <span className="font-body-sm text-body-sm uppercase tracking-wide text-outline">Trip margin</span>
                  <span
                    className={`font-metric-value text-metric-value font-semibold ${
                      tripMarginPercent === null ? 'text-on-surface' : tripMarginPercent <= 0 ? 'text-error' : 'text-on-surface'
                    }`}
                  >
                    {tripMarginPercent === null ? '—' : percent(tripMarginPercent)}
                  </span>
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between font-metric-value text-metric-value text-outline">
                  <span>
                    Peak {wattsOrDash(traceStats.max)} W · low {wattsOrDash(traceStats.min)} W over{' '}
                    {series?.windowLabel ?? 'the window'}
                  </span>
                  <span>{criticalWatts === null ? 'Thresholds not loaded' : `Critical ${criticalWatts} W`}</span>
                </div>
                <div className="ant-meter" role="img" aria-label={`Newest bucket at ${loadPercent.toFixed(1)} percent of the critical threshold`}>
                  <div className={loadTone} style={{ width: `${loadPercent}%` }} />
                </div>
              </div>
            </div>
          </article>
        </div>
      </div>
    </section>
  )
}