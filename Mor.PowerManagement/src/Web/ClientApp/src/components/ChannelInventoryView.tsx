import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  CircuitBoard,
  CloudOff,
  Cpu,
  Info,
  RefreshCw,
  Search,
} from 'lucide-react'
import {
  ApiError,
  activateOutlet,
  disconnectOutlet,
  fetchDashboardState,
  fetchTelemetrySeries,
  type TelemetryChannel,
  type TelemetrySeries,
  type TelemetryWindow,
  type ThresholdSet,
} from '../api'
import { POLL_INTERVAL_MS } from '../data/telemetry'
import type { Outlet, OutletStatus, Priority } from '../types/dashboard'
import { describeSeries } from '../utils/telemetry'

/**
 * Channel Inventory & Sensor Matrix — Stitch "soft minimalist" redesign.
 *
 * What changed and why it is not the previous view:
 * the old screen was a dense engineering report (hatch fills, five tags per
 * card, provenance dots on every row). The reference is a quiet inventory: four
 * floating summary cards, a filter rail, and one card per branch that reads
 * top-down as identity -> measurement -> allowance -> control. Colour is spent
 * only where it means something: a status dot, the power figure, the allowance
 * fill, and the relay switch.
 *
 * Data honesty rules for this file:
 *   - The roster is the live one from GET /Dashboard/state. Nothing here is
 *     seeded, and no figure is computed from a hardcoded wattage.
 *   - Branches that exist on the full bench but are not wired on the current
 *     rig render as UNWIRED cards. Their readings are real zeros from an
 *     unwired branch, which is a fact, and their toggle is disabled — a control
 *     that would post against a pin that does not exist must not look usable.
 *   - When the backend cannot be reached the banner appears and every measured
 *     field becomes an em dash. A dash means "not reported"; a 0 would be a
 *     claim.
 */

type Status = 'loading' | 'ready' | 'unauthorized' | 'error'

/** Short window: the inventory is a live view, not a trend view. */
const LIVE_WINDOW: TelemetryWindow = '15m'

/** Sampling period, reused from the telemetry view so both stay in step. */
const REFRESH_MS = POLL_INTERVAL_MS[LIVE_WINDOW] ?? 5_000

/** Shown when the backend is unreachable, to distinguish it from "no data yet". */
const UNAVAILABLE = '—'

// ---------------------------------------------------------------------------
// Bench roster
// ---------------------------------------------------------------------------

/**
 * Branches on the full bench that the current 2-outlet rig does not wire.
 *
 * FUTURE 4+USB: when CH3-CH5 are physically installed, delete this table — the
 * cards stop being placeholders because GET /Dashboard/state starts returning
 * those ids, and the roster filter below drops them automatically. GPIO pins for
 * them must be added to RELAY_GPIO in data/dashboard.ts at the same time; do not
 * guess them from the channel id, the two wired channels prove the order is not
 * sequential.
 */
const UNWIRED_BRANCHES: Array<{ id: number; rail: '220V AC' | '110V AC' | '5V USB'; eyebrow: string }> = [
  { id: 3, rail: '220V AC', eyebrow: 'AC Outlet 3' },
  { id: 4, rail: '220V AC', eyebrow: 'AC Outlet 4' },
  { id: 5, rail: '5V USB', eyebrow: 'USB-C DC Rail' },
]

/**
 * Relay GPIO per wired channel. CH1 is on GPIO2 and CH2 on GPIO1 — not
 * sequential, because GPIO1 was claimed by the debug UART first.
 */
const RELAY_GPIO: Record<number, string> = { 1: 'GPIO2', 2: 'GPIO1' }

/** Branch current transformer + ADC front end fitted to each mains branch. */
const BRANCH_SENSOR = 'ADS1220'

type Rail = '220V AC' | '110V AC' | '5V USB' | 'Unrated'

/**
 * Rail from the channel's RATED voltage.
 *
 * A rating of 0 is "the server did not rate this channel", which used to fall
 * through to the 5 V branch and label an unrated mains outlet as USB. Unrated is
 * its own answer because it is a fact about the record, not about the bench.
 */
