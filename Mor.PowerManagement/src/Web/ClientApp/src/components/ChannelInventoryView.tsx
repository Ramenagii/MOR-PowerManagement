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
  TriangleAlert,
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
  NOT_MEASURED,
  POLL_INTERVAL_MS,
  PROVENANCE_COPY,
  SHARED_VOLTS_NOTE,
  VOLTS_CAPTION,
  WATTS_CAPTION,
  WATTS_CAPTION_SIMULATED,
} from '../data/telemetry'
import type { Outlet, OutletStatus, Priority } from '../types/dashboard'
import {
  aggregatedCurrent,
  describeSeries,
  formatValue,
  histogram,
  lastPresent,
  loadVerdict,
  stalenessState,
} from '../utils/telemetry'
import { detectSensorFault, faultConsequence, type SensorFault } from '../utils/sensorFault'
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
 * THE THIRD STATE.
 *
 * `Measured` is the API's word for what the firmware intends to do, and it is
 * what the backend returns for CH1-CH4 even while the device is latched in a
 * hardware fault and posting a confident 0.0 A on every branch. When the event
 * log says the device isolated itself, "measured" stops being a claim the
 * console is entitled to repeat — not because the backend is wrong about its
 * own routing, but because a sensor that is not answering produces exactly the
 * number a working sensor produces when nothing is plugged in.
 *
 * So this view downgrades the SENSE label and says why, in the same grammar as
 * the other two states: rail, well, dot, word. It does not touch the
 * provenanceNote, which is still rendered verbatim underneath — the whole
 * point is that a reader can see the backend's claim and the console's reason
 * for not repeating it, side by side.
 */
