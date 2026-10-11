import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  BarChart3,
  ChevronDown,
  Gauge,
  Info,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react'
import {
  ApiError,
  fetchDashboardState,
  fetchTelemetrySeries,
  type DashboardSnapshot,
  type TelemetryChannel,
  type TelemetryProvenance,
  type TelemetrySeries,
  type TelemetryWindow,
} from '../api'
import {
  AMPS_CAPTION,
  METERING_MODE_LABEL,
  POLL_INTERVAL_MS,
  PROVENANCE_COPY,
  VOLTS_CAPTION,
  WATTS_CAPTION,
  WATTS_CAPTION_SIMULATED,
} from '../data/telemetry'
import type { Outlet, OutletStatus, Priority } from '../types/dashboard'
import { describeSeries, formatValue, histogram, stalenessState } from '../utils/telemetry'
import { RAIL_FILTERS, railLabel, railOf, type RailFilter } from './policyAdmin'

/**
 * Channel Inventory -- the sensor-facing half of the redesign (roadmap M2).
 *
 * It answers "what is every channel doing right now, and how confident am I in
 * the number?" Two sources, deliberately combined rather than replaced:
 *
 *   - GET /Dashboard/state gives the authoritative roster: priority, allowance,
 *     status, relay channel. It carries no per-channel volts or amps.
 *   - GET /Dashboard/telemetry supplies the V/A/W. Rather than add a new
 *     endpoint, the live figure is the last non-null bucket of a short window.
 *
 * The honesty constraint drives most of this file, and it is now enforced by
 * the card itself rather than only by a banner. A channel's `provenance` decides
 * how its watt figure is LABELLED and how its allowance meter is DRAWN:
 *
 *   Measured          solid meter fill, "Measured" dot + label
 *   DerivedNominal    hatched meter fill, "Derived / nominal" dot + label (CH5 USB: no CT)
 *   DerivedLoadShare  hatched meter fill, "Derived / load share" dot + label
 *   Simulated         hatched meter fill, "Simulated" dot + label
 *   Unknown           no fill at all, "No data" dot + label
 *
 * A derived number is never rendered as a measured one: the hatch, the wording
 * and the un-green provenance dot all say so at a glance, so a panelist asking
 * "is this measured?" gets the true answer without reading the banner.
 *
 * Density discipline: this grid renders exactly ONE tag per channel — its
 * status, which is the only genuinely stateful thing on the card. Rail, relay
 * and shed priority are static metadata and read as a muted line; provenance
 * reads as a coloured dot beside neutral text. Everything else on this screen
 * that used to be a chip is now plain text, so the only colours left are the
 * status dot, the hatch, and the allowance bar.
 *
 * Everything on this screen comes from the API. Nothing is hardcoded to the
 * mockup's 13-channel rig or its 2,500 W cap -- the real rig is 5 channels
 * (CH1-CH4 220 V mains, CH5 5 V USB) against whatever P_limit is configured.
 */

type Status = 'loading' | 'ready' | 'unauthorized' | 'error'

/** Short window: the inventory is a live view, not a trend view. */
const LIVE_WINDOW: TelemetryWindow = '15m'

/** Sampling period, reused from the telemetry view so both stay in step. */
const REFRESH_MS = POLL_INTERVAL_MS[LIVE_WINDOW] ?? 10_000

/** Bin count for the per-channel load distribution. */
const HISTOGRAM_BINS = 8

type SortId = 'load-desc' | 'load-asc' | 'id-asc' | 'priority'

const SORT_OPTIONS: Array<{ id: SortId; label: string }> = [
  { id: 'load-desc', label: 'Load: high to low' },
  { id: 'load-asc', label: 'Load: low to high' },
  { id: 'id-asc', label: 'Channel ID' },
  { id: 'priority', label: 'Protection priority' },
]

/**
 * Protection rank for the priority sort. The backend stores Priority as
 * Low=1..Critical=4; Critical is what the policy engine protects hardest, so it
 * sorts first regardless of how the enum happens to be numbered.
 */
const PRIORITY_RANK: Record<Priority, number> = {
  Critical: 0,
  High: 1,
  Medium: 2,
  Low: 3,
}

/**
 * How a channel's numbers must be presented. `measured` is the only thing that
 * unlocks a solid meter fill and the word "Measured" -- everything else is
 * visibly marked as inferred.
 *
 * The verdict is carried by a small coloured DOT plus NEUTRAL text, never by a
 * filled tag: a filled chip per card turned the grid into a fruit salad and
 * the colour carried no more information than the word next to it.
 *
 * "Measured" is the ordinary case, so its dot is the neutral outline token, not
 * the shared `ant-dot-normal` green. Green is not a state colour in this
 * console -- a meter-backed reading is the absence of a caveat, not a
 * celebration -- and amber/red stay reserved for derived and simulated data.
 */
type ProvenanceView = {
  label: string
  dotClass: string
  measured: boolean
  /** Long explanation, surfaced as the meter caption and title attribute. */
  note: string
}

const PROVENANCE_VIEWS: Record<TelemetryProvenance, ProvenanceView> = {
  Measured: {
    label: 'Measured',
    dotClass: 'ant-dot bg-outline-variant',
    measured: true,
    note: 'Read directly from a metering device on this branch.',
  },
  DerivedNominal: {
    label: 'Derived · nominal',
    dotClass: 'ant-dot ant-dot-warning',
    measured: false,
    note: 'Derived from the channel’s rated nominal rating. No meter is fitted on this branch.',
  },
  DerivedLoadShare: {
    label: 'Derived · load share',
    dotClass: 'ant-dot ant-dot-warning',
    measured: false,
    note: 'Derived as an allowance-weighted share of the measured total. Not a branch measurement.',
  },
  Simulated: {
    label: 'Simulated',
    dotClass: 'ant-dot ant-dot-critical',
    measured: false,
    note: 'Synthesised on the device. Nothing on this card was measured.',
  },
  Unknown: {
    label: 'No provenance',
    dotClass: 'ant-dot ant-dot-warning',
    measured: false,
    note: 'The device has not reported a provenance for this channel.',
  },
}