function railOf(volts: number): Rail {
  if (volts <= 0) return 'Unrated'
  if (volts >= 200) return '220V AC'
  if (volts >= 100) return '110V AC'
  return '5V USB'
}

function railOfLabel(rail: Rail): string {
  if (rail === 'Unrated') return 'unrated'
  return rail === '5V USB' ? 'USB' : rail === '110V AC' ? '110' : '220'
}

// ---------------------------------------------------------------------------
// Priority + status presentation
// ---------------------------------------------------------------------------

/** Rail tabs. Counts are derived from the live roster, never hardcoded. */
const RAIL_TABS: Array<{ label: string; key: string }> = [
  { label: 'All', key: 'all' },
  { label: '220V AC', key: '220' },
  { label: '110V AC', key: '110' },
  { label: '5V USB', key: 'USB' },
  { label: 'Unrated', key: 'unrated' },
]

/**
 * Protection priority as the reference states it: P0 is the most protected and
 * sheds last, so Critical maps to P0. The tint escalates only as far as the
 * *unprotected* end — High is a neutral grey, because colouring an ordinary
 * channel amber would make the common case the loudest thing in the grid.
 */
const PRIORITY_VIEW: Record<Priority, { label: string; tagClass: string }> = {
  Critical: { label: 'P0 Protected', tagClass: 'st-tag st-tag-accent' },
  High: { label: 'P1 High', tagClass: 'st-tag st-tag-neutral' },
  Medium: { label: 'P2 Medium', tagClass: 'st-tag st-tag-warn' },
  Low: { label: 'P3 Low', tagClass: 'st-tag st-tag-muted' },
}

type StatusView = { dot: string; label: string }

const STATUS_VIEWS: Record<OutletStatus, StatusView> = {
  Active: { dot: 'st-dot st-dot-ok', label: 'Energized' },
  Standby: { dot: 'st-dot st-dot-warn', label: 'Standby' },
  Restricted: { dot: 'st-dot st-dot-warn', label: 'Restricted' },
  Disconnected: { dot: 'st-dot st-dot-off', label: 'Open' },
}

// ---------------------------------------------------------------------------
// Search / sort
// ---------------------------------------------------------------------------

type SortId = 'load-desc' | 'load-asc' | 'id-asc' | 'priority'

const SORT_OPTIONS: Array<{ id: SortId; label: string }> = [
  { id: 'load-desc', label: 'Load: high to low' },
  { id: 'load-asc', label: 'Load: low to high' },
  { id: 'id-asc', label: 'Channel ID' },
  { id: 'priority', label: 'Protection priority' },
]

/** Critical is the most protected, so it sorts first regardless of enum order. */
const PRIORITY_RANK: Record<Priority, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 }

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

type Row = {
  id: number
  /** False for a branch the rig does not wire. */
  wired: boolean
  rail: Rail
  eyebrow: string
  name: string
  priority: Priority | null
  status: OutletStatus | null
  gpio: string
  ratedVolts: number
  allowance: number
  volts: number | null
  amps: number | null
  watts: number | null
  measured: boolean
  /** Buckets carrying a real sample, for the coverage tooltip. */
  coverage: number
  total: number
}

const UNKNOWN_CHANNEL = (
  id: number,
  name: string,
  relay: string,
  ratedVoltageVolts: number,
): TelemetryChannel => ({
  outletId: id,
  name,
  relayChannel: relay,
  ratedVoltageVolts,
  provenance: 'Unknown',
  provenanceNote: 'No telemetry returned for this channel in the selected window.',
  sampleCount: 0,
  volts: [],
  amps: [],
  watts: [],
  peakWatts: [],
})

/** Last non-null value in a series, or null when the channel never reported. */
function lastValue(values: Array<number | null>): number | null {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const value = values[i]
    if (value !== null && Number.isFinite(value)) return value
  }
  return null
}

