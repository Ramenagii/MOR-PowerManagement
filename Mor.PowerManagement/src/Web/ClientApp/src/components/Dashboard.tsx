import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CloudOff, History, X } from 'lucide-react'
import { fetchTelemetrySeries, type TelemetrySeries } from '../api'
import { EventLogPanel } from './EventLogPanel'
import { DashboardOutlet } from './DashboardOutlet'
import { DashboardMotion } from './DashboardMotion'
import { DashboardRail } from './DashboardRail'
import { DashboardSimRail } from './DashboardSimRail'
import {
  BAND_LABEL,
  CRITICAL_THRESHOLD,
  DASHBOARD_TIPS,
  MAX_CAPACITY,
  RIG_CHANNEL_COUNT,
  WARNING_THRESHOLD,
  loadBand,
} from '../data/dashboard'
import { HISTORY_SPAN_SECONDS, POLL_INTERVAL_MS } from '../data/telemetry'
import type { EventLog, Outlet } from '../types/dashboard'
import { isEnergizedOutlet, totalLoad } from '../utils/dashboard'
import { backoffMs, stalenessState } from '../utils/telemetry'
import type { ScenarioNotice } from './ScenarioPanel'

type ScenarioHandlers = {
  onNormal: () => void
  onActivate: () => void
  onBlock: () => void
  onOverload: () => void
  onSelective: () => void
  onIdle: () => void
  notice: ScenarioNotice | null
  busy: boolean
}

export type DashboardProps = {
  outlets: Outlet[]
  thresholds: { max: number; warning: number; critical: number }
  events: EventLog[]
  deviceOnline: boolean
  backendOnline: boolean
  scenario: ScenarioHandlers
  onToggleOutlet: (id: number) => void
  /** Returns the shell to the login gate; used by the OFFLINE banner. */
  onSignIn: () => void
}

type VectorKey =
  | 'onNormal'
  | 'onActivate'
  | 'onBlock'
  | 'onOverload'
  | 'onSelective'
  | 'onIdle'

/** SIM-xx → the scenario handler in App.tsx that dispatches it. */
const VECTOR_DISPATCH: Record<string, VectorKey> = {
  'SIM-01': 'onNormal',
  'SIM-02': 'onActivate',
  'SIM-03': 'onBlock',
  'SIM-04': 'onOverload',
  'SIM-05': 'onSelective',
  'SIM-06': 'onIdle',
}

/**
 * The visual-first console.
 *
 * Layout rule for this file: a panel states numbers, and anything that needs a
 * sentence goes behind a title attribute. The rig is read from across a room,
 * so prose on screen is a cost, not a courtesy — but it is never deleted, only
 * moved, so the methodology is still one hover away.
 */