function provenanceView(provenance: TelemetryProvenance): ProvenanceView {
  return PROVENANCE_VIEWS[provenance] ?? PROVENANCE_VIEWS.Unknown
}

/**
 * Static metadata is neutral. A channel's rail, relay and shed priority are
 * facts about the channel, not verdicts about its health, so they are read as
 * one muted line. This is also what a 220 V rail and a 5 V USB rail need to be
 * told apart: they are labelled, not tinted. The line carries volts and rail
 * names, so it rides the mono metric token and its digits stay tabular.
 */
const METADATA_LINE = 'font-metric-value text-metric-value text-on-surface-variant'

/** Provenance labels are plain words, so they are body text, not figures. */
const PROVENANCE_LINE = 'font-body-sm text-body-sm text-on-surface-variant'

type StatusView = { label: string; tagClass: string }

/**
 * "Energized" is the default state and therefore the most common chip on the
 * grid. It wears the neutral surface tag rather than the shared green success
 * tag: green would make the ordinary case the loudest thing on screen. The
 * label still carries the state, and amber stays reserved for Standby and
 * Restricted.
 */
const NEUTRAL_TAG = 'ant-tag bg-surface-container text-on-surface-variant border-outline-variant'

const STATUS_VIEWS: Record<OutletStatus, StatusView> = {
  Active: {
    label: 'Energized',
    tagClass: NEUTRAL_TAG,
  },
  Standby: {
    label: 'Standby',
    tagClass: 'ant-tag ant-tag-warning',
  },
  Restricted: {
    label: 'Restricted',
    tagClass: 'ant-tag ant-tag-warning',
  },
  Disconnected: {
    label: 'Disconnected',
    tagClass: 'ant-tag bg-surface-container text-on-surface-variant border-outline-variant',
  },
}

type ChannelReading = {
  channel: TelemetryChannel
  volts: number | null
  amps: number | null
  watts: number | null
  /** Buckets carrying a real sample, out of the window's total. */
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

/** Last non-null value in a series, or null if the channel never reported. */
function lastValue(values: Array<number | null>): number | null {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const value = values[i]
    if (value !== null && Number.isFinite(value)) return value
  }
  return null
}

/** Join the roster (state) with the readings (telemetry) on outlet id. */
function joinChannels(outlets: Outlet[], series: TelemetrySeries | null): ChannelReading[] {
  return outlets.map((outlet) => {
    const channel =
      series?.channels.find((c) => c.outletId === outlet.id) ??
      UNKNOWN_CHANNEL(outlet.id, outlet.name, outlet.relay, outlet.volts)

    return {
      channel,
      volts: lastValue(channel.volts),
      amps: lastValue(channel.amps),
      watts: lastValue(channel.watts),
      coverage: describeSeries(channel.watts).count,
      total: series?.bucketCount ?? 0,
    }
  })
}

/**
 * formatValue, but null-tolerant. A channel with no sample in the window must read
 * as a dash, not as "0.0" — conflating a gap with zero load is exactly the error
 * this thesis is about not making.
 */
function fmt(value: number | null, unit: 'V' | 'A' | 'W'): string {
  return value === null ? '—' : formatValue(value, unit)
}

/**
 * Explicit decimal precision for every live readout on a card.
 *
 * The whole point of a metering console is that the digit is real, so none of
 * these fall back to JS default number rendering: `0.04` amps rendered as `0`
 * or `0.0` is the difference between a live reading and a rounded-away one, and
 * a 5 V USB branch draws single-digit milliamp currents that vanish entirely at
 * the default precision. A null is a GAP, so it prints as a dash and never as
 * a zero.
 */
function fmtVolts(value: number | null): string {
  return value === null ? '—' : value.toFixed(1)
}

/** Three places: the 5 V rail carries mA-scale current that 2 dp would hide. */
function fmtAmps(value: number | null): string {
  return value === null ? '—' : value.toFixed(3)
}

/** One place minimum — watts are the card's headline and must not be integerised. */
function fmtWatts(value: number | null): string {
  return value === null ? '—' : value.toFixed(1)
}

/** One place, used for the allowance share and any other ratio on the card. */
function fmtPercent(value: number): string {
  return `${value.toFixed(1)}%`
}

/**
 * Band edges on the distribution axis. Small ranges keep their decimal because
 * a 4.8 W to 5.0 W band is the whole story on the USB rail; once the numbers
 * are in the hundreds the tenth is noise and costs width inside a card.
 */
function bandEdge(value: number): string {
  return value.toFixed(Math.abs(value) < 100 ? 1 : 0)
}

type DistributionCell = {
  index: number
  count: number
  /** The modal bin: the only one drawn in solid primary. */
  peak: boolean
  /** Tooltip text — the per-bin story, sample count plus band range in W. */
  title: string
  /** Axis text. Empty means "this column draws no label", which keeps the
   *  three anchors (min, modal band, max) aligned to the bars they describe. */
  label: string
}

type DistributionChart = {
  cells: DistributionCell[]
  /** Tallest bin — every bar is a fraction of this. */
  tallest: number
  /** Samples in the window that carried a watt reading. */
  total: number
  /** Share of samples sitting in the modal band, as a percentage. */
  peakShare: number
}

/**
 * Per-channel load distribution, in the same grammar as the Telemetry view's
 * "Aggregate load distribution": bars grow from one shared baseline and scale
 * to the modal bin, which is the only bin drawn in solid primary while the rest
 * wear the lighter primary tint. Empty bins draw NO bar at all — a stub of any
 * height on a zero-sample bin reads as data that is not there, which is the
 * exact opposite of what a distribution is for.
 *
 * Only three axis labels are drawn (minimum, modal band, maximum) so the axis
 * stays readable at card width instead of becoming eight overlapping numbers.
 */