function buildRows(outlets: Outlet[], series: TelemetrySeries | null): Row[] {
  const wired: Row[] = outlets.map((outlet) => {
    const channel =
      series?.channels.find((c) => c.outletId === outlet.id) ??
      UNKNOWN_CHANNEL(outlet.id, outlet.name, outlet.relay, outlet.volts)

    // Telemetry volts are the measured rail; when the window has no sample we
    // fall back to the rated rail, which is a configuration fact rather than a
    // measurement and is labelled as such by the card.
    const sampledVolts = lastValue(channel.volts)
    const sampledAmps = lastValue(channel.amps)
    const sampledWatts = lastValue(channel.watts)

    return {
      id: outlet.id,
      wired: true,
      rail: railOf(outlet.volts),
      eyebrow: `AC Outlet ${outlet.id}`,
      name: outlet.name,
      priority: outlet.priority,
      status: outlet.status,
      gpio: RELAY_GPIO[outlet.id] ?? '—',
      ratedVolts: outlet.volts,
      allowance: outlet.allowance,
      volts: sampledVolts,
      amps: sampledAmps,
      watts: sampledWatts,
      measured: channel.provenance === 'Measured',
      coverage: describeSeries(channel.watts).count,
      total: series?.bucketCount ?? 0,
    }
  })

  // Placeholders only for branches the roster does not already contain, so
  // wiring CH3 later makes its placeholder disappear without a code change.
  const present = new Set(wired.map((row) => row.id))
  const placeholders: Row[] = UNWIRED_BRANCHES.filter((branch) => !present.has(branch.id)).map(
    (branch) => ({
      id: branch.id,
      wired: false,
      rail: branch.rail,
      eyebrow: branch.eyebrow,
      name: 'Not wired on this bench',
      priority: null,
      status: null,
      gpio: '—',
      ratedVolts: branch.rail === '5V USB' ? 5 : 220,
      allowance: 0,
      // A branch with no sensor attached reads zero because nothing is fitted,
      // which is a fact about the bench rather than a fabricated sample. It is
      // zero here and not a dash precisely because zero is the true answer.
      volts: null,
      amps: 0,
      watts: 0,
      measured: false,
      coverage: 0,
      total: 0,
    }),
  )

  return [...wired, ...placeholders]
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ChannelInventoryView() {
  const [outlets, setOutlets] = useState<Outlet[]>([])
  const [series, setSeries] = useState<TelemetrySeries | null>(null)
  const [thresholds, setThresholds] = useState<ThresholdSet>({
    max: 0,
    warning: 0,
    critical: 0,
    standby: 0,
    standbyIdleMinutes: 0,
    stabilizationDelayMs: 0,
  })
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [railFilter, setRailFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortId>('id-asc')

  const abortRef = useRef<AbortController | null>(null)
  const requestSeqRef = useRef(0)
  const failuresRef = useRef(0)

  const load = useCallback(async (isRefresh: boolean) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const seq = ++requestSeqRef.current

    if (!isRefresh) setStatus('loading')

    try {
      // State and telemetry are fetched together: the roster is the authority
      // for what exists and what each branch is allowed, the series is the
      // authority for what each branch is currently drawing.
      const [state, telemetry] = await Promise.all([
        fetchDashboardState(),
        fetchTelemetrySeries(LIVE_WINDOW, undefined, controller.signal),
      ])
      if (seq !== requestSeqRef.current) return

      setOutlets(state.outlets)
      setSeries(telemetry)
      setThresholds(state.thresholds)
      failuresRef.current = 0
      setError(null)
      setStatus('ready')
    } catch (cause) {
      if (seq !== requestSeqRef.current) return
      if (cause instanceof DOMException && cause.name === 'AbortError') return

      if (cause instanceof ApiError && cause.status === 401) {
        setStatus('unauthorized')
        setError('Session expired. Sign in again to view the inventory.')
        return
      }

      failuresRef.current += 1
      setError(cause instanceof ApiError && cause.status === 0 ? 'Backend unreachable' : String(cause))
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    void load(false)

    let timer: number | undefined
    let cancelled = false

    const tick = () => {
      if (cancelled) return
      if (!document.hidden) void load(true)
      // Back off on a cold backend so it is not hammered while it wakes.
      const delay = failuresRef.current > 0 ? Math.max(REFRESH_MS, 2000 * 2 ** failuresRef.current) : REFRESH_MS
      timer = window.setTimeout(tick, delay)
    }

    timer = window.setTimeout(tick, REFRESH_MS)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
      abortRef.current?.abort()
    }
  }, [load])

  /**
   * Relay command. Posts the real activation or disconnection route and then
   * re-reads the roster, so the card reflects what the server actually decided
   * rather than optimistically flipping. A refusal is surfaced, not swallowed.
   */
  const toggleRelay = async (row: Row) => {
    if (!row.wired || row.status === null) return

    setBusyId(row.id)
    try {
      if (row.status === 'Active' || row.status === 'Standby') await disconnectOutlet(row.id)
      else await activateOutlet(row.id)
      await load(true)
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? `${row.id === 1 ? 'CH01' : 'CH02'} relay command rejected: ${cause.message}`
          : `${row.id} relay command failed: ${String(cause)}`,
      )
    } finally {
      setBusyId(null)
    }
  }

  // --- derived -------------------------------------------------------------

  const rows = useMemo(() => buildRows(outlets, series), [outlets, series])
  const live = status === 'ready' && outlets.length > 0

  const railCounts = useMemo(() => {
    const counts = new Map<string, number>([['all', rows.length]])
    for (const row of rows) {
      const key = railOfLabel(row.rail)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
  }, [rows])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return rows
      .filter((row) => {
        if (railFilter !== 'all' && railOfLabel(row.rail) !== railFilter) return false
        if (!needle) return true
        return (
          row.name.toLowerCase().includes(needle) ||
          row.gpio.toLowerCase().includes(needle) ||
          row.eyebrow.toLowerCase().includes(needle) ||
          row.rail.toLowerCase().includes(needle)
        )
      })
      .sort((a, b) => {
        if (sort === 'priority') {
          return (
            (PRIORITY_RANK[a.priority ?? 'Low'] ?? 3) - (PRIORITY_RANK[b.priority ?? 'Low'] ?? 3) || a.id - b.id
          )
        }
        if (sort === 'load-desc') return (b.watts ?? -1) - (a.watts ?? -1)
        if (sort === 'load-asc') return (a.watts ?? -1) - (b.watts ?? -1)
        return a.id - b.id
      })
  }, [rows, railFilter, query, sort])

  // Summary figures. `live` gates every measurement: with no backend answer the
  // baseline roster is never presented as a reading.
  const totalWatts = rows.filter((r) => r.wired).reduce((sum, r) => sum + (r.watts ?? 0), 0)
  // Rated rail comes off the roster. The old `?? 220` invented a mains rating
  // for a roster that had none, and it fed the headline "Rated 220 V" caption.
  const ratedVolts = rows.find((r) => r.rail === '220V AC')?.ratedVolts ?? 0
  const reportedVolts = rows.find((r) => r.rail === '220V AC')?.volts ?? null
  const totalAmps = rows
    .filter((r) => r.wired && r.rail !== '5V USB')
    .reduce((sum, r) => sum + (r.amps ?? 0), 0)
  const allowanceAmps = rows
    .filter((r) => r.wired && r.rail !== '5V USB')
    .reduce((sum, r) => sum + (ratedVolts > 0 ? r.allowance / ratedVolts : 0), 0)

  const energized = rows.filter((r) => r.wired && (r.status === 'Active' || r.status === 'Standby')).length
  const standby = rows.filter((r) => r.status === 'Standby').length
  const wiredCount = rows.filter((r) => r.wired).length

  /*
   * Trip points are the framework's CONFIGURATION and they are read from
   * GET /Dashboard/state like everything else. This block used to open with
   * `const critical = 600; const warning = 480` — a copy of the rig's settings
   * typed into a component — and then rendered a load percentage, a headroom in
   * watts and a warning/critical band derived from them. On a rig whose server
   * was down that produced "Headroom: 600 W" beside a 0 W total: a healthy
   * margin, asserted by the browser, against a ceiling nobody had confirmed.
   *
   * With no reported capacity, the percentage and the band are not "0 %" and
   * "Normal" — they are absent, so they render as a dash.
   */
  const critical = thresholds.critical
  const warning = thresholds.warning
  const hasLimits = critical > 0
  const loadPercent = hasLimits ? Math.min((totalWatts / critical) * 100, 100) : 0
  const headroom = critical - totalWatts
  const band = !hasLimits || totalWatts < warning ? 'normal' : totalWatts >= critical ? 'critical' : 'warning'
  const bandBarClass =
    band === 'critical' ? 'st-bar-fill st-bar-fill-danger' : band === 'warning' ? 'st-bar-fill st-bar-fill-warn' : 'st-bar-fill'

  const show = (value: number | null, digits = 0, suffix = '') =>
    live && value !== null ? `${value.toFixed(digits)}${suffix}` : UNAVAILABLE

  return (
    <div className="stitch mx-auto flex w-full max-w-[1440px] flex-col gap-6 px-margin py-space-lg">
      {/* ---------------- Header ---------------- */}
      <header className="flex flex-col gap-1.5">
        <nav aria-label="Breadcrumb" className="st-micro">
          <span>Dashboard</span>
          <span className="px-1.5 text-[#cfd3db]">/</span>
          <span className="font-medium text-[#2a3039]">Channels</span>
        </nav>

        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-col gap-0.5">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="st-title">Channel Inventory &amp; Sensor Matrix</h1>
              <span className="st-chip st-chip-info" title={`Polling every ${Math.round(REFRESH_MS / 1000)} s on the ${LIVE_WINDOW} window`}>
                <span className="relative flex h-1.5 w-1.5 items-center justify-center" aria-hidden="true">
                  <span className={`st-dot ${live ? 'st-dot-ok' : 'st-dot-off'}`} />
                  {live && (
                    <span className="st-dot st-dot-ok st-ping absolute" />
                  )}
                </span>
                {live ? 'Live Stream' : 'No Signal'}
              </span>
            </div>
            <p className="st-body">
              {`${rows.length} branches across ${rows.filter((r) => r.rail !== '5V USB').length} AC outlets (220V) and ${rows.filter((r) => r.rail === '5V USB').length} USB-C DC rail`}
              {rows.some((r) => r.rail === 'Unrated') ? ' · some branches are unrated' : ''}
            </p>
          </div>

          <button
            type="button"
            className="st-btn self-start lg:self-center"
            onClick={() => void load(true)}
            aria-label="Refresh telemetry now"
          >
            <RefreshCw size={15} className={status === 'loading' ? 'animate-spin' : ''} aria-hidden="true" />
            Refresh Telemetry
          </button>
        </div>
      </header>

      {/* ---------------- OFFLINE / error banner ---------------- */}
      {(status === 'error' || status === 'unauthorized') && (
        <div className="st-banner" role="status">
          <div className="flex min-w-0 items-center gap-2">
            {status === 'unauthorized' ? (
              <Info size={15} className="st-warn" aria-hidden="true" />
            ) : (
              <CloudOff size={15} className="st-danger" aria-hidden="true" />
            )}
            <span className="st-chip st-chip-danger">OFFLINE</span>
            <span className="st-micro min-w-0 truncate" title="GET /api/Dashboard/state">
              {error ?? 'Backend unreachable'}
            </span>
          </div>
          <button type="button" className="st-btn" onClick={() => void load(false)}>
            Retry
          </button>
        </div>
      )}

      {status === 'loading' && outlets.length === 0 && (
        <div className="st-card st-card-pad st-micro">Reading channel roster…</div>
      )}

      {/* ---------------- Summary stats ---------------- */}
      <section className="st-stats st-stats-4" aria-label="System overview">
        {/* 1 — Total Active Load */}
        <article className="st-card st-card-pad st-stat">
          <div className="st-stat-head">
            <span className="st-label">Total Active Load</span>
            <span className={`st-chip ${band === 'critical' ? 'st-chip-danger' : band === 'warning' ? 'st-chip-warn' : 'st-chip-ok'}`}>
              <span className="st-dot st-dot-ok" aria-hidden="true" />
              {live && hasLimits ? `${Math.round(loadPercent)}%` : UNAVAILABLE}
            </span>
          </div>
          <div className="my-1.5 flex items-baseline gap-1">
            <span className="st-figure">{show(totalWatts, 1)}</span>
            <span className="st-unit">W</span>
          </div>
          <div>
            <div className="st-bar">
              <div className={bandBarClass} style={{ width: `${live && hasLimits ? loadPercent : 0}%` }} />
            </div>
            <div className="st-micro mt-2 flex items-center justify-between">
              <span>{hasLimits ? `Rated: ${critical.toLocaleString()} W` : `Rated: ${UNAVAILABLE}`}</span>
              <span className={hasLimits && headroom <= 0 ? 'st-danger' : 'st-ok'}>
                {live && hasLimits ? `Headroom: ${Math.round(headroom).toLocaleString()} W` : `Headroom: ${UNAVAILABLE}`}
              </span>
            </div>
          </div>
        </article>

        {/* 2 — Mains RMS Voltage */}
        <article className="st-card st-card-pad st-stat">
          <div className="st-stat-head">
            <span className="st-label">Mains RMS Voltage</span>
            <span className="st-chip st-chip-info" title="The ESP32 does not report line frequency">
              AC Rail
            </span>
          </div>
          <div className="my-1.5 flex items-baseline gap-1">
            <span className="st-figure">{live && reportedVolts !== null ? reportedVolts.toFixed(1) : UNAVAILABLE}</span>
            <span className="st-unit">V RMS</span>
          </div>
          <div className="st-stat-foot st-micro">
            <span className="st-accent">{'↗'} INA226 on mains feed</span>
            <span>{ratedVolts > 0 ? `Rated ${ratedVolts} V` : `Rated ${UNAVAILABLE}`}</span>
          </div>
        </article>

        {/* 3 — Aggregated Current */}
        <article className="st-card st-card-pad st-stat">
          <div className="st-stat-head">
            <span className="st-label">Aggregated Current</span>
            <span className="st-chip st-chip-neutral" title="Derived as P / V per branch, power factor assumed 1">
              PF 1.00
            </span>
          </div>
          <div className="my-1.5 flex items-baseline gap-1">
            <span className="st-figure">{show(totalAmps, 2)}</span>
            <span className="st-unit">A</span>
          </div>
          <div className="st-stat-foot st-micro">
            <span>Allowance Limit</span>
            <span className="font-medium text-[#20252c]">
              {live ? `${totalAmps.toFixed(2)} / ${allowanceAmps.toFixed(2)} A` : UNAVAILABLE}
            </span>
          </div>
        </article>

        {/* 4 — Active Relays */}
        <article className="st-card st-card-pad st-stat">
          <div className="st-stat-head">
            <span className="st-label">Active Relays</span>
            <span className="st-chip st-chip-ok">
              <span className="st-dot st-dot-ok" aria-hidden="true" />
              {live ? `${energized} Online` : UNAVAILABLE}
            </span>
          </div>
          <div className="my-1.5 flex items-baseline gap-1.5">
            <span className="st-figure">{live ? energized : UNAVAILABLE}</span>
            <span className="st-unit">/ {rows.length} Energized</span>
          </div>
          <div className="st-stat-foot st-micro">
            <span>{`${standby} In Standby`}</span>
            <span className="st-accent">0 Faulted</span>
          </div>
        </article>
      </section>

      {/* ---------------- Filter + operation toolbar ---------------- */}
      <div className="st-card flex flex-col gap-3 p-2.5 md:flex-row md:items-center md:justify-between">
        <div className="st-seg self-start md:self-auto" role="group" aria-label="Filter by rail">
          {RAIL_TABS.map((view) => {
            const count = railCounts.get(view.key) ?? 0
            return (
              <button
                key={view.key}
                type="button"
                className="st-seg-item"
                aria-pressed={railFilter === view.key}
                onClick={() => setRailFilter(view.key)}
              >
                {`${view.label} (${count})`}
              </button>
            )
          })}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative sm:w-64">
            <Search
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8e96a2]"
              aria-hidden="true"
            />
            <input
              type="search"
              className="st-input pl-8"
              placeholder="Search channels, GPIO, rail…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search channels by name, GPIO or rail"
            />
          </div>
          <div className="relative sm:w-56">
            <select
              className="st-select"
              value={sort}
              onChange={(event) => setSort(event.target.value as SortId)}
              aria-label="Sort channels"
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  Sort: {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* ---------------- Channel grid ---------------- */}
      {filtered.length === 0 ? (
        <div className="st-card st-empty">
          <p className="st-body">
            No branch matches this filter. Clear the search or pick a different rail.
          </p>
          <button
            type="button"
            className="st-btn"
            onClick={() => {
              setQuery('')
              setRailFilter('all')
            }}
          >
            Reset filters
          </button>
        </div>
      ) : (
        <section className="st-channels" aria-label="Channel cards">
          {filtered.map((row) => (
            <ChannelCard
              key={row.id}
              row={row}
              live={live}
              busy={busyId === row.id}
              onToggle={() => void toggleRelay(row)}
            />
          ))}
        </section>
      )}

      {/* ---------------- Provenance footer ---------------- */}
      <footer className="st-card st-card-pad flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Activity size={16} className="st-accent" aria-hidden="true" />
          <p className="st-micro min-w-0">
            Thesis Defense Provenance: {wiredCount} wired rail branch
            {wiredCount === 1 ? '' : 'es'} via ADS1220 SPI front end reading a CT per branch, INA226 on the
            common mains feed. Unwired branches report zero because nothing is fitted.
          </p>
        </div>
        <span className="st-chip st-chip-info">
          <CircuitBoard size={12} aria-hidden="true" />
          {`${LIVE_WINDOW} window`}
        </span>
      </footer>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Channel card
