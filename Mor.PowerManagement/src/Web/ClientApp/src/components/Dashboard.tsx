import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchTelemetrySeries, type Ina226Reading, type TelemetrySeries } from '../api'
import { POLL_INTERVAL_MS } from '../data/telemetry'
import { DASHBOARD_TIPS } from '../data/dashboard'
import type { EventLog, Outlet } from '../types/dashboard'
import { isEnergizedOutlet, totalLoad } from '../utils/dashboard'
import { stalenessState } from '../utils/telemetry'
import { DashboardHero } from './DashboardHero'
import { DashboardOutlet } from './DashboardOutlet'
import { DashboardSimRail, type VectorId } from './DashboardSimRail'
import { Ina226Card } from './Ina226Card'
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
  /** Live INA226 mains volts from state; null when the device has nothing fresh. */
  mainsVolts: number | null
  /** Raw INA226 sample. Every field nullable; nulls are never filled in. */
  ina226: Ina226Reading
  scenario: ScenarioHandlers
  onToggleOutlet: (id: number) => void
  onSignIn: () => void
}

/** Reference vector -> the scenario handler that dispatches it. */
const VECTOR_DISPATCH: Record<VectorId, keyof Pick<
  ScenarioHandlers,
  'onNormal' | 'onActivate' | 'onBlock' | 'onOverload' | 'onSelective' | 'onIdle'
>> = {
  normal: 'onNormal',
  surge: 'onBlock',
  policy: 'onSelective',
  overload: 'onOverload',
  audit: 'onActivate',
  shutdown: 'onIdle',
}

/** The window the hero trace and every sparkline are drawn from. */
const HERO_WINDOW = '15m' as const