function buildDistribution(
  values: Array<number | null>,
  binCount: number,
): DistributionChart | null {
  const hist = histogram(values, binCount)
  if (!hist) return null

  const counts = hist.counts
  const total = counts.reduce((sum, count) => sum + count, 0)
  if (total === 0) return null

  const tallest = counts.reduce((max, count) => (count > max ? count : max), 0)
  const peakIndex = counts.reduce((best, count, index) => (count > counts[best] ? index : best), 0)
  // A flat series (a nominal 5 V rail) collapses to a single zero-width band;
  // every edge is the same number, so there is only ever one label to draw.
  const binWidth = (hist.max - hist.min) / counts.length
  const peakLower = hist.min + peakIndex * binWidth
  const peakUpper = peakLower + binWidth
  const lastIndex = counts.length - 1

  const cells: DistributionCell[] = counts.map((count, index) => {
    const lower = hist.min + index * binWidth
    const upper = lower + binWidth
    const isPeak = index === peakIndex

    let label = ''
    if (binWidth === 0) {
      label = `${bandEdge(hist.min)} W`
    } else if (isPeak) {
      label = `${bandEdge(peakLower)}–${bandEdge(peakUpper)} W`
    } else if (index === 0) {
      label = `${bandEdge(hist.min)} W`
    } else if (index === lastIndex) {
      label = `${bandEdge(hist.max)} W`
    }

    return {
      index,
      count,
      peak: isPeak,
      title: `${count} sample${count === 1 ? '' : 's'} · ${bandEdge(lower)}–${bandEdge(upper)} W`,
      label,
    }
  })

  return { cells, tallest, total, peakShare: (counts[peakIndex] / total) * 100 }
}

/**
 * Overlay applied to a meter fill whose value is DERIVED rather than measured.
 * A solid bar reads as a measurement; a hatched one reads as an inference. The
 * hatch is the visual half of the honesty constraint.
 */
const DERIVED_HATCH =
  'repeating-linear-gradient(135deg, rgba(255,255,255,0.62) 0 3px, rgba(255,255,255,0) 3px 7px)'

const STATE_SHELL =
  'flex flex-col gap-3 px-margin py-space-lg max-w-3xl'

/** The eyebrow above a page title in the three pre-data shells. */
const SHELL_EYEBROW = 'font-body-sm text-body-sm text-on-surface-variant'