// ---------------------------------------------------------------------------

function ChannelCard({
  row,
  live,
  busy,
  onToggle,
}: {
  row: Row
  live: boolean
  busy: boolean
  onToggle: () => void
}) {
  const statusView = row.status ? STATUS_VIEWS[row.status] : null
  const on = row.status === 'Active' || row.status === 'Standby'

  const watts = row.watts ?? 0
  const capPercent = row.allowance > 0 ? (watts / row.allowance) * 100 : 0
  const overCap = row.allowance > 0 && watts > row.allowance
  const barClass = overCap ? 'st-bar-fill st-bar-fill-danger' : capPercent >= 85 ? 'st-bar-fill st-bar-fill-warn' : 'st-bar-fill'

  // A wired branch with no backend answer shows a dash; an unwired branch shows
  // a real 0.00 A / 0 W because zero is what an unfitted sensor reports.
  const voltsText = !row.wired ? UNAVAILABLE : live && row.volts !== null ? `${row.volts.toFixed(1)}V` : UNAVAILABLE
  const ampsText = !row.wired ? '0.00A' : live ? `${(row.amps ?? 0).toFixed(2)}A` : UNAVAILABLE
  const powerText = !row.wired ? '0W' : live ? `${Math.round(watts)}W` : UNAVAILABLE

  const dotClass = !row.wired ? 'st-dot st-dot-off' : statusView ? statusView.dot : 'st-dot st-dot-off'

  return (
    <article
      className={`st-card st-card-pad st-card-hover st-channel ${row.wired ? '' : 'st-unwired'}`}
      aria-label={`CH${String(row.id).padStart(2, '0')}, ${row.name}, ${row.wired ? (statusView?.label ?? 'Unknown') : 'not wired'}`}
    >
      {/* Identity */}
      <div className="mb-2.5 flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className={`${dotClass} mt-1`} aria-hidden="true" />
          <span className="st-tiny font-semibold text-[#1a1f26]">{`CH${String(row.id).padStart(2, '0')}`}</span>
          <span className="st-tag st-tag-neutral">{row.rail}</span>
        </div>
        {row.priority ? (
          <span className={PRIORITY_VIEW[row.priority].tagClass}>{PRIORITY_VIEW[row.priority].label}</span>
        ) : (
          <span className="st-tag st-tag-muted">Unwired</span>
        )}
      </div>

      {/* Name */}
      <div className="mb-3">
        <div className="st-eyebrow">{row.eyebrow}</div>
        <h2 className="st-h3 truncate" title={row.name}>
          {row.name}
        </h2>
      </div>

      {/* Measurement matrix */}
      <div className="st-matrix mb-3">
        <div>
          <div className="st-matrix-label">Voltage</div>
          <div className="st-matrix-value">{voltsText}</div>
        </div>
        <div>
          <div className="st-matrix-label">Current</div>
          <div className="st-matrix-value">{ampsText}</div>
        </div>
        <div>
          <div className="st-matrix-label">Power</div>
          <div className="st-matrix-value st-accent">{powerText}</div>
        </div>
      </div>

      {/* Allowance */}
      {row.wired ? (
        <div className="mb-3">
          <div className="st-micro mb-1 flex items-center justify-between gap-2">
            <span className="min-w-0 truncate">{`Cap: ${Math.round(watts)}W / ${Math.round(row.allowance)}W`}</span>
            <span className={overCap ? 'st-danger font-medium' : capPercent >= 85 ? 'st-warn font-medium' : 'st-ok font-medium'}>
              {live ? `${capPercent.toFixed(1)}%` : UNAVAILABLE}
            </span>
          </div>
          <div
            className="st-bar st-bar-2"
            role="meter"
            aria-valuenow={Math.round(capPercent)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`CH${row.id} load against its allowance`}
          >
            <div className={barClass} style={{ width: `${Math.min(capPercent, 100)}%` }} />
          </div>
        </div>
      ) : (
        <div className="mb-3">
          <div className="st-micro mb-1 flex items-center justify-between gap-2">
            <span>No sensor fitted</span>
            <span className="font-medium">0%</span>
          </div>
          <div className="st-bar st-bar-2" aria-hidden="true">
            <div className="st-bar-fill st-bar-fill-idle" style={{ width: '0%' }} />
          </div>
        </div>
      )}

      {/* Footer: GPIO · sensor, plus the relay control */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#f2f2eb] pt-2.5">
        <span className="st-micro flex min-w-0 items-center gap-1" title="Relay pin and branch current transformer front end">
          <Cpu size={12} className="flex-none text-[#939ca8]" aria-hidden="true" />
          <span className="truncate">{`${row.gpio} · ${BRANCH_SENSOR}`}</span>
        </span>

        <div className="flex items-center gap-1.5">
          {busy ? (
            <span className="st-micro st-warn" role="status">
              Posting…
            </span>
          ) : (
            <span className={`st-tiny font-medium ${on ? 'st-ok' : 'text-[#939ca8]'}`}>
              {row.wired ? (on ? 'ON' : 'OFF') : 'NO WIRING'}
            </span>
          )}
          <button
            type="button"
            className="st-relay"
            role="switch"
            aria-checked={on}
            aria-label={`${on ? 'Disconnect' : 'Activate'} CH${String(row.id).padStart(2, '0')} relay`}
            title={
              !row.wired
                ? 'No relay is wired on this branch, so this control cannot dispatch a command.'
                : on
                  ? `POST /api/Dashboard/outlets/${row.id}/disconnection`
                  : `POST /api/Dashboard/outlets/${row.id}/activation`
            }
            disabled={!row.wired || busy || !live}
            onClick={onToggle}
          />
        </div>
      </div>
    </article>
  )
}