export function Dashboard({
  outlets,
  thresholds,
  events,
  deviceOnline,
  backendOnline,
  scenario,
  onToggleOutlet,
  onSignIn,
}: DashboardProps) {
  const [series, setSeries] = useState<TelemetrySeries | null>(null)
  const [traceStatus, setTraceStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [eventsOpen, setEventsOpen] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const failuresRef = useRef(0)
  const requestSeqRef = useRef(0)

  // --- Telemetry loop -------------------------------------------------------
  //
  // The 15 m window backs both the rail and the per-channel strips. Cadence is
  // POLL_INTERVAL_MS['15m'], the same value the Telemetry view polls on, so the
  // two views cannot disagree about what "now" means.
  //
  // This replaced the scenario panel's own trace loop rather than joining it —
  // there is exactly one telemetry poll in this tree, because two loops on a
  // host that sleeps doubles the cold-start cost for no extra freshness.
  const loadTrace = useCallback(async (isRefresh: boolean) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const seq = ++requestSeqRef.current

    if (!isRefresh) setTraceStatus('loading')

    try {
      const payload = await fetchTelemetrySeries('15m', undefined, controller.signal)
      // A superseded request must never overwrite the current one.
      if (seq !== requestSeqRef.current) return

      setSeries(payload)
      failuresRef.current = 0
      setTraceStatus('ready')
    } catch (cause) {
      if (seq !== requestSeqRef.current) return
      if (cause instanceof DOMException && cause.name === 'AbortError') return

      failuresRef.current += 1
      // The last good history stays on screen through a miss, exactly as in the
      // Telemetry view. Only the banner changes.
      setTraceStatus('error')
    }
  }, [])

  useEffect(() => {
    void loadTrace(false)

    let timer: number | undefined
    let cancelled = false

    const tick = () => {
      if (cancelled) return
      // Paused, not abandoned: keep the schedule but skip the request so a
      // hidden tab never spends the host's cold-start budget.
      if (!document.hidden) void loadTrace(true)

      const failures = failuresRef.current
      const base = POLL_INTERVAL_MS['15m'] ?? 5_000
      const delay = failures > 0 ? Math.max(base, backoffMs(failures)) : base
      timer = window.setTimeout(tick, delay)
    }

    timer = window.setTimeout(tick, POLL_INTERVAL_MS['15m'] ?? 5_000)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
      abortRef.current?.abort()
    }
  }, [loadTrace])

  // --- Derived facts --------------------------------------------------------

  const load = useMemo(() => totalLoad(outlets), [outlets])
  const band = useMemo(
    () => loadBand(load, thresholds.warning, thresholds.critical),
    [load, thresholds.warning, thresholds.critical],
  )
  const energizedCount = useMemo(
    () => outlets.filter((outlet) => isEnergizedOutlet(outlet.status)).length,
    [outlets],
  )

  const bucketSeconds = series?.bucketSeconds ?? 0

  /*
   * `live` is the single honesty switch for this view.
   *
   * The rig baseline in `data/dashboard.ts` is a fixture — it seeds the pre-login
   * paint and the unit tests, and the backend replaces it within a second. It is
   * never displayed: while the backend has not answered, every measurement is an
   * em dash and every write control is disabled, because a 260 W figure the
   * firmware never reported is a mock. A real 0 W still renders as 0, because
   * that one IS a reading.
   */
  const live = backendOnline

  /*
   * Liveness is derived from the poll, not hardcoded. `streamLive` means the
   * last telemetry poll succeeded; `stale` additionally covers "we are waiting on
   * the very first one", so the marker never pulses over data it does not have.
   */
  const streamLive = traceStatus === 'ready'
  const stale = traceStatus !== 'ready'

  // Drives the relative-time label only. It never triggers a refetch, so the
  // 15 m window is not re-pulled once a second just to age a string.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const deviceHasSamples = (series?.channels ?? []).some((channel) => channel.sampleCount > 0)
  const streamLabel = stalenessState(series?.latestSampleAt ?? null, now, deviceOnline && deviceHasSamples).label

  /*
   * One atomic live region for the whole dashboard, and it fires only on a BAND
   * CHANGE — never on every sample.
   *
   * At 1 Hz, a per-card aria-live region would announce a number every second
   * and make the console unusable with a screen reader. The guidance is to
   * announce a meaningful contextual status, not a bare number, and to have one
   * region rather than several competing ones. A band transition is exactly
   * that: it is the one change an operator must not miss, and it is rare.
   */
  const [announcement, setAnnouncement] = useState('')
  const previousBand = useRef(band)
  useEffect(() => {
    if (!live) return
    if (previousBand.current === band) return
    previousBand.current = band
    setAnnouncement(
      `System band is now ${BAND_LABEL[band]}. Total load ${Math.round(load).toLocaleString()} watts of ${thresholds.max} watts.`,
    )
  }, [band, live, load, thresholds.max])

  const historyFor = useCallback(
    (outletId: number): Array<number | null> => {
      const channel = series?.channels.find((entry) => entry.outletId === outletId)
      if (!channel || bucketSeconds <= 0 || channel.watts.length === 0) return []

      const needed = Math.ceil(HISTORY_SPAN_SECONDS / bucketSeconds)
      const take = Math.min(channel.watts.length, Math.max(2, needed))
      return channel.watts.slice(-take)
    },
    [series, bucketSeconds],
  )

  const runVector = (id: string) => {
    const key = VECTOR_DISPATCH[id]
    if (key) scenario[key]()
  }

  // --- Render ---------------------------------------------------------------

  return (
    <div className="flex flex-col gap-space-lg">
      <DashboardMotion />

      {/*
        Single atomic status region. Visually hidden because this console has no
        room for a sentence, but present so a band change is announced rather
        than only being drawn.
      */}
      <span role="status" aria-atomic="true" className="sr-only">
        {announcement}
      </span>
      {/*
          Instrument header.

          Deliberately reduced to transport controls. The reference console's
          order is: nav, total load, then Headroom / Energized / P_limit, then
          the rail. Channel count, P_limit and the energized tally all live in
          that trio and in the channel cards directly below, so repeating them
          here would state the same fact three times in one screen. What stays is
          what this row alone owns: whether the console is talking to the backend,
          and the way to the event log.
        */}
        <header className="flex flex-wrap items-center justify-between gap-x-space-lg gap-y-2">
          <span
            className="flex items-center gap-1.5 font-metric-value text-metric-value text-outline"
            title={
              backendOnline
                ? 'GET /api/Dashboard/state answered'
                : 'GET /api/Dashboard/state did not answer'
            }
          >
            <span
              className={`ant-dot shrink-0 ${backendOnline ? 'bg-outline-variant' : 'ant-dot-warning'}`}
              aria-hidden="true"
            />
            <span className="whitespace-nowrap">
              {backendOnline ? (deviceOnline ? 'ESP32 ONLINE' : 'ESP32 DOWN') : 'BACKEND DOWN'}
            </span>
          </span>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="ant-btn ant-btn-default w-8 !px-0"
              aria-expanded={eventsOpen}
              aria-label={eventsOpen ? 'Hide policy events' : 'Show policy events'}
              title={eventsOpen ? 'Hide policy events' : `Policy events (${events.length})`}
              onClick={() => setEventsOpen((current) => !current)}
            >
              {eventsOpen ? (
                <X size={16} className="text-outline" aria-hidden="true" />
              ) : (
                <History size={16} className="text-outline" aria-hidden="true" />
              )}
            </button>
          </div>
        </header>

      {/*
        OFFLINE banner. It appears ONLY when the state endpoint actually failed
        — a 401/404 or an unreachable host — not as a routine "not connected yet"
        state, and it carries the way back in. Below it every figure is an em dash
        and every write control is disabled, so the console cannot look live while
        it is not.
      */}
      {!live && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-x-space-lg gap-y-2 rounded-lg border border-l-4 border-outline-variant border-l-error bg-surface-container px-space-md py-space-sm"
        >
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <CloudOff size={16} className="shrink-0 text-error" aria-hidden="true" />
            <span className="whitespace-nowrap font-metric-value text-metric-value font-semibold text-on-surface">
              OFFLINE
            </span>
            <span className="min-w-0 font-code text-code text-on-surface-variant" title={DASHBOARD_TIPS.offline}>
              GET /api/Dashboard/state
            </span>
          </div>
          <button type="button" className="ant-btn ant-btn-primary" onClick={onSignIn}>
            Sign in
          </button>
        </div>
      )}

      {traceStatus === 'error' && live && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-md border border-tertiary-fixed-dim bg-tertiary-fixed px-space-md py-space-sm"
        >
          <span className="ant-dot ant-dot-warning" aria-hidden="true" />
          <span className="font-body-sm text-body-sm text-on-tertiary-fixed">
            Telemetry history unavailable — showing the last good reading. The live rail above is unaffected.
          </span>
        </div>
      )}

      {/* --- The rail --- */}
      <DashboardRail
        load={load}
        warning={thresholds.warning || WARNING_THRESHOLD}
        critical={thresholds.critical || CRITICAL_THRESHOLD}
        max={thresholds.max || MAX_CAPACITY}
        series={series}
        status={traceStatus}
        stale={stale}
        live={live}
        streamLabel={streamLabel}
        streamLive={streamLive}
        energized={live ? energizedCount : null}
        channelCount={RIG_CHANNEL_COUNT}
      />

      {/* --- Channels --- */}
      <section className="ant-card overflow-hidden" aria-label="Controlled channels">
        <div className="flex flex-wrap items-center justify-between gap-x-space-lg gap-y-1 border-b border-surface-container px-space-lg py-space-sm">
          <h2 className="font-title-lg text-title-lg font-semibold text-on-surface">Channels</h2>
          <span className="whitespace-nowrap font-code text-code text-outline">ADS1220 SPI · branch CT</span>
        </div>
        {/*
          Single column by default and two from `sm` up. Deliberately no 3rd
          column: this rig has two channels, and a third track would leave a
          dead cell on the widest screens — the exact thing an empty grid cell
          reads as. `items-start` keeps the two cards equal height without one
          stretching to match the other's content.
        */}
        <div className="grid grid-cols-1 items-start gap-space-md p-space-lg sm:grid-cols-2">
          {outlets.map((outlet) => (
            <DashboardOutlet
              key={outlet.id}
              outlet={outlet}
              warning={thresholds.warning || WARNING_THRESHOLD}
              critical={thresholds.critical || CRITICAL_THRESHOLD}
              max={thresholds.max || MAX_CAPACITY}
              history={historyFor(outlet.id)}
              live={live}
              onToggle={onToggleOutlet}
            />
          ))}
        </div>
      </section>

      {/* --- Vectors --- */}
      <DashboardSimRail onRun={runVector} notice={scenario.notice} busy={scenario.busy} live={live} />

      {/* --- Events, collapsed by default. The log is real output from the policy
          engine and must stay reachable, but it is a paragraph-shaped surface
          and the console is not a reading task. --- */}
      {eventsOpen && <EventLogPanel events={events} />}
    </div>
  )
}