export function ChannelInventoryView() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null)
  const [series, setSeries] = useState<TelemetrySeries | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [railFilter, setRailFilter] = useState<RailFilter>('all')
  const [sort, setSort] = useState<SortId>('load-desc')
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  // Drives the relative-time pill only; never triggers a refetch.
  const [now, setNow] = useState(() => Date.now())

  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(async (isRefresh: boolean) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    if (isRefresh) setRefreshing(true)

    try {
      // State first: the roster is what makes the grid render at all, and it
      // carries policy fields that telemetry has no opinion about.
      const state = await fetchDashboardState()
      const telemetry = await fetchTelemetrySeries(LIVE_WINDOW, undefined, controller.signal)
      setSnapshot(state)
      setSeries(telemetry)
      setStatus('ready')
      setError(null)
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return
      if (cause instanceof ApiError && cause.status === 401) {
        setStatus('unauthorized')
        return
      }
      setError(cause instanceof ApiError && cause.status === 0 ? 'Backend unreachable' : String(cause))
      // Keep the last good grid on screen through a transient failure.
      setStatus((current) => (current === 'ready' ? 'ready' : 'error'))
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void load(false)
    const timer = window.setInterval(() => {
      // Paused rather than abandoned when hidden, for the same reason
      // TelemetryView does it: the host sleeps, so don't spend its wake budget.
      if (!document.hidden) void load(true)
    }, REFRESH_MS)
    return () => {
      window.clearInterval(timer)
      abortRef.current?.abort()
    }
  }, [load])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  if (status === 'unauthorized') {
    return (
      <section className="design-main" aria-label="Channel Inventory">
        <div className={STATE_SHELL}>
          <div>
            <p className={SHELL_EYEBROW}>Channel Inventory</p>
            <h1 className="font-headline-md text-headline-md text-on-surface">Session expired</h1>
          </div>
          <div className="ant-card p-space-lg">
            <p className="font-body-md text-body-md text-on-surface-variant">
              Sign in again to view the sensor inventory.
            </p>
          </div>
        </div>
      </section>
    )
  }

  if (status === 'error') {
    return (
      <section className="design-main" aria-label="Channel Inventory">
        <div className={STATE_SHELL}>
          <div>
            <p className={SHELL_EYEBROW}>Channel Inventory</p>
            <h1 className="font-headline-md text-headline-md text-on-surface">Inventory unavailable</h1>
          </div>
          <div className="ant-card p-space-lg flex gap-space-sm">
            <AlertTriangle size={18} className="shrink-0 mt-0.5 text-error" aria-hidden />
            <p className="font-body-md text-body-md text-on-surface-variant">
              {error ?? 'The dashboard state could not be loaded.'} This view needs both{' '}
              <code className="font-metric-value text-metric-value">/Dashboard/state</code> and{' '}
              <code className="font-metric-value text-metric-value">/Dashboard/telemetry</code> to be
              reachable.
            </p>
          </div>
        </div>
      </section>
    )
  }

  if (!snapshot) {
    return (
      <section className="design-main" aria-label="Channel Inventory">
        <div className={STATE_SHELL}>
          <div>
            <p className={SHELL_EYEBROW}>Channel Inventory</p>
            <h1 className="font-headline-md text-headline-md text-on-surface">Loading channels</h1>
          </div>
          <div className="ant-card p-space-lg flex items-center gap-space-sm">
            <RefreshCw size={16} className="animate-spin motion-reduce:animate-none text-primary" aria-hidden />
            <p className="font-body-md text-body-md text-on-surface-variant">
              Reading the device roster and the latest samples…
            </p>
          </div>
        </div>
      </section>
    )
  }

  const readings = joinChannels(snapshot.outlets, series)
  const byId = new Map(snapshot.outlets.map((o) => [o.id, o]))

  // Rail and text filters are applied at render time only: they are view
  // concerns, so the telemetry fetch stays independent of them and the
  // segmented counts below always describe the whole rig.
  const railCountsByFilter: Record<RailFilter, number> = {
    all: readings.length,
    '220': 0,
    '110': 0,
    '5': 0,
  }
  for (const reading of readings) {
    railCountsByFilter[railOf(reading.channel.ratedVoltageVolts)] += 1
  }

  const normalizedQuery = query.trim().toLowerCase()

  const visibleReadings = readings
    .filter((reading) => {
      if (railFilter !== 'all' && railOf(reading.channel.ratedVoltageVolts) !== railFilter) {
        return false
      }
      if (!normalizedQuery) return true
      const outlet = byId.get(reading.channel.outletId)
      const haystack = [
        `ch${String(reading.channel.outletId).padStart(2, '0')}`,
        outlet?.name ?? '',
        reading.channel.name,
        reading.channel.relayChannel,
        reading.channel.provenance,
        outlet?.status ?? '',
        outlet?.priority ?? '',
        railLabel(reading.channel.ratedVoltageVolts),
      ]
        .join(' ')
        .toLowerCase()
      return haystack.includes(normalizedQuery)
    })
    .sort((a, b) => {
      const outletA = byId.get(a.channel.outletId)
      const outletB = byId.get(b.channel.outletId)
      switch (sort) {
        case 'load-desc':
          return (b.watts ?? -1) - (a.watts ?? -1)
        case 'load-asc':
          return (a.watts ?? Infinity) - (b.watts ?? Infinity)
        case 'id-asc':
          return a.channel.outletId - b.channel.outletId
        case 'priority':
          return (
            PRIORITY_RANK[outletA?.priority ?? 'Low'] - PRIORITY_RANK[outletB?.priority ?? 'Low']
          )
        default:
          return 0
      }
    })

  const energizedCount = snapshot.outlets.filter((o) => o.status === 'Active').length
  const totalWatts = snapshot.outlets.reduce((sum, outlet) => sum + (outlet.watts || 0), 0)
  const capacity = snapshot.thresholds.max
  const loadPercent = capacity > 0 ? (totalWatts / capacity) * 100 : 0
  const mode = series?.meteringMode ?? 'Unknown'
  const provenance = PROVENANCE_COPY[mode] ?? PROVENANCE_COPY.Unknown
  const freshness = stalenessState(series?.latestSampleAt ?? null, now, snapshot.deviceOnline)

  // Mains voltage is the single metered AC figure in the rig; CH5's 5 V rail has
  // no meter, so it is deliberately excluded rather than averaged in.
  const mainsReading = readings.find((r) => railOf(r.channel.ratedVoltageVolts) === '220')
  const mainsVolts = mainsReading?.volts ?? null
  const mainsProvenance = provenanceView(mainsReading?.channel.provenance ?? 'Unknown')
  // Aggregate current is arithmetic on a derived total, so it is labelled as
  // derived on screen rather than presented alongside the measured cards.
  const aggregateAmps =
    mainsVolts !== null && mainsVolts > 0 && !mainsProvenance.measured ? null : mainsVolts && totalWatts / mainsVolts

  const filtersActive = railFilter !== 'all' || normalizedQuery.length > 0

  return (
    <section className="design-main" aria-label="Channel Inventory">
      {/* --- Breadcrumb ------------------------------------------------------ */}
      <nav aria-label="Breadcrumb" className="flex items-center gap-space-sm mb-space-sm">
        <span className="font-body-sm text-body-sm text-on-surface-variant">Dashboard</span>
        <span className="font-body-sm text-body-sm text-outline-variant" aria-hidden>
          /
        </span>
        <strong className="font-body-sm text-body-sm font-semibold text-on-surface">Channels</strong>
      </nav>

      {/* --- Page head ------------------------------------------------------- */}
      <header className="flex flex-col lg:flex-row lg:items-center justify-between gap-space-md mb-space-lg">
        <div className="flex flex-col gap-0.5 min-w-0">
          <h1 className="font-headline-md text-headline-md text-on-surface flex items-center gap-space-sm flex-wrap">
            <span>Channel Inventory &amp; Sensor Matrix</span>
            <span className="inline-flex items-center gap-1.5 font-body-sm text-body-sm text-on-surface-variant">
              <span
                className="ant-dot bg-outline-variant animate-pulse motion-reduce:animate-none"
                aria-hidden
              />
              Live stream
            </span>
          </h1>
          <p className="font-body-md text-body-md text-on-surface-variant">
            <span className="font-metric-value text-metric-value">{readings.length}</span> monitored
            channel{readings.length === 1 ? '' : 's'} across the 220V AC and 5V DC rails of this rig
          </p>
        </div>

        <div className="flex items-center gap-space-md shrink-0">
          <span
            className={`inline-flex items-center gap-1.5 font-body-sm text-body-sm ${
              freshness.tone === 'fresh'
                ? 'text-on-surface-variant'
                : freshness.tone === 'delayed'
                  ? 'text-tertiary-container'
                  : 'text-error'
            }`}
            role="status"
            aria-live="off"
          >
            <span
              className={`ant-dot ${
                freshness.tone === 'fresh'
                  ? 'bg-outline-variant'
                  : freshness.tone === 'delayed'
                    ? 'ant-dot-warning'
                    : 'ant-dot-critical'
              }`}
              aria-hidden
            />
            {freshness.label}
          </span>
          <button
            type="button"
            className="ant-btn ant-btn-primary"
            onClick={() => void load(true)}
            disabled={refreshing}
          >
            <RefreshCw
              size={16}
              aria-hidden
              className={refreshing ? 'animate-spin motion-reduce:animate-none' : undefined}
            />
            {refreshing ? 'Refreshing…' : 'Refresh Telemetry'}
          </button>
        </div>
      </header>

      {/* --- Provenance banner ---------------------------------------------- */}
      <section
        className={`ant-card p-space-md mb-space-lg flex items-start gap-space-sm border-l-4 ${
          // Only a simulated mode is a fault worth a red rail. "Metered" is the
          // good case and used to wear green; it is now the neutral outline like
          // every other untroubled banner edge.
          mode === 'Simulated' ? 'border-l-error' : 'border-l-outline'
        }`}
        aria-label="Metering mode"
      >
        <AlertTriangle
          size={18}
          aria-hidden
          className={`shrink-0 mt-0.5 ${
            mode === 'Simulated' ? 'text-error' : mode === 'Metered' ? 'text-on-surface-variant' : 'text-outline'
          }`}
        />
        <div className="min-w-0">
          <p className="font-title-md text-title-md text-on-surface">
            {`Metering mode: ${METERING_MODE_LABEL[mode] ?? mode}`}
          </p>
          <p className="font-body-sm text-body-sm text-on-surface-variant mt-0.5">
            {provenance.banner}
          </p>
        </div>
      </section>

      {/* --- Stat strip ------------------------------------------------------
          Total active load is the one hero figure on this view and the only
          card that wears metric-display. Mains voltage, aggregate current and
          the energised relay count are peer readings at metric-value: they are
          three facts the operator checks, not three headlines. */}
      <section
        className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-space-md mb-space-lg"
        aria-label="Inventory summary"
      >
        {/* 1. Total load — the one meter-backed figure on the rig. */}
        <article className="ant-card flex flex-col justify-between gap-space-sm">
          <div className="ant-card-body p-space-md flex flex-col h-full">
            <div className="flex items-center justify-between gap-space-sm">
              <span className="font-body-sm text-body-sm text-on-surface-variant">Total Active Load</span>
              <span
                className={`font-metric-value text-metric-value font-semibold ${
                  loadPercent >= 100
                    ? 'text-error'
                    : loadPercent >= 85
                      ? 'text-tertiary-container'
                      : 'text-on-surface-variant'
                }`}
              >
                {`${loadPercent.toFixed(0)}% load`}
              </span>
            </div>
            <p className="font-metric-display text-metric-display text-on-surface flex items-baseline gap-1">
              {Math.round(totalWatts).toLocaleString()}
              <span className="font-metric-value text-metric-value font-semibold text-on-surface-variant">
                W
              </span>
            </p>
            <div className="ant-meter mt-auto" role="presentation">
              <div
                className={`ant-meter-fill ${
                  // Below warning is a measurement, not a health verdict, so the
                  // fill wears the measurement blue rather than a green "all good".
                  loadPercent >= 100 ? 'bg-error' : loadPercent >= 85 ? 'bg-tertiary' : 'bg-primary'
                }`}
                style={{ width: `${Math.min(100, loadPercent)}%` }}
              />
            </div>
            <p className="font-metric-value text-metric-value text-on-surface-variant">
              {`Cap ${capacity.toLocaleString()} W · Headroom ${Math.max(
                0,
                Math.round(capacity - totalWatts),
              ).toLocaleString()} W`}
            </p>
            <p className="font-metric-value text-metric-value text-outline">
              {`Warn ${snapshot.thresholds.warning.toLocaleString()} W · Crit ${snapshot.thresholds.critical.toLocaleString()} W`}
            </p>
          </div>
        </article>

        {/* 2. Mains RMS voltage — the only per-branch measurement in the rig. */}
        <article className="ant-card flex flex-col">
          <div className="ant-card-body p-space-md flex flex-col h-full gap-space-sm">
            <div className="flex items-center justify-between gap-space-sm">
              <span className="font-body-sm text-body-sm text-on-surface-variant">Mains RMS Voltage</span>
              <span
                className={`inline-flex items-center gap-1.5 ${PROVENANCE_LINE}`}
                title={mainsProvenance.note}
              >
                <span className={mainsProvenance.dotClass} aria-hidden />
                {mainsProvenance.label}
              </span>
            </div>
            <p className="font-metric-value text-metric-value text-on-surface flex items-baseline gap-1">
              {fmt(mainsVolts, 'V')}
              <span className="font-metric-value text-metric-value font-semibold text-on-surface-variant">
                V RMS
              </span>
            </p>
            <p className="font-metric-value text-metric-value text-on-surface-variant mt-auto">
              {`${railCountsByFilter['220']} channel${railCountsByFilter['220'] === 1 ? '' : 's'} on the 220 V common feed`}
            </p>
            <p className="font-body-sm text-body-sm text-outline">{mainsProvenance.note}</p>
          </div>
        </article>

        {/* 3. Aggregated current — arithmetic, so it is labelled as derived. */}
        <article className="ant-card flex flex-col">
          <div className="ant-card-body p-space-md flex flex-col h-full gap-space-sm">
            <div className="flex items-center justify-between gap-space-sm">
              <span className="font-body-sm text-body-sm text-on-surface-variant">Aggregated Current</span>
              <span className={`inline-flex items-center gap-1.5 ${PROVENANCE_LINE}`}>
                <span className="ant-dot ant-dot-warning" aria-hidden />
                Derived
              </span>
            </div>
            <p className="font-metric-value text-metric-value text-on-surface flex items-baseline gap-1">
              {aggregateAmps === null ? '—' : aggregateAmps.toFixed(2)}
              <span className="font-metric-value text-metric-value font-semibold text-on-surface-variant">
                A
              </span>
            </p>
            <p className="font-metric-value text-metric-value text-on-surface-variant mt-auto">
              {aggregateAmps === null
                ? 'Needs a mains voltage reading'
                : `P ÷ V = ${totalWatts.toFixed(0)} W ÷ ${fmt(mainsVolts, 'V')} V`}
            </p>
            <p className="font-metric-value text-metric-value text-outline">
              {mainsReading ? `Derived from CH${String(mainsReading.channel.outletId).padStart(2, '0')} mains voltage` : 'No mains channel'}
            </p>
          </div>
        </article>

        {/* 4. Energization — pure roster state, no inference at all. */}
        <article className="ant-card flex flex-col">
          <div className="ant-card-body p-space-md flex flex-col h-full gap-space-sm">
            <div className="flex items-center justify-between gap-space-sm">
              <span className="font-body-sm text-body-sm text-on-surface-variant">Active Relays</span>
              <span
                className={`inline-flex items-center gap-1.5 font-body-sm text-body-sm font-semibold ${
                  snapshot.deviceOnline ? 'text-on-surface-variant' : 'text-tertiary-container'
                }`}
              >
                <span
                  className={`ant-dot ${snapshot.deviceOnline ? 'bg-outline-variant' : 'ant-dot-warning'}`}
                  aria-hidden
                />
                {snapshot.deviceOnline ? 'Online' : 'Offline'}
              </span>
            </div>
            <p className="font-metric-value text-metric-value text-on-surface flex items-baseline gap-1.5">
              <span className="font-metric-value text-metric-value">{energizedCount}</span>
              <span className="font-body-md text-body-md font-normal text-on-surface-variant">
                / {readings.length} Energized
              </span>
            </p>
            <p className="font-metric-value text-metric-value text-on-surface-variant mt-auto">
              {`Window ${series?.windowLabel ?? '—'} · ${series?.rawSampleCount ?? 0} raw rows`}
            </p>
            <p className="font-metric-value text-metric-value text-outline">
              {`${readings.length - energizedCount} standby / off`}
            </p>
          </div>
        </article>
      </section>

      {/* --- Filter & operation toolbar -------------------------------------- */}
      <section
        className="ant-card p-space-sm mb-space-lg flex flex-col md:flex-row md:items-center justify-between gap-space-md"
        aria-label="Filter channels"
      >
        <div className="ant-segmented overflow-x-auto max-w-full self-start md:self-auto" role="group" aria-label="Filter by rail">
          {RAIL_FILTERS.map((filter) => (
            <button
              key={filter.id}
              type="button"
              aria-pressed={railFilter === filter.id}
              onClick={() => setRailFilter(filter.id)}
              className={`ant-segmented-item ${
                railFilter === filter.id ? 'ant-segmented-item-active text-primary font-semibold' : ''
              }`}
            >
              {`${filter.label} (${railCountsByFilter[filter.id]})`}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-space-sm flex-wrap sm:flex-nowrap">
          <div className="relative flex items-center min-w-[200px] w-full sm:w-auto">
            <Search
              size={16}
              aria-hidden
              className="absolute left-2.5 pointer-events-none text-on-surface-variant"
            />
            <input
              type="text"
              className="ant-input pl-8 font-body-sm text-body-sm"
              placeholder="Filter channels, relay, rail…"
              aria-label="Search channels"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          <div className="relative shrink-0">
            <select
              className="h-8 pl-2.5 pr-7 font-body-sm text-body-sm rounded-md bg-surface-container-lowest text-on-surface border border-outline-variant shadow-sm outline-none cursor-pointer appearance-none focus:border-primary"
              aria-label="Sort channels"
              value={sort}
              onChange={(event) => setSort(event.target.value as SortId)}
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {`Sort: ${option.label}`}
                </option>
              ))}
            </select>
            <ChevronDown
              size={16}
              aria-hidden
              className="absolute right-2 top-2 pointer-events-none text-on-surface-variant"
            />
          </div>

          {filtersActive && (
            <button
              type="button"
              className="ant-btn ant-btn-default"
              onClick={() => {
                setRailFilter('all')
                setQuery('')
              }}
            >
              <X size={16} aria-hidden />
              Clear
            </button>
          )}
        </div>
      </section>

      {/* --- Result count ---------------------------------------------------- */}
      <p className="font-metric-value text-metric-value text-on-surface-variant mb-space-sm" aria-live="polite">
        {`Showing ${visibleReadings.length} of ${readings.length} channels`}
        {filtersActive ? ' · filtered' : ''}
      </p>

      {visibleReadings.length === 0 ? (
        <section className="ant-card p-space-lg mb-space-lg flex flex-col items-start gap-space-md">
          <div className="flex items-center gap-space-sm">
            <Search size={18} className="text-outline" aria-hidden />
            <h2 className="font-title-lg text-title-lg text-on-surface">No channels match</h2>
          </div>
          <p className="font-body-md text-body-md text-on-surface-variant">
            Nothing on this rig matches{' '}
            {normalizedQuery ? <span className="font-body-sm text-body-sm">&ldquo;{query.trim()}&rdquo;</span> : 'this rail'}
            . Clear the filters to see all {readings.length} channels.
          </p>
          <button
            type="button"
            className="ant-btn ant-btn-primary"
            onClick={() => {
              setRailFilter('all')
              setQuery('')
            }}
          >
            <X size={16} aria-hidden />
            Clear filters
          </button>
        </section>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-space-md mb-space-lg">
          {visibleReadings.map((reading) => {
            const outlet = byId.get(reading.channel.outletId)
            const statusView = STATUS_VIEWS[outlet?.status ?? 'Disconnected']
            const view = provenanceView(reading.channel.provenance)
            const stats = describeSeries(reading.channel.watts)
            // The distribution is the same chart grammar as the Telemetry view's
            // aggregate load distribution, scaled to card width. It returns null
            // when a channel reported nothing in the window, so a dead branch has
            // no chart frame at all rather than an empty one.
            const chart = buildDistribution(reading.channel.watts, HISTOGRAM_BINS)

            const allowance = outlet?.allowance ?? 0
            const hasAllowance = allowance > 0
            const hasReading = reading.watts !== null
            const rawPercent = hasAllowance && hasReading ? (reading.watts! / allowance) * 100 : 0
            const overAllowance = rawPercent > 100
            const usedPercent = Math.min(100, rawPercent)

            // Fill colour encodes headroom; the hatch encodes derivation. Both
            // must be present for the bar to read as a measurement.
            const fillColor = overAllowance
              ? 'bg-error'
              : rawPercent >= 85
                ? 'bg-tertiary'
                : view.measured
                  ? 'bg-primary'
                  : 'bg-tertiary'

            return (
              <article
                key={reading.channel.outletId}
                className="ant-card p-space-md flex flex-col gap-space-sm"
                aria-label={`${outlet?.name ?? reading.channel.name} · ${statusView.label}`}
              >
                {/* Header: identity plus the ONE stateful chip on the card. Status
                    is the only thing here that is a verdict about the plant rather
                    than a fact about the channel. */}
                <header className="flex items-start justify-between gap-space-sm">
                  <span className="font-metric-value text-metric-value font-semibold text-on-surface">
                    {`CH${String(reading.channel.outletId).padStart(2, '0')}`}
                  </span>
                  <span className={`${statusView.tagClass} shrink-0`}>{statusView.label}</span>
                </header>

                <div className="min-w-0">
                  <h3
                    className="font-title-lg text-title-lg text-on-surface truncate"
                    title={outlet?.name ?? reading.channel.name}
                  >
                    {outlet?.name ?? reading.channel.name}
                  </h3>
                  {/* Rail and shed priority are static metadata, so they share one
                      neutral line instead of each earning a chip. */}
                  <p
                    className={`${METADATA_LINE} truncate`}
                    title="Shed order: Low priority is shed first"
                  >
                    {`${railLabel(reading.channel.ratedVoltageVolts)} · Priority: ${outlet?.priority ?? 'Unknown'}`}
                  </p>
                </div>

                {/* Core live matrix: V / A / W. Units are in the label, not
                    duplicated after the figure, so the column stays scannable.
                    Every figure here is a live sample that updates while the
                    operator watches, so all three ride the tabular metric
                    token — a proportional digit would jitter on every poll. */}
                <div className="grid grid-cols-3 gap-1 bg-surface-container-low rounded-md py-2 px-1 text-center">
                  <div>
                    <div className="font-body-sm text-body-sm uppercase tracking-wide text-on-surface-variant">Voltage</div>
                    <div className="font-metric-value text-metric-value font-semibold text-on-surface">
                      {`${fmtVolts(reading.volts)} V`}
                    </div>
                  </div>
                  <div>
                    <div className="font-body-sm text-body-sm uppercase tracking-wide text-on-surface-variant">Current</div>
                    <div
                      className={`font-metric-value text-metric-value font-semibold ${
                        reading.amps === null ? 'text-on-surface-variant' : 'text-on-surface'
                      }`}
                    >
                      {`${fmtAmps(reading.amps)} A`}
                    </div>
                  </div>
                  <div>
                    <div className="font-body-sm text-body-sm uppercase tracking-wide text-on-surface-variant">Power</div>
                    <div
                      className={`font-metric-value text-metric-value font-semibold ${
                        hasReading ? (overAllowance ? 'text-error' : 'text-on-surface') : 'text-on-surface-variant'
                      }`}
                    >
                      {`${fmtWatts(reading.watts)} W`}
                    </div>
                  </div>
                </div>

                {/* Load allowance. The provenance that decides whether this bar is solid or
                    hatched lives in the footer, so this line stays two figures and
                    one ratio — the only numbers a load meter needs to be read. */}
                <div>
                  <div className="flex justify-between items-baseline gap-2 mb-1">
                    <span className="font-metric-value text-metric-value text-on-surface-variant truncate">
                      {hasReading && hasAllowance
                        ? `${fmtWatts(reading.watts)} W of ${fmtWatts(allowance)} W allowance`
                        : hasAllowance
                          ? `Allowance ${fmtWatts(allowance)} W · no sample in window`
                          : 'No allowance set'}
                    </span>
                    <span
                      className={`font-metric-value text-metric-value font-semibold shrink-0 ${
                        overAllowance
                          ? 'text-error'
                          : rawPercent >= 85
                            ? 'text-tertiary-container'
                            : 'text-on-surface-variant'
                      }`}
                    >
                      {hasReading && hasAllowance ? fmtPercent(rawPercent) : '—'}
                    </span>
                  </div>
                  <div
                    className="ant-meter"
                    role="meter"
                    aria-valuenow={hasReading && hasAllowance ? Math.round(rawPercent) : undefined}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`Allowance used — ${view.label}`}
                  >
                    <div
                      className={`ant-meter-fill ${fillColor}`}
                      style={{
                        width: `${hasReading ? usedPercent : 0}%`,
                        backgroundImage: view.measured ? undefined : DERIVED_HATCH,
                      }}
                    />
                  </div>
                  {overAllowance && (
                    <p className="font-metric-value text-metric-value text-error mt-1">
                      {`Over allowance by ${fmtPercent(rawPercent - 100)}`}
                    </p>
                  )}
                </div>

                {/* Window statistics, folded into ONE line instead of a second
                    four-up grid. Gaps are skipped, never read as zero, and every
                    figure is rendered at 1 dp so a quiet channel still shows the
                    spread it actually had. */}
                <p className="flex flex-wrap items-baseline gap-x-3 font-body-sm text-body-sm text-on-surface-variant">
                  {(
                    [
                      ['Min', stats.min],
                      ['Mean', stats.mean],
                      ['Max', stats.max],
                      ['σ', stats.stddev],
                    ] as const
                  ).map(([label, value]) => (
                    <span key={label} className="whitespace-nowrap">
                      {label}
                      <span className="ml-1 font-metric-value text-metric-value text-on-surface">
                        {fmtWatts(value)}
                      </span>
                    </span>
                  ))}
                </p>

                {/* Distribution over the window — the Telemetry view's chart,
                    scaled to a card. Bars rise from a shared baseline rule and
                    scale to the modal bin; the modal bin wears solid primary, the
                    other populated bins wear the lighter primary tint, and an
                    empty bin wears nothing at all. The baseline rule plus the
                    absent bars are what make a gap read as "nothing in this
                    band" rather than as a short sample. */}
                {chart && (
                  <figure className="m-0 flex flex-col gap-1">
                    <div
                      className="flex h-20 items-end gap-1 border-b border-outline-variant"
                      role="img"
                      aria-label={`Power distribution across ${chart.total} samples in the window. Modal band holds ${fmtPercent(chart.peakShare)} of them.`}
                    >
                      {chart.cells.map((cell) => (
                        <div
                          key={cell.index}
                          className="flex h-full flex-1 items-end"
                          title={cell.title}
                        >
                          {cell.count > 0 && (
                            <div
                              className={`w-full rounded-t transition-[height] duration-300 motion-reduce:transition-none ${
                                cell.peak ? 'bg-primary' : 'bg-primary-fixed-dim'
                              }`}
                              style={{ height: `${(cell.count / chart.tallest) * 100}%` }}
                            />
                          )}
                        </div>
                      ))}
                    </div>

                    {/* Three anchors only — minimum, modal band, maximum. They sit
                        in the same flex track as the bars, so each label is
                        genuinely under the column it describes rather than floated
                        on a shared justify-between. */}
                    <div className="flex gap-1">
                      {chart.cells.map((cell) => (
                        <span
                          key={cell.index}
                          className={`min-w-0 flex-1 whitespace-nowrap text-center font-metric-value text-metric-value ${
                            cell.peak ? 'font-semibold text-primary' : 'text-outline'
                          }`}
                        >
                          {cell.label}
                        </span>
                      ))}
                    </div>

                    <figcaption className="flex items-baseline justify-between gap-2 font-body-sm text-body-sm text-on-surface-variant">
                      <span>Load distribution</span>
                      <span className="font-metric-value text-metric-value text-outline">
                        {`${chart.total} sample${chart.total === 1 ? '' : 's'} · modal band ${fmtPercent(chart.peakShare)}`}
                      </span>
                    </figcaption>
                  </figure>
                )}

                {/* Footer: provenance as a dot plus neutral text — never a filled
                    chip — and sample coverage. The API's provenanceNote is kept
                    verbatim and clamped to one line: the backend owns that wording,
                    and a paragraph here pushed the card past 400 px. */}
                <footer className="mt-auto pt-2 border-t border-outline-variant flex items-center justify-between gap-2">
                  <span
                    className={`inline-flex min-w-0 items-center gap-1.5 ${PROVENANCE_LINE}`}
                    title={reading.channel.provenanceNote || view.note}
                  >
                    <span className={`${view.dotClass} shrink-0`} aria-hidden />
                    <span className="truncate">
                      {view.label}
                      <span className="text-outline"> · {reading.channel.provenanceNote}</span>
                    </span>
                  </span>
                  <span className="shrink-0 font-metric-value text-metric-value text-on-surface-variant">
                    <Gauge size={12} className="inline -mt-0.5 mr-1" aria-hidden />
                    {`${reading.coverage}/${reading.total} buckets`}
                  </span>
                </footer>
              </article>
            )
          })}
        </div>
      )}

      {/* --- Footer state: what these numbers are, and are not ---------------- */}
      <section className="ant-card mb-space-lg" aria-label="Reading provenance">
        <div className="ant-card-header px-space-md py-space-sm">
          <div className="flex items-center gap-space-sm">
            <Info size={16} className="text-on-surface-variant" aria-hidden />
            <h2 className="font-title-lg text-title-lg text-on-surface">What these numbers are, and are not</h2>
          </div>
          <span className="font-body-sm text-body-sm text-on-surface-variant">
            {`Mode: ${METERING_MODE_LABEL[mode] ?? mode}`}
          </span>
        </div>
        <div className="ant-card-body p-space-md">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-space-md mb-space-md">
            <article>
              <strong className="font-title-md text-title-md text-on-surface">Volts</strong>
              <p className="font-body-sm text-body-sm text-on-surface-variant mt-0.5">{VOLTS_CAPTION}</p>
            </article>
            <article>
              <strong className="font-title-md text-title-md text-on-surface">Amps</strong>
              <p className="font-body-sm text-body-sm text-on-surface-variant mt-0.5">{AMPS_CAPTION}</p>
            </article>
            <article>
              <strong className="font-title-md text-title-md text-on-surface">Watts</strong>
              <p className="font-body-sm text-body-sm text-on-surface-variant mt-0.5">
                {mode === 'Simulated' ? WATTS_CAPTION_SIMULATED : WATTS_CAPTION}
              </p>
            </article>
          </div>

          <div className="flex items-start gap-space-sm p-space-sm bg-surface-container-low rounded-md">
            <ShieldCheck size={16} className="shrink-0 mt-0.5 text-on-surface-variant" aria-hidden />
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              A <strong className="text-on-surface">solid</strong> allowance bar means the figure came
              from a meter. A <strong className="text-on-surface">hatched</strong> bar means the figure
              was inferred — no meter is fitted on that branch. Live figures are the most recent
              non-null bucket of the {series?.windowLabel ?? '15 min'} window; min / mean / max / σ
              cover that same window, skipping gaps rather than treating them as zero. This view is a
              live snapshot — the trend charts and the longer windows (up to 7 days) are on the
              Telemetry tab.
            </p>
          </div>

          <p className="font-metric-value text-metric-value text-outline mt-space-sm flex items-center gap-1.5">
            <BarChart3 size={12} aria-hidden />
            {`${readings.length} channels in roster · ${series?.channels.length ?? 0} reporting telemetry · ${series?.truncated ? 'series truncated' : 'series complete'}`}
          </p>
        </div>
      </section>
    </section>
  )
}