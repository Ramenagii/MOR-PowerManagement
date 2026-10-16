import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchTelemetrySeries, type Ina226Reading, type TelemetrySeries } from '../api'
import { POLL_INTERVAL_MS } from '../data/telemetry'
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

/**
 * The one empty history in the tree.
 *
 * `historyFor` used to answer an unknown channel with a fresh `[]`, so every
 * render produced a new array identity for a row that has no window at all, and
 * the row's peak memo — and any entrance motion hung off it — was invalidated on
 * a 500 ms cadence for no change whatsoever. One frozen constant makes "no
 * buckets" a fact that compares equal to itself.
 */
const NO_HISTORY: Array<number | null> = []

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

  const historyByOutlet = useMemo(() => {
    const map = new Map<number, Array<number | null>>()
    if (!series) return map
    // The server already resolved the window's grid, so the channel arrays are
    // the window. Clamped anyway so a ragged response cannot over-index.
    const take = Math.max(2, series.bucketCount)
    for (const channel of series.channels) {
      map.set(channel.outletId, channel.watts.slice(-take))
    }
    return map
  }, [series])

  const historyFor = useCallback(
    (outletId: number): Array<number | null> => historyByOutlet.get(outletId) ?? NO_HISTORY,
    [historyByOutlet],
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
   *
   * `onToggleOutlet` is a plain function on every App render, so passing it
   * straight down would give each row a new `onToggle` on every poll and defeat
   * the value comparison that keeps the rows from re-rendering. The ref is what
   * makes the stable wrapper below honest: the row holds one function for its
   * whole life and that function still dispatches against the CURRENT roster, so
   * a switch pressed after twenty polls cannot act on the roster it was rendered
   * from. It is assigned during render rather than in an effect on purpose —
   * an effect leaves a window in which a click dispatches the previous closure.
   */
  const toggleRef = useRef(onToggleOutlet)
  toggleRef.current = onToggleOutlet

  const toggleOutlet = useCallback((id: number) => {
    setBusyId(id)
    toggleRef.current(id)
  }, [])

  /*
   * The roster signature is a change DETECTOR, not an identity. It exists to
   * release the pressed row's spinner once the re-read that answers the command
   * has landed, and it is memoised so the string is not rebuilt on renders that
   * did not change the roster.
   *
   * It deliberately keeps watts in the signature even though a watt change is
   * not a command completing: a relay the server refuses to move leaves `status`
   * unchanged, and keying on status alone would strand the switch in its busy
   * state forever. The cost of over-detecting is one extra render — and the rows
   * are now compared by value, so on a tick that only jitters the wattage of
   * some other branch, none of them render at all.
   */
  const rosterSignature = useMemo(
    () => outlets.map((o) => `${o.id}:${o.status}:${Math.round(o.watts)}`).join('|'),
    [outlets],
  )
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
      </h2>
      {/* Not "controlled channels": CH5 is in this list and has no control. */}
      {/*
        THE LIST AND THE EMPTY STATE ARE SIBLINGS, NOT TWO ARMS OF ONE TERNARY.

        As a ternary the roster was either one unkeyed `<div>` or an array of
        keyed `<article>`s, occupying the same position in the same children
        list. React read that as "unmount the div, mount five articles" and back
        again, so any moment the roster read empty tore down every row element
        and the next poll built five brand-new ones — which is the "rows remount
        and replay their entrance" behaviour seen from the outside. Sibling
        rendering keeps the children list the same shape in both states, so an
        empty roster adds one card instead of replacing five rows.

        The key is `outlet.id` and nothing else. It is the server's channel
        number, it is the one field that cannot change while a channel is still
        that channel, and it is therefore the only key here that survives a
        poll — an index key would silently hand CH3's DOM node to whichever
        branch sorted into slot three, and a signature of status/watts would
        remount the row every time the load moved. `rowIndex` is passed for the
        stagger offset and is deliberately NOT the key.
      */}
      <div aria-label="Channels">
        {outlets.map((outlet, index) => (
          <DashboardOutlet
            key={outlet.id}
            rowIndex={index}
            outlet={outlet}
            history={historyFor(outlet.id)}
            live={live}
            /*
              CH5 gets NO volts reference at all, and that is the honest
              answer rather than a gap.

              It used to be handed `ina226.busVolts` as its own, on the claim
              that the INA226 sits on the rail the socket is fed from. It does
              not: the converter measures its own DC shunt path, so a 5 V USB socket
              was displaying an unrelated INA226 figure as though the socket had been
              measured. Passing null makes the row read 0.0 V · 0.00 A with
              the tooltip saying nothing on the rig measures that rail — which
              is a weaker claim than a wrong number, and it is a true one.
            */
            mainsVolts={outlet.id === 5 ? null : mainsVolts}
            busy={busyId === outlet.id}
            onToggle={toggleOutlet}
          />
        ))}

        {outlets.length === 0 && (
          <div className="mp-card" style={{ padding: '18px 22px', color: 'var(--mute)' }}>
            <span className="num">Channel roster not loaded.</span>
          </div>
        )}
      </div>

      {/*
        The INA226 sits here, between the branches and the vectors that drive
        them. It is NOT the reference those branches derive against — it is a
        standalone DC shunt monitor polled by the ESP32 over I2C — so this position is about reading
        order rather than signal flow: it is the one card on the page whose
        three headline figures are direct conversions rather than arithmetic on
        somebody else's total, and it belongs where the eye lands after scanning
        the rows and before reaching for a control.
      */}
      <Ina226Card reading={ina226} live={live} now={now} />

      <h2 className="mp-h">
        <span>Actions</span>
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
          No recent events.
        </p>
      ) : (
        <details className="num" style={{ marginTop: 26, color: 'var(--mute)', fontSize: 12 }}>
          <summary style={{ cursor: 'pointer' }}>{`Recent events · ${events.length}`}</summary>
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