export function Dashboard({
  outlets,
  thresholds,
  events,
  deviceOnline,
  backendOnline,
  mainsVolts,
  ina226,
  scenario,
  onToggleOutlet,
  onSignIn,
}: DashboardProps) {
  const [series, setSeries] = useState<TelemetrySeries | null>(null)
  const [traceStatus, setTraceStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [now, setNow] = useState(() => Date.now())
  const [busyId, setBusyId] = useState<number | null>(null)
  const [runs, setRuns] = useState(0)
  const [lastVector, setLastVector] = useState<VectorId | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const requestSeqRef = useRef(0)
  const failuresRef = useRef(0)
  const lastNotice = useRef<ScenarioNotice | null>(null)

  /*
   * Telemetry loop. This backs the hero trace and the per-channel sparklines,
   * and it replaced the scenario panel's own loop rather than joining it — there
   * is exactly one telemetry poll in this tree, because two loops on a host that
   * sleeps doubles the cold-start cost for no extra freshness.
   */
  const loadTrace = useCallback(async (isRefresh: boolean) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const seq = ++requestSeqRef.current

    if (!isRefresh) setTraceStatus('loading')

    try {
      const payload = await fetchTelemetrySeries(HERO_WINDOW, undefined, controller.signal)
      if (seq !== requestSeqRef.current) return

      setSeries(payload)
      failuresRef.current = 0
      setTraceStatus('ready')
    } catch (cause) {
      if (seq !== requestSeqRef.current) return
      if (cause instanceof DOMException && cause.name === 'AbortError') return

      failuresRef.current += 1
      // The last good trace stays on screen through a miss, exactly as in the
      // Telemetry view. Only the hero's status dot changes.
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
      const base = POLL_INTERVAL_MS[HERO_WINDOW] ?? 5_000
      const delay = failures > 0 ? Math.max(base, 2_000 * 2 ** failures) : base
      timer = window.setTimeout(tick, delay)
    }

    timer = window.setTimeout(tick, POLL_INTERVAL_MS[HERO_WINDOW] ?? 5_000)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
      abortRef.current?.abort()
    }
  }, [loadTrace])

  // Label-only ticker for the freshness readout; never triggers a refetch.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (scenario.notice && lastNotice.current !== scenario.notice) {
      lastNotice.current = scenario.notice
      setRuns((current) => current + 1)
    }
  }, [scenario.notice])

  // --- derived -------------------------------------------------------------

  /*
   * `live` is the single honesty switch. Offline the rig reports nothing, so
   * every measured figure reads 0 — never a stale watt, never an em-dash. The
   * OFFLINE banner carries the explanation; the numbers stay arithmetic
   * (0 W total, full headroom, 0 energized) so the meter and bars still parse.
   */
  const live = backendOnline
  const load = live ? totalLoad(outlets) : 0
  const energized = live ? outlets.filter((outlet) => isEnergizedOutlet(outlet.status)).length : 0

  const historyFor = useCallback(
    (outletId: number): Array<number | null> => {
      const channel = series?.channels.find((entry) => entry.outletId === outletId)
      if (!channel || !series) return []
      // The server already resolved the window's grid, so the channel arrays are
      // the window. Clamped anyway so a ragged response cannot over-index.
      const take = Math.max(2, series.bucketCount)
      return channel.watts.slice(-take)
    },
    [series],
  )

  const deviceHasSamples = (series?.channels ?? []).some((channel) => channel.sampleCount > 0)
  const streamLabel = stalenessState(
    series?.latestSampleAt ?? null,
    now,
    deviceOnline && deviceHasSamples,
  ).label
  const streamLive = traceStatus === 'ready' && Boolean(series?.latestSampleAt)

  const runVector = (id: VectorId) => {
    const key = VECTOR_DISPATCH[id]
    if (!key) return
    setLastVector(id)
    scenario[key]()
  }

  /*
   * The switch posts through App, which dispatches the real activation or
   * disconnection route and re-reads the roster. `busyId` is released when that
   * re-read lands, so the row stays disabled for exactly as long as the command
   * is genuinely in flight — no arbitrary timeout guessing at when it finished.
   */
  const toggleOutlet = (id: number) => {
    setBusyId(id)
    onToggleOutlet(id)
  }

  const rosterSignature = outlets.map((o) => `${o.id}:${o.status}:${Math.round(o.watts)}`).join('|')
  useEffect(() => {
    setBusyId(null)
  }, [rosterSignature])

  return (
    <div className="mp">
      <DashboardHero
        load={load}
        warning={thresholds.warning}
        critical={thresholds.critical}
        max={thresholds.max}
        energized={energized}
        channelCount={outlets.length}
        series={series}
        live={live}
        streamLabel={streamLabel}
        streamLive={streamLive}
        onSignIn={onSignIn}
      />

      <h2 className="mp-h">
        <span>Channels</span>
        {/*
          Names the sensors, not a volts figure. This header used to print the
          INA226 reference rail, which put a second copy of the bus voltage on
          screen that could disagree with the card below it (the header read the
          server's averaged reference, the card the converter's latest sample)
          and that fell back to the rated rail whenever the device had nothing
          fresh. One number, in one place, from one source.

          The trailing count is the reason a row in this list cannot be switched:
          four branches have a CT and a relay, the fifth is the USB rail and has
          neither. The row itself says which is which, so this only has to make
          the shape of the bench legible from across a room.
        */}
        <span className="num" title={DASHBOARD_TIPS.outlet}>
          4 × 220 V · branch CT + relay · 1 × 5 V USB · monitored only
        </span>
      </h2>
      {/* Not "controlled channels": CH5 is in this list and has no control. */}
      <div aria-label="Channels">
        {outlets.length === 0 ? (
          <div className="mp-card" style={{ padding: '18px 22px', color: 'var(--mute)' }}>
            <span className="num">Channel roster not loaded.</span>
          </div>
        ) : (
          outlets.map((outlet) => (
            <DashboardOutlet
              key={outlet.id}
              outlet={outlet}
              history={historyFor(outlet.id)}
              live={live}
              // Outlet 5 is the USB socket: its volts are the INA226 raw bus
              // volts, never the divided mains the AC branches use.
              mainsVolts={outlet.id === 5 ? (ina226.busVolts ?? mainsVolts) : mainsVolts}
              busy={busyId === outlet.id}
              onToggle={toggleOutlet}
            />
          ))
        )}
      </div>

      {/*
        The INA226 sits here, between the branches it feeds and the vectors that
        drive them: the branches consume its bus reading to derive their amps, and
        the vectors change what it reads. Reading order follows the signal.
      */}
      <Ina226Card reading={ina226} live={live} now={now} />

      <h2 className="mp-h">
        <span>Vectors</span>
        <span className="num">POST /api/Dashboard/scenarios/ingest</span>
      </h2>
      <DashboardSimRail
        onRun={runVector}
        notice={scenario.notice}
        busy={scenario.busy}
        live={live}
        runs={runs}
        lastRun={lastVector}
      />

      {/*
        Policy events stay reachable but out of the way. The reference console
        has no log panel, and the dashboard is read across a room, so the list is
        collapsed to a one-line count here rather than deleted — the events are
        real engine output and must not become unreachable.

        The empty branch is a real state, not a missing one: GET /Dashboard/state
        returns an empty log on a rig that has not tripped anything, and saying
        so is the difference between "the engine is quiet" and "the log is not
        rendering". It used to render nothing at all here, next to two seeded
        rows in data/dashboard.ts that the browser had written about numbers it
        had invented.
      */}
      {events.length === 0 ? (
        <p className="num" style={{ marginTop: 26, color: 'var(--mute)', fontSize: 12 }}>
          No policy events yet. GET /api/Dashboard/state returned an empty log; entries appear here the
          moment the engine raises one — a threshold crossing, a relay action, or a fault lockout.
        </p>
      ) : (
        <details className="num" style={{ marginTop: 26, color: 'var(--mute)', fontSize: 12 }}>
          <summary style={{ cursor: 'pointer' }}>{`${events.length} policy events`}</summary>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            {events.slice(0, 20).map((event) => (
              <li key={event.id} style={{ marginBottom: 4 }}>
                <span style={{ color: 'var(--mute)' }}>{event.time}</span>{' '}
                <strong style={{ color: 'var(--ink)' }}>{event.title}</strong>
                {event.severity === 'critical' || event.severity === 'warning' ? (
                  <span style={{ color: 'var(--bad)' }}> · {event.severity}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}