const FAULTED_VIEW: ProvenanceView = {
  label: 'No reading — device fault',
  dotClass: 'ant-dot ant-dot-critical',
  measured: false,
  note: 'The device has latched a hardware fault and isolated the prototype. No sensor is being read on this branch, so the figure is absent rather than zero.',
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

/** Join the roster (state) with the readings (telemetry) on outlet id. */
function joinChannels(outlets: Outlet[], series: TelemetrySeries | null): ChannelReading[] {
  return outlets.map((outlet) => {
    const channel =
      series?.channels.find((c) => c.outletId === outlet.id) ??
      UNKNOWN_CHANNEL(outlet.id, outlet.name, outlet.relay, outlet.volts)

    return {
      channel,
      volts: lastPresent(channel.volts),
      amps: lastPresent(channel.amps),
      watts: lastPresent(channel.watts),
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

/**
 * What kind of socket this is, for someone who does not know electrical
 * engineering. `railLabel` names the rail in the engineer's order — the voltage
 * first — because that is what distinguishes the branches. A newcomer reads
 * left to right, so the DEVICE leads and the voltage becomes a qualifier:
 * "Mains socket (220 V)", not "220 V mains". Same fact, legible in one pass.
 */
function socketLabel(volts: number): string {
  const rail = railOf(volts)
  if (rail === '220') return 'Mains socket (220 V)'
  if (rail === '110') return 'Step-down socket (110 V)'
  return `USB socket (${Math.round(volts)} V)`
}

/**
 * The window's standard deviation, said as a word.
 *
 * The card used to print a bare σ next to a number, which is a fact about the
 * shape of a distribution rather than an answer to any question an operator
 * actually asks. "Steadiness: steady / varying" answers the real question —
 * is this channel holding still or is it moving — with no algebra and no
 * Greek. The underlying spread is still one hover away on the chart's bars.
 *
 * Steady means σ under a tenth of the mean: a channel whose readings scatter
 * by less than a tenth of their own level is not doing anything interesting.
 * A dead channel can report a mean of exactly 0, where the ratio is undefined,
 * so the zero-mean case falls back to an equality test — a flat 0 W load is
 * steady, anything moving off zero is not.
 */
const STEADY_SIGMA_RATIO = 0.1

function steadiness(stats: { count: number; mean: number | null; stddev: number | null }): string {
  if (stats.count === 0 || stats.mean === null) return 'not enough readings yet'
  if (stats.stddev === null) return 'only one reading so far'
  if (stats.mean === 0) return stats.stddev === 0 ? 'steady' : 'varying'
  return stats.stddev < stats.mean * STEADY_SIGMA_RATIO ? 'steady' : 'varying'
}

type DistributionCell = {
  index: number
  count: number
  /** The modal bin: the only one drawn in solid primary. */
  peak: boolean
  /** Tooltip text — the per-bin story, sample count plus band range in W. */
  title: string
  /** Axis text, in plain words rather than band edges. Empty means "this column
   *  draws no label", which keeps the three anchors (Lowest, Most readings,
   *  Highest) aligned to the bars they describe. The numeric band edges live in
   *  the words block above the chart, where there is room to read them. */
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
 * Only three axis labels are drawn, and they are WORDS — Lowest, Most readings,
 * Highest — rather than band edges. Eight overlapping numbers was never
 * readable at card width, and `21.1–21.8 W` is a phrase only an engineer has a
 * use for; "Most readings" tells a newcomer the same thing, which is that the
 * tall bar is where this channel spends its life. The exact band numbers are
 * still in each bar's tooltip and in the words block above the chart.
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
  const lastIndex = counts.length - 1

  const cells: DistributionCell[] = counts.map((count, index) => {
    const lower = hist.min + index * binWidth
    const upper = lower + binWidth
    const isPeak = index === peakIndex

    let label = ''
    if (binWidth === 0) {
      // A flat series collapses every edge onto one number, so there is only one
      // band to name — and it is the only one that holds any samples at all.
      label = index === 0 ? 'Most readings' : ''
    } else if (isPeak) {
      label = 'Most readings'
    } else if (index === 0) {
      label = 'Lowest'
    } else if (index === lastIndex) {
      label = 'Highest'
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

/**
 * Pre-data shells share one frame. The `design-main` legacy class is gone: it
 * baked in a 44px offset for a top bar that no longer sizes that way, and this
 * view now uses the same Tailwind page frame as every other view, so the whole
 * app shares one horizontal grid.
 */
const STATE_SHELL = 'flex max-w-3xl flex-col gap-3 px-margin py-space-lg'

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
    let cancelled = false
    let timer = 0
    // Self-scheduling rather than setInterval, matching App.tsx: a request
    // that outlasts the interval must not stack a second one on top of it.
    const tick = () => {
      if (cancelled) return
      // Paused rather than abandoned when hidden, for the same reason
      // TelemetryView does it: the host sleeps, so don't spend its wake budget.
      if (!document.hidden) void load(true).finally(() => {
        if (!cancelled) timer = window.setTimeout(tick, REFRESH_MS)
      })
      else timer = window.setTimeout(tick, REFRESH_MS)
    }
    void load(false).finally(() => {
      if (!cancelled) timer = window.setTimeout(tick, REFRESH_MS)
    })
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      abortRef.current?.abort()
    }
  }, [load])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  if (status === 'unauthorized') {
    return (
      <section aria-label="Channel Inventory">
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
      <section aria-label="Channel Inventory">
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
      <section aria-label="Channel Inventory">
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

  /*
   * The fault is resolved from this view's OWN snapshot rather than handed down
   * from App, so the inventory stays correct if it is ever mounted on its own.
   * It duplicates the detector, not the verdict: both read the same event log.
   */
  const sensorFault: SensorFault | null = detectSensorFault({
    events: snapshot.events,
    deviceOnline: snapshot.deviceOnline,
    channelCount: snapshot.outlets.length,
    now,
  })
  const faulted = sensorFault !== null

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

  // Aggregate current is the SUM of the branch readings, not watts ÷ volts.
  //
  // Each mains branch reports its own current through its own ZMCT103C on its
  // own ADS1015 input, so adding those readings is a measurement. Dividing the
  // power total by one shared voltage reading would instead be arithmetic on a
  // single value, and would fold every branch's error in at once. The nominal
  // USB channel contributes nothing, because there is nothing to contribute.
  const aggregateAmps = aggregatedCurrent(
    readings.map((reading) => ({
      amps: reading.channel.amps,
      provenance: reading.channel.provenance,
    })),
  )
  const measuredBranchCount = readings.filter(
    (reading) => reading.channel.provenance === 'Measured',
  ).length

  const filtersActive = railFilter !== 'all' || normalizedQuery.length > 0

  return (
    <section aria-label="Channel Inventory">
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
                  ? 'text-tertiary'
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

      {/* --- Provenance banner ----------------------------------------------
          The metering mode and the fault are two different sentences about two
          different things, and both are needed. "Metered" says what the device
          is configured to do; the fault says whether it managed to. Collapsing
          them into one banner is how a rig that reads zero for a reason nobody
          can see ends up looking like an idle bench. */}
      {faulted && sensorFault && (
        <section
          className="wash-critical mb-space-md flex items-start gap-space-sm px-space-md py-space-sm"
          role="alert"
          aria-label="Sensor fault: channel figures are not attributable"
        >
          <TriangleAlert size={18} className="mt-0.5 shrink-0 text-error" aria-hidden />
          <div className="min-w-0">
            <p className="font-title-md text-title-md text-on-surface">
              Sensor fault latched — the figures on these cards are not measurements
            </p>
            <p className="mt-0.5 font-body-sm text-body-sm text-on-surface-variant">
              {faultConsequence(sensorFault)}
            </p>
          </div>
        </section>
      )}

      <section
        className={`ant-card p-space-md mb-space-lg flex items-start gap-space-sm border-l-4 ${
          // Only a simulated mode is a fault worth a red rail. "Metered" is the
          // configured intent and wears the neutral edge; whether the device
          // managed to honour it is the rail above.
          mode === 'Simulated' ? 'border-l-error' : 'border-l-outline-strong'
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
          three facts the operator checks, not three headlines.

          Under a latched fault, the three cards that carry a live measurement
          all collapse to the same word. The fourth — the relay/channel count —
          stays, because a policy status is still true when the sensors are
          gone, and removing it would imply the fault had taken out more than
          it had. */}
      <section
        className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-space-md mb-space-lg"
        aria-label="Inventory summary"
      >
        {/* 1. Total load — the one meter-backed figure on the rig. */}
        <article
          className={`ant-card flex flex-col justify-between gap-space-sm ${
            faulted ? 'prov-rail prov-rail--faulted' : ''
          }`}
        >
          <div className="ant-card-body p-space-md flex flex-col h-full">
            <div className="flex items-center justify-between gap-space-sm">
              <span className="font-body-sm text-body-sm text-on-surface-variant">Total Active Load</span>
              <span
                className={`font-metric-value text-metric-value font-semibold ${
                  faulted
                    ? 'text-error'
                    : loadPercent >= 100
                      ? 'text-error'
                      : loadPercent >= 85
                        ? 'text-tertiary'
                        : 'text-on-surface-variant'
                }`}
              >
                {faulted ? 'not attributable' : `${loadPercent.toFixed(0)}% load`}
              </span>
            </div>
            <p
              className={`font-metric-display text-metric-display flex items-baseline gap-1 ${
                faulted ? 'text-error' : 'text-on-surface'
              }`}
            >
              {faulted ? 'No reading' : Math.round(totalWatts).toLocaleString()}
              <span className="font-metric-value text-metric-value font-semibold text-on-surface-variant">
                W
              </span>
            </p>
            <div className="ant-meter mt-auto" role="presentation">
              <div
                className={`ant-meter-fill ${
                  // A load band, so it wears the three bands. A full-width
                  // HATCH when faulted, because an empty track at 0% is
                  // indistinguishable from a healthy idle rig — which is the
                  // exact misread this whole treatment exists to prevent.
                  faulted
                    ? 'bg-error'
                    : loadPercent >= 100
                      ? 'bg-error'
                      : loadPercent >= 85
                        ? 'bg-tertiary'
                        : 'bg-secondary'
                }`}
                style={{
                  width: faulted ? '100%' : `${Math.min(100, loadPercent)}%`,
                  backgroundImage: faulted ? DERIVED_HATCH : undefined,
                  opacity: faulted ? 0.3 : undefined,
                }}
              />
            </div>
            <p className="font-metric-value text-metric-value text-on-surface-variant">
              {faulted
                ? `Cap ${capacity.toLocaleString()} W · headroom not derivable`
                : `Cap ${capacity.toLocaleString()} W · Headroom ${Math.max(
                    0,
                    Math.round(capacity - totalWatts),
                  ).toLocaleString()} W`}
            </p>
            <p className="font-metric-value text-metric-value text-outline">
              {`Warn ${snapshot.thresholds.warning.toLocaleString()} W · Crit ${snapshot.thresholds.critical.toLocaleString()} W`}
            </p>
          </div>
        </article>

        {/* 2. Mains RMS voltage — ONE shared reading, repeated per channel.
            This card used to carry the comment "the only per-branch measurement
            in the rig", which is the exact inverse of the truth: voltage is the
            one quantity here that is NOT measured per branch. */}
        <article
          className={`ant-card flex flex-col ${faulted ? 'prov-rail prov-rail--faulted' : ''}`}
        >
          <div className="ant-card-body p-space-md flex flex-col h-full gap-space-sm">
            <div className="flex items-center justify-between gap-space-sm">
              <span className="font-body-sm text-body-sm text-on-surface-variant">Mains RMS Voltage</span>
              <span
                className={`inline-flex items-center gap-1.5 ${PROVENANCE_LINE}`}
                title={mainsProvenance.note}
              >
                <span className={faulted ? 'ant-dot ant-dot-critical' : mainsProvenance.dotClass} aria-hidden />
                {faulted ? 'No reading' : mainsProvenance.label}
              </span>
            </div>
            <p
              className={`font-metric-value text-metric-value flex items-baseline gap-1 ${
                faulted ? 'text-error' : 'text-on-surface'
              }`}
            >
              {faulted ? '—' : fmt(mainsVolts, 'V')}
              <span className="font-metric-value text-metric-value font-semibold text-on-surface-variant">
                V RMS
              </span>
            </p>
            <p className="font-metric-value text-metric-value text-on-surface-variant mt-auto">
              {`${railCountsByFilter['220']} channel${railCountsByFilter['220'] === 1 ? '' : 's'} · 1 shared reading`}
            </p>
            <p className="font-body-sm text-body-sm text-outline">
              One reading repeated on every mains channel — not a per-branch measurement.
            </p>
          </div>
        </article>

        {/* 3. Aggregated current — the sum of the branch readings, which IS a
            measurement. Every term is sensed, so the sum is sensed; this card
            previously divided watts by voltage and labelled the result derived,
            which threw away four real branch readings to invent one. Under a
            fault the sum is four zeros, which is still four zeros. */}
        <article
          className={`ant-card flex flex-col ${faulted ? 'prov-rail prov-rail--faulted' : ''}`}
        >
          <div className="ant-card-body p-space-md flex flex-col h-full gap-space-sm">
            <div className="flex items-center justify-between gap-space-sm">
              <span className="font-body-sm text-body-sm text-on-surface-variant">Aggregated Current</span>
              <span
                className={`inline-flex items-center gap-1.5 ${PROVENANCE_LINE}`}
                title="Sum of the per-branch ZMCT103C readings on the ADS1015 — not derived from watts"
              >
                <span
                  className={faulted ? 'ant-dot ant-dot-critical' : 'ant-dot bg-outline-variant'}
                  aria-hidden
                />
                {faulted ? 'No reading' : 'Sum of branches'}
              </span>
            </div>
            <p
              className={`font-metric-value text-metric-value flex items-baseline gap-1 ${
                faulted ? 'text-error' : 'text-on-surface'
              }`}
            >
              {faulted ? '—' : aggregateAmps === null ? '—' : aggregateAmps.toFixed(3)}
              <span className="font-metric-value text-metric-value font-semibold text-on-surface-variant">
                A
              </span>
            </p>
            <p className="font-metric-value text-metric-value text-on-surface-variant mt-auto">
              {faulted
                ? 'No CT is answering on any branch'
                : aggregateAmps === null
                  ? 'No sensed branch reported'
                  : `${measuredBranchCount} branch CT readings, added`}
            </p>
            <p className="font-metric-value text-metric-value text-outline">
              {`Nominal channels excluded: ${readings.length - measuredBranchCount}`}
            </p>
          </div>
        </article>

        {/* 4. Relay state — and the honest framing of it.
            This is the card that most needed a rewrite. It was headed "Active
            Relays" and counted outlets whose STATUS is Active, which on this
            build has nothing to do with a relay: RELAY_OUTPUT_ENABLED is 0, so
            the firmware never drives a contact and relayClosed is posted as a
            constant true. Presenting that count under a relay heading would be
            a control that claims an action the system cannot perform.

            It is now labelled for what it actually is — the policy engine's
            status for each channel — and says outright that no contact state is
            being reported. This card is NOT suppressed under a fault: a policy
            status is still true when the sensors are gone, and blanking it
            would overstate what the fault has taken out. */}
        <article className="ant-card flex flex-col">
          <div className="ant-card-body p-space-md flex flex-col h-full gap-space-sm">
            <div className="flex items-center justify-between gap-space-sm">
              <span className="font-body-sm text-body-sm text-on-surface-variant">Channel policy status</span>
              <span
                className={`inline-flex items-center gap-1.5 font-body-sm text-body-sm font-medium ${
                  snapshot.deviceOnline ? 'text-on-surface-variant' : 'text-tertiary'
                }`}
              >
                <span
                  className={`ant-dot ${snapshot.deviceOnline ? 'ant-dot-normal' : 'ant-dot-warning'}`}
                  aria-hidden
                />
                {snapshot.deviceOnline ? 'Controller online' : 'Controller offline'}
              </span>
            </div>
            <p className="font-metric-value text-metric-value text-on-surface flex items-baseline gap-1.5">
              <span className="font-metric-value text-metric-value">{energizedCount}</span>
              <span className="font-body-md text-body-md font-normal text-on-surface-variant">
                / {readings.length} channels Active
              </span>
            </p>
            <p className="font-metric-value text-metric-value text-on-surface-variant mt-auto">
              {`Window ${series?.windowLabel ?? '—'} · ${series?.rawSampleCount ?? 0} raw rows`}
            </p>
            <p className="font-metric-value text-metric-value text-tertiary">
              Relay outputs not driven — status only
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
              className="h-10 pl-3 pr-8 font-body-sm text-body-sm rounded bg-[#FFFFFF] text-on-surface border border-outline-variant outline-none cursor-pointer appearance-none transition-colors focus:border-primary"
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
              className="absolute right-2.5 top-3 pointer-events-none text-on-surface-variant"
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
            // The API's own provenance label is kept, but it is not what the
            // card is allowed to CLAIM while the device is in fault. `view` is
            // what gets drawn; `apiView` is what the provenance block below
            // names, so the discrepancy stays auditable.
            const apiView = provenanceView(reading.channel.provenance)
            const view = faulted ? FAULTED_VIEW : apiView
            const suppressed = faulted
            const stats = describeSeries(reading.channel.watts)
            // The roster owns the human name; the telemetry channel carries a
            // fallback. Either way the name leads the card and the CH id follows
            // it, so the person's vocabulary comes before the machine's.
            const channelName = outlet?.name ?? reading.channel.name
            // The distribution is the same chart grammar as the Telemetry view's
            // aggregate load distribution, scaled to card width. It returns null
            // when a channel reported nothing in the window, so a dead branch has
            // no chart frame at all rather than an empty one.
            const chart = buildDistribution(reading.channel.watts, HISTOGRAM_BINS)

            const allowance = outlet?.allowance ?? 0
            const hasAllowance = allowance > 0
            // Under a fault there IS a reading in the array — it is zero — and
            // it is exactly as trustworthy as a blank. `hasReading` is forced
            // false so every downstream `no reading` / `—` path engages.
            const hasReading = reading.watts !== null && !suppressed
            const rawPercent = hasAllowance && hasReading ? (reading.watts! / allowance) * 100 : 0
            const overAllowance = rawPercent > 100
            const usedPercent = Math.min(100, rawPercent)

            // Fill colour encodes headroom; the hatch encodes derivation. Under a
            // fault neither applies — the bar becomes a full-width hatched
            // critical rail, because "there is a slot on this track and nothing
            // trustworthy can go in it" is a different shape from "0% used".
            const fillColor = suppressed
              ? 'bg-error'
              : overAllowance
                ? 'bg-error'
                : rawPercent >= 85
                  ? 'bg-tertiary'
                  : 'bg-secondary'

            // What the current figure means, in words. This is the one thing a
            // bare "0.002 A" cannot say on its own: whether the branch drew
            // nothing, has no sensor, or simply never reported.
            const verdict = suppressed
              ? {
                  kind: 'no-reading' as const,
                  label: 'No reading',
                  detail: 'The device has latched a hardware fault and isolated the prototype. No sensor is answering on this branch, so this is an absent figure rather than a measured zero.',
                }
              : loadVerdict(reading.amps, {
                  sensed: view.measured,
                  channelId: reading.channel.outletId,
                })

            return (
              <article
                key={reading.channel.outletId}
                className="ant-card p-space-md flex flex-col gap-space-sm"
                aria-label={`${channelName} · ${statusView.label}`}
              >
                {/* 1 — IDENTITY. The name is what a person recognises ("the one by
                    the kettle"), so it leads and CH02 is demoted to a quiet mono
                    aside: the machine's name for the same socket, useful when
                    cross-referencing a log but not when reading the card. The
                    status tag stays top right, because status is the only thing
                    here that is a verdict about the plant rather than a fact
                    about the channel, and it is what the eye should land on
                    last. */}
                <div className="flex flex-col gap-0.5">
                  <header className="flex items-start justify-between gap-space-sm">
                    <h3
                      className="font-title-lg text-title-lg text-on-surface truncate"
                      title={channelName}
                    >
                      {channelName}
                    </h3>
                    <div className="flex shrink-0 items-center gap-2 pt-0.5">
                      <span className="font-metric-value text-metric-value text-outline">
                        {`CH${String(reading.channel.outletId).padStart(2, '0')}`}
                      </span>
                      <span className={statusView.tagClass}>{statusView.label}</span>
                    </div>
                  </header>

                  {/* 2 — WHAT KIND OF THING THIS IS. One sentence, no jargon: the
                      socket, its voltage, and how urgently the grid protects it.
                      Rail and shed priority are static metadata, so they share this
                      line instead of each earning a chip. */}
                  <p
                    className={`${METADATA_LINE} truncate`}
                    title="Shed order: Low priority is shed first"
                  >
                    {`${socketLabel(reading.channel.ratedVoltageVolts)} · Priority: ${outlet?.priority ?? 'Unknown'}`}
                  </p>
                </div>

                {/* 3 — THE HERO. One number answers "how much is this using right
                    now", so it is the only figure on the card at display size and
                    everything below it is deliberately smaller. The sentence under
                    it is what makes the number mean something: "allowance" only
                    means anything once you are told it is a limit on what this
                    outlet is allowed to draw. The meter stays glued to this block,
                    because it is the picture of exactly this ratio. */}
                <div>
                  <p
                    className={`font-metric-display text-metric-display flex items-baseline gap-1 ${
                      suppressed ? 'text-error' : overAllowance ? 'text-error' : 'text-on-surface'
                    }`}
                  >
                    {/*
                      The unit is dropped with the figure. "No reading W" reads as
                      a watts figure that happens to be missing its number, which
                      is precisely the ambiguity this state exists to remove.
                    */}
                    {suppressed ? 'No reading' : fmtWatts(reading.watts)}
                    {suppressed ? null : (
                      <span className="font-metric-value text-metric-value font-semibold text-on-surface-variant">
                        W
                      </span>
                    )}
                  </p>
                  <div className="flex items-baseline justify-between gap-2 mt-1">
                    <span className="min-w-0 truncate font-body-sm text-body-sm text-on-surface-variant">
                      {suppressed
                        ? 'Sensor fault — this branch is not being read'
                        : hasAllowance ? (
                          <>
                            {'of the '}
                            <span className="font-metric-value text-metric-value text-on-surface">
                              {`${fmtWatts(allowance)} W`}
                            </span>
                            {' this outlet is allowed to draw'}
                          </>
                        ) : (
                          'No draw limit set for this outlet'
                        )}
                    </span>
                    <span
                      className={`shrink-0 font-metric-value text-metric-value font-semibold ${
                        suppressed
                          ? 'text-error'
                          : overAllowance
                            ? 'text-error'
                            : rawPercent >= 85
                              ? 'text-tertiary'
                              : 'text-on-surface-variant'
                      }`}
                    >
                      {suppressed
                        ? 'not attributable'
                        : hasReading && hasAllowance
                          ? `${fmtPercent(rawPercent)} used`
                          : hasAllowance
                            ? 'no reading'
                            : '—'}
                    </span>
                  </div>
                  <div
                    className="ant-meter mt-2"
                    role="meter"
                    aria-valuenow={hasReading && hasAllowance ? Math.round(rawPercent) : undefined}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={
                      suppressed
                        ? 'Allowance used — not attributable, sensor fault latched'
                        : `Allowance used — ${view.label}`
                    }
                  >
                    {/* A full-width HATCHED bar, not a zero-width one. The
                        shape says "there is a slot on this track and nothing
                        trustworthy can go in it", which an empty bar cannot say —
                        an empty bar is exactly what an idle channel looks like,
                        and that ambiguity is the whole bug. */}
                    <div
                      className={`ant-meter-fill ${fillColor}`}
                      style={{
                        width: suppressed ? '100%' : `${hasReading ? usedPercent : 0}%`,
                        backgroundImage:
                          suppressed || !view.measured ? DERIVED_HATCH : undefined,
                        opacity: suppressed ? 0.3 : undefined,
                      }}
                    />
                  </div>
                  {overAllowance && (
                    <p className="font-metric-value text-metric-value text-error mt-1">
                      {`Over allowance by ${fmtPercent(rawPercent - 100)}`}
                    </p>
                  )}
                </div>

                {/* 4 — THE THREE READINGS, in the words a non-engineer uses.
                    "Voltage / Current / Power" are the units; "Supply / Current
                    in use / Power drawn" are what those units are FOR. Under a
                    latched fault all three hold an em dash and say so, because
                    three confident zeros in a row is the most believable lie
                    this screen could tell. */}
                <div className="grid grid-cols-3 gap-1 bg-surface-container-low rounded py-2 px-1 text-center">
                  <div>
                    <div className="font-label-sm text-label-sm uppercase text-on-surface-variant">
                      Supply
                    </div>
                    <div className="font-metric-value text-metric-value font-semibold text-on-surface">
                      {`${suppressed ? '—' : fmtVolts(reading.volts)} V`}
                    </div>
                    <div className="font-code text-code text-outline">
                      {suppressed ? 'no reading' : view.measured ? 'shared' : 'nominal'}
                    </div>
                  </div>
                  <div>
                    <div className="font-label-sm text-label-sm uppercase text-on-surface-variant">
                      Current in use
                    </div>
                    <div
                      className={`font-metric-value text-metric-value font-semibold ${
                        suppressed || reading.amps === null
                          ? 'text-on-surface-variant'
                          : 'text-on-surface'
                      }`}
                    >
                      {`${suppressed ? '—' : fmtAmps(reading.amps)} A`}
                    </div>
                    {/* The verdict, not the digits, is what stops "0.002 A"
                        reading as a live zero. */}
                    <div
                      className={`font-code text-code ${
                        verdict.kind === 'load'
                          ? 'text-outline'
                          : verdict.kind === 'no-reading'
                            ? 'text-error'
                            : 'text-tertiary'
                      }`}
                    >
                      {verdict.label}
                    </div>
                  </div>
                  <div>
                    <div className="font-label-sm text-label-sm uppercase text-on-surface-variant">
                      Power drawn
                    </div>
                    <div
                      className={`font-metric-value text-metric-value font-semibold ${
                        suppressed
                          ? 'text-error'
                          : hasReading
                            ? overAllowance
                              ? 'text-error'
                              : 'text-on-surface'
                            : 'text-on-surface-variant'
                      }`}
                    >
                      {`${suppressed ? '—' : fmtWatts(reading.watts)} W`}
                    </div>
                    <div className="font-code text-code text-outline">
                      {suppressed ? 'no reading' : view.measured ? 'V × A' : 'nominal'}
                    </div>
                  </div>
                </div>

                {/* The one-line reason behind the verdict above. Rendered only
                    when there is something to explain: "No load" on its own is
                    a claim, this is the evidence for it. */}
                {verdict.detail && (
                  <p
                    className={`rounded px-2 py-1.5 font-body-sm text-body-sm ${
                      suppressed
                        ? 'border border-error-fixed bg-error-container text-on-surface'
                        : 'bg-surface-container-low text-on-surface-variant'
                    }`}
                    title={verdict.detail}
                  >
                    {verdict.detail}
                  </p>
                )}

                {/* 5 — HOW IT HAS BEEN BEHAVING, over the window. "Min / Mean / Max
                    / σ" is four unexplained tokens; the same four facts as words
                    are a sentence a newcomer can act on. σ is not printed as a
                    number — it is the one figure on this card that means nothing
                    without knowing what a standard deviation is — so it becomes the
                    verdict it actually supports. Gaps are skipped, never read as
                    zero, so a dead channel says so rather than showing 0.0.

                    Under a fault the whole block is replaced rather than
                    relabelled: "lowest 0.0 W / typical 0.0 W / steady" computed
                    from a blind device is a perfectly ordinary-looking sentence
                    about nothing, which is worse than no sentence. */}
                {suppressed ? (
                  <div className="prov-rail prov-rail--faulted">
                    <p className="font-body-sm text-body-sm text-on-surface">
                      Behaviour over the window is not summarised
                    </p>
                    <p className="font-body-sm text-body-sm text-on-surface-variant">
                      A channel with no sensor answering produces a flat zero line. Plotting that
                      as a distribution would present the absence of a measurement as the shape of a
                      load.
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-0.5">
                    <p className="flex flex-wrap items-baseline gap-x-3 font-body-sm text-body-sm text-on-surface-variant">
                      {(
                        [
                          ['Lowest seen', stats.min],
                          ['Typical', stats.mean],
                          ['Highest', stats.max],
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
                    <p className="font-body-sm text-body-sm text-on-surface-variant">
                      {'Steadiness: '}
                      <span className="text-on-surface">{steadiness(stats)}</span>
                    </p>
                  </div>
                )}

                {/* 6 — THE DISTRIBUTION, and the chart itself is unchanged: bars rise
                    from one shared baseline rule and scale to the modal bin, the
                    modal bin wears solid primary, other populated bins wear the
                    lighter primary tint, and an empty bin wears nothing at all.
                    The baseline plus the absent bars are what make a gap read as
                    "nothing in this band" rather than as a short sample. What
                    changed is the prose around it — a line saying what the chart
                    IS, and three anchor words instead of three band numbers. */}
                {chart && !suppressed && (
                  <figure className="m-0 flex flex-col gap-1">
                    <p className="font-body-sm text-body-sm text-on-surface-variant">
                      {`How the load was distributed across ${chart.total} reading${chart.total === 1 ? '' : 's'} in this window`}
                    </p>

                    <div
                      className="flex h-16 items-end gap-1 border-b border-outline-variant"
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

                    {/* Three anchors only, named in words — Lowest, Most readings,
                        Highest — in the same flex track as the bars, so each label
                        is genuinely under the column it describes rather than
                        floated on a shared justify-between. */}
                    <div className="flex gap-1">
                      {chart.cells.map((cell) => (
                        <span
                          key={cell.index}
                          className={`min-w-0 flex-1 whitespace-nowrap text-center font-body-sm text-body-sm ${
                            cell.peak ? 'font-semibold text-primary' : 'text-outline'
                          }`}
                        >
                          {cell.label}
                        </span>
                      ))}
                    </div>

                    <figcaption className="flex items-baseline justify-between gap-2 font-body-sm text-body-sm text-on-surface-variant">
                      <span>Most readings fell in one narrow band</span>
                      <span className="font-metric-value text-metric-value text-outline">
                        {fmtPercent(chart.peakShare)}
                      </span>
                    </figcaption>
                  </figure>
                )}

                {/* 7 — PROVENANCE, in full.
                    This used to be one clamped line in the footer. Clamping the
                    API's provenanceNote is the wrong call on the one field the
                    backend bothers to write per channel: it is the sentence
                    that says whether this card's numbers were measured, and a
                    sentence cut off at the ellipsis does not survive a panel
                    asking "is that real?". It is now rendered whole, above the
                    footer, as its own block.

                    Under a fault this block does double duty, and deliberately.
                    It states the console's verdict, then quotes the backend's
                    own claim verbatim underneath it, so the disagreement is on
                    the card rather than in a changelog. Hiding what the API says
                    would be the dishonest half of this fix. */}
                <div
                  className={`rounded px-2.5 py-2 ${
                    suppressed
                      ? 'prov-rail prov-rail--faulted border border-error-fixed bg-error-container'
                      : 'bg-surface-container-low'
                  }`}
                >
                  <p className="flex items-center gap-1.5 font-body-sm text-body-sm font-medium text-on-surface">
                    <span className={view.dotClass} aria-hidden />
                    {view.label}
                    {view.measured ? null : (
                      <span
                        className={`font-body-sm text-body-sm font-normal ${
                          suppressed ? 'text-error' : 'text-tertiary'
                        }`}
                      >
                        · not measured
                      </span>
                    )}
                  </p>
                  <p className="mt-1 font-body-sm text-body-sm text-on-surface-variant">
                    {view.note}
                  </p>
                  {suppressed && (
                    <>
                      <p className="mt-1.5 font-label-sm text-label-sm uppercase text-on-surface-variant">
                        What the API reports for this channel
                      </p>
                      <p className="font-body-sm text-body-sm text-on-surface-variant">
                        {apiView.label} —{' '}
                        {reading.channel.provenanceNote ||
                          'The backend did not supply a provenance note for this channel.'}
                      </p>
                    </>
                  )}
                </div>

                {/* 8 — Footer: the relay channel as CONFIGURATION, plus sample
                    coverage, which answers "how much of this window is real?".
                    Relay outputs are not driven in this build, so this is a
                    wiring fact and never a contact reading. */}
                <footer className="mt-auto pt-2 border-t border-outline-variant flex items-center justify-between gap-2">
                  <span
                    className="inline-flex min-w-0 items-center gap-1.5 font-metric-value text-metric-value text-outline"
                    title={`${reading.channel.relayChannel} — configured channel. Relay outputs are not driven in this phase, so no contact state is reported.`}
                  >
                    {reading.channel.relayChannel || '—'}
                    <span className="text-outline">· not driven</span>
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

      {/* --- Provenance footnote -----------------------------------------------
          This bar is the most defensible thing on the page, so it is given the
          most space and the most specific language. It answers three separate
          questions that the rest of the UI only gestures at:

            1. What is physically on the bench? (ADS1015 + ZMCT103C per branch,
               one shared voltage reading, a nominal-only USB rail.)
            2. Which reading is not a per-branch measurement? (volts — there is
               one of them, shown four times.)
            3. What is deliberately NOT here? (THD, power factor, frequency,
               energy, contact state — with the reason for each.)

          Point 3 is the one that used to be quietly wrong. Every entry below
          used to appear somewhere in this console as a plausible number: a
          1.2% THD, a 0.95 lagging power factor, a 60.0 Hz line frequency, a
          kWh total computed from a field the firmware sets to 0.0. None of
          them had a sensor behind it. They are listed as absent rather than
          quietly dropped, because a reader who has seen one of them in an
          earlier draft deserves to be told it was never a measurement. */}
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
          {/* The sensing chain, named. */}
          <div className="mb-space-md rounded-md border border-outline-variant bg-surface-container-low px-3 py-2.5">
            <p className="font-title-md text-title-md text-on-surface">What is on the bench</p>
            <ul className="mt-1.5 flex flex-col gap-1 font-body-sm text-body-sm text-on-surface-variant">
              <li>
                <strong className="font-medium text-on-surface">CH1–CH4 current</strong> is read
                directly: a ZMCT103C on each branch into that branch&rsquo;s own ADS1015 analogue
                input (AIN0–AIN3). It is not apportioned from a mains total.
              </li>
              <li>{SHARED_VOLTS_NOTE}</li>
              <li>
                <strong className="font-medium text-on-surface">CH5 (5 V USB)</strong> has no
                sensor on its branch. Its figure is the rail&rsquo;s nominal rating, hatched
                everywhere it appears, and it is never presented as a measured zero.
              </li>
            </ul>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-space-md mb-space-md">
            <article>
              <strong className="font-title-md text-title-md text-on-surface">Volts</strong>
              <p className="font-body-sm text-body-sm text-on-surface-variant mt-0.5">
                {mode === 'Simulated' ? VOLTS_CAPTION : SHARED_VOLTS_NOTE}
              </p>
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

          {/* Not measured. Present, named, and explained — so "absent" is
              distinguishable from "forgot to render". */}
          <div className="mb-space-md rounded-md border border-outline-variant px-3 py-2.5">
            <p className="font-title-md text-title-md text-on-surface">
              Not measured by this build — no figure is shown for these
            </p>
            <dl className="mt-1.5 grid grid-cols-1 gap-x-space-lg gap-y-1 sm:grid-cols-2">
              {NOT_MEASURED.map((item) => (
                <div key={item.label} className="flex flex-col">
                  <dt className="font-body-sm text-body-sm text-on-surface">
                    <span className="ant-dot ant-dot-warning mr-1.5 inline-block align-middle" aria-hidden />
                    {item.label}
                  </dt>
                  <dd className="font-body-sm text-body-sm text-outline">{item.why}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="flex items-start gap-space-sm p-space-sm bg-surface-container-low rounded-md">
            <ShieldCheck size={16} className="shrink-0 mt-0.5 text-on-surface-variant" aria-hidden />
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              A <strong className="text-on-surface">solid</strong> allowance bar means the figure came
              from a sensor. A <strong className="text-on-surface">hatched</strong> bar means the figure
              was inferred — no sensor is fitted on that branch. Live figures are the most recent
              non-null bucket of the {series?.windowLabel ?? '15 min'} window; &ldquo;lowest seen&rdquo;,
              &ldquo;typical&rdquo; and &ldquo;highest&rdquo; cover that same window, skipping gaps rather
              than treating them as zero, and &ldquo;steadiness&rdquo; is the spread behind the typical
              value stated as a verdict rather than as a symbol.
              {/*
                The roster's own meterChannel string still reads "PZEM-01 … mains
                bus" on every outlet. That is a stale seeded label from before
                the ADS1015 conversion, so it is deliberately not rendered as a
                sensor name anywhere on this view — but it is named here rather
                than quietly hidden, because someone reading the API response
                will hit it and should know it is not a device on the rig.
              */}
              <span className="mt-1 block text-outline">
                Note: the roster&rsquo;s <code className="font-code text-code">meterChannel</code>{' '}
                field still reads &ldquo;PZEM-01 &hellip; mains bus&rdquo;. That label predates the
                ADS1015 conversion and is not rendered as a sensor name on this page.
              </span>
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