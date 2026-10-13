import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Activity,
  ArrowDown,
  ArrowUp,
  CalendarDays,
  Info,
  RefreshCw,
  Sigma,
  TrendingUp,
  TriangleAlert,
  Zap,
} from 'lucide-react'
import {
  fetchDashboardState,
  fetchTelemetrySeries,
  ApiError,
  type TelemetryChannel,
  type TelemetrySeries,
  type TelemetryWindow,
} from '../api'
import {
  ALL_CHANNEL_IDS,
  AMPS_CAPTION,
  METERING_MODE_LABEL,
  NOT_MEASURED,
  POLL_INTERVAL_MS,
  PROVENANCE_COPY,
  PROVENANCE_GLYPH,
  SHARED_VOLTS_NOTE,
  TELEMETRY_RETENTION_DAYS,
  TELEMETRY_WINDOWS,
  VOLTS_CAPTION,
  VOLTS_CAPTION_METERED,
  WATTS_CAPTION,
  WATTS_CAPTION_SIMULATED,
  channelColor,
  channelDash,
} from '../data/telemetry'
import {
  aggregatedCurrent,
  backoffMs,
  describeSeries,
  formatValue,
  histogram,
  seriesStats,
  stalenessState,
  type Unit,
} from '../utils/telemetry'
import { ChannelHeatmap } from './ChannelHeatmap'
import { Disclosure } from './Disclosure'
import { TimeSeriesChart, type ChartSeries, type ThresholdLine } from './TimeSeriesChart'
import { detectSensorFault, faultConsequence, type SensorFault } from '../utils/sensorFault'

type Status = 'idle' | 'loading' | 'refreshing' | 'ready' | 'stale' | 'unauthorized' | 'error'

/** Failure threshold before the view switches to the "backend is cold" story. */
const STALE_AFTER_ATTEMPTS = 3

/** The four plotted views. Only the selected one is mounted — four live SVGs at once is waste. */
type ChartTabId = 'total' | 'watts' | 'amps' | 'volts'

const CHART_TABS: Array<{ id: ChartTabId; label: string; unit: Unit }> = [
  { id: 'total', label: 'Total load', unit: 'W' },
  { id: 'watts', label: 'Per-channel power', unit: 'W' },
  { id: 'amps', label: 'Per-channel current', unit: 'A' },
  { id: 'volts', label: 'Per-channel voltage', unit: 'V' },
]

const HISTOGRAM_BINS = 8

/**
 * Static class strings so Tailwind can see them (no dynamic colour lookups).
 *
 * The provenance nameplate is deliberately monochrome. "Measured" and
 * "simulated" are provenance facts, not normal/warning/critical health states,
 * so neither may borrow a status colour or the interactive blue. Its weight
 * comes from the hairline, the neutral surface and the type scale instead.
 */
const BANNER_FRAME = 'border-outline-variant bg-surface-container-lowest'

/**
 * "Live" is the ordinary state, not a verdict, so it wears the neutral outline
 * dot. `.ant-dot-normal` is still `bg-secondary` in the shared ant.css, which is
 * deliberately left alone, so the neutral is applied here as a utility — the
 * utilities layer outranks the components layer `.ant-dot` lives in.
 */
const LIVE_DOT: Record<string, string> = {
  fresh: 'bg-outline-variant',
  delayed: 'ant-dot-warning',
  stale: 'ant-dot-critical',
}

const LIVE_LABEL: Record<string, string> = {
  fresh: 'Live stream',
  delayed: 'Stream delayed',
  stale: 'Stream stale',
}

/**
 * Ink for a statistics value.
 *
 * Every card here reads ink-primary. The previous build gave the mean the
 * interactive blue and the duty cycle a "success" ink, which put two accents
 * on a row of five peer readings — and green, in particular, turned a measured
 * duty ratio into what looked like an approval. The hero is distinguished by
 * SIZE (metric-display) and by the card saying so, not by colour; that is the
 * whole of the emphasis budget on this strip.
 */
const VALUE_INK: Record<'neutral' | 'primary' | 'success', string> = {
  neutral: 'text-on-surface',
  primary: 'text-on-surface',
  success: 'text-on-surface',
}

type StatCardSpec = {
  key: string
  label: string
  icon: ReactNode
  /** Pre-formatted, already unit-stripped. Rendered in JetBrains Mono tabular figures. */
  value: string
  unit: string | null
  ink: 'neutral' | 'primary' | 'success'
  dot: string
  note: ReactNode
  /**
   * Exactly one card in this view is the hero and wears metric-display: the mean
   * power, which is the single number the whole window is summarised by. Every
   * other card is a peer reading at metric-value, so five cards in one row do
   * not each shout at 28px.
   */
  hero?: boolean
}

function mono(children: ReactNode) {
  return <span className="font-metric-value text-metric-value font-medium text-on-surface">{children}</span>
}

/**
 * Group the device's provenance notes by what they actually say.
 *
 * The backend returns one rig-shape sentence for the sensed mains branches and
 * a different one for the unsensed USB rail, so the four identical notes are a
 * description of the RIG, not of each channel. Printing them per channel stated
 * the same thing four times under four different headings, which reads as four
 * separate findings and is none.
 *
 * This groups on the note string itself — no channel ids are hard-coded, so if
 * the backend ever splits CH1–CH4 into distinct notes each one gets its own
 * line automatically, and if the rig gains a fifth sensed branch it joins the
 * shared group rather than duplicating a paragraph.
 */
function groupedProvenance(channels: TelemetryChannel[]): Array<{
  note: string
  channels: Array<{ outletId: number; provenance: string }>
  /** True when more than one channel carries this exact note. */
  shared: boolean
}> {
  const byNote = new Map<string, Array<{ outletId: number; provenance: string }>>()
  for (const channel of channels) {
    const entry = { outletId: channel.outletId, provenance: channel.provenance }
    const bucket = byNote.get(channel.provenanceNote)
    if (bucket) bucket.push(entry)
    else byNote.set(channel.provenanceNote, [entry])
  }
  return [...byNote.entries()].map(([note, bucket]) => ({
    note,
    channels: [...bucket].sort((a, b) => a.outletId - b.outletId),
    shared: bucket.length > 1,
  }))
}

/**
 * `CH1–CH4` for a contiguous run, `CH2, CH5` for anything else.
 *
 * The naive join wrote `CH1–CH2–CH3–CH4`, which names four channels correctly
 * and reads like a range of nonsense. A shared note over contiguous channels IS
 * a range, so it is written as one.
 */
function channelRange(channels: Array<{ outletId: number }>): string {
  const ids = channels.map((c) => c.outletId)
  if (ids.length === 1) return `CH${ids[0]}`
  const contiguous = ids.every((id, i) => i === 0 || id === ids[i - 1] + 1)
  if (contiguous) return `CH${ids[0]}–CH${ids[ids.length - 1]}`
  return ids.map((id) => `CH${id}`).join(', ')
}

/** Thousands-separated, unit-appropriate precision. Never renders NaN/Infinity. */
function formatMetric(value: number | null, unit: Unit): string {
  if (value === null || !Number.isFinite(value)) return '—'
  const decimals = unit === 'A' ? 2 : unit === 'V' ? 1 : 1
  return value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: decimals })
}

function formatPercent(value: number): string {
  return `${value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 1 })}%`
}

/** "59m 38s" / "2h 05m" — bucket durations, so the gap-vs-zero story stays legible. */
function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds))
  const hours = Math.floor(s / 3600)
  const minutes = Math.floor((s % 3600) / 60)
  const seconds = s % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

/** UTC clock so the window readout cannot be misread against the browser's local zone. */
function utcStamp(stamp: string | undefined, withDate: boolean): string {
  if (!stamp) return '--:--:--'
  const date = new Date(stamp)
  if (Number.isNaN(date.getTime())) return '--:--:--'
  const time = [date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')
  if (!withDate) return time
  return `${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')} ${time}`
}

/**
 * The telemetry route body. Owns its own timers and mounts only while active —
 * deliberately independent of App.tsx's 5 s dashboard poll (D10), because two
 * loops in one tree would double the load on a host that sleeps when idle.
 *
 * The governing rule here is that this view never blanks. On any failure it keeps
 * the last good data on screen, dims it, and explains what is actually wrong.
 */
export function TelemetryView() {
  // Deliberately NOT named `window`: that would shadow the global and break
  // every setTimeout/setInterval below.
  const [activeWindow, setActiveWindow] = useState<TelemetryWindow>('1h')
  // Empty means "every channel on the rig" — 5 on the testing bench. Kept as a
  // list so a partial filter is expressible.
  const [hidden, setHidden] = useState<number[]>([])
  const [series, setSeries] = useState<TelemetrySeries | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const [failedAttempts, setFailedAttempts] = useState(0)
  // Drives the relative-time labels only. Never triggers a refetch, so a 7-day
  // view does not hammer the backend once a second.
  const [now, setNow] = useState(() => Date.now())
  // View-only state: which plotted series is mounted, and whether the y-axis is
  // scaled to the trip line or to the trace. Neither changes what is fetched.
  const [activeTab, setActiveTab] = useState<ChartTabId>('total')
  const [scaleToThresholds, setScaleToThresholds] = useState(true)
  // Warn and trip lines, straight from the API's own capacity configuration.
  // These are NOT constants: the testing rig is 1,200 W and the full rig is
  // 4,000 W, so a hardcoded 1,500 W line would be wrong for this rig and
  // invented besides.
  const [thresholds, setThresholds] = useState<{ warning: number; critical: number } | null>(null)
  /*
   * Resolved from the same /Dashboard/state call that already supplies the
   * thresholds, so this view needs no request of its own to know the rig is
   * blind. That matters here more than anywhere else: this is the page an
   * examiner will ask "were those numbers measured?", and every statistic below
   * is computed over buckets the device posted while it was latched in fault.
   */
  const [sensorFault, setSensorFault] = useState<SensorFault | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const requestSeqRef = useRef(0)
  // Mirrors failedAttempts so the self-rescheduling poll can read it without
  // taking it as a dependency (which would restart the timer on every miss).
  const failuresRef = useRef(0)

  const channelFilter = useMemo(() => ALL_CHANNEL_IDS.filter((id) => !hidden.includes(id)), [hidden])

  const load = useCallback(
    async (isRefresh: boolean) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      const seq = ++requestSeqRef.current

      setStatus(isRefresh ? 'refreshing' : 'loading')

      try {
        // Threshold config first, and tolerated to fail: the telemetry trace is
        // the point of this page, and a capacity-config read error must not
        // blank the charts. The rules simply do not get drawn.
        const configPromise = fetchDashboardState()
          .then((state) => {
            setThresholds({ warning: state.thresholds.warning, critical: state.thresholds.critical })
            setSensorFault(
              detectSensorFault({
                events: state.events,
                deviceOnline: state.deviceOnline,
                channelCount: state.outlets.length,
                now: Date.now(),
              }),
            )
          })
          .catch(() => undefined)

        const payload = await fetchTelemetrySeries(activeWindow, channelFilter, controller.signal)
        await configPromise

        // A superseded request must never overwrite the current one (E12).
        if (seq !== requestSeqRef.current) return

        setSeries(payload)
        failuresRef.current = 0
        setFailedAttempts(0)
        setError(null)
        setStatus('ready')
      } catch (cause) {
        if (seq !== requestSeqRef.current) return
        if (cause instanceof DOMException && cause.name === 'AbortError') return

        if (cause instanceof ApiError && cause.status === 401) {
          // App.tsx owns the login gate; from here it is only a status.
          setStatus('unauthorized')
          setError('Session expired. Sign in again to view telemetry.')
          return
        }

        const reason = cause instanceof ApiError && cause.status === 0 ? 'Backend unreachable' : String(cause)
        setError(reason)
        // Keep the last good data on screen through a transient failure. Only
        // after several consecutive misses does it dim, so a single dropped poll
        // never makes the charts look broken.
        setStatus((current) => (current === 'ready' ? 'ready' : 'error'))
        failuresRef.current += 1
        setFailedAttempts(failuresRef.current)
        if (failuresRef.current >= STALE_AFTER_ATTEMPTS) setStatus('stale')
      }
    },
    [activeWindow, channelFilter],
  )

  // Mount, window change and channel-filter change: fetch immediately, then poll
  // on the window's cadence. The 7-day window is manual-only.
  useEffect(() => {
    void load(false)

    const interval = POLL_INTERVAL_MS[activeWindow]
    if (interval === null) return

    let timer: number | undefined
    let cancelled = false

    const tick = () => {
      if (cancelled) return

      // Paused, not abandoned: keep the schedule but skip the request so a
      // backgrounded tab never spends the host's cold-start budget.
      if (document.hidden) {
        timer = window.setTimeout(tick, interval)
        return
      }

      void load(true)

      // Back off after failures so a sleeping backend is not hammered: 2s, 4s,
      // 8s ... capped at 60s, never shorter than the window's own cadence.
      const failures = failuresRef.current
      const delay = failures > 0 ? Math.max(interval, backoffMs(failures)) : interval
      timer = window.setTimeout(tick, delay)
    }

    timer = window.setTimeout(tick, interval)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
      abortRef.current?.abort()
    }
  }, [load, activeWindow])

  // Pause while the tab is hidden; resume with an immediate fetch.
  useEffect(() => {
    const onVisibility = () => {
      if (!document.hidden) void load(true)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [load])

  // Label-only ticker.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const channels = series?.channels ?? []
  const visibleChannels = useMemo(
    () => channels.filter((channel) => !hidden.includes(channel.outletId)),
    [channels, hidden],
  )

  const totals = series?.totals
  // Peak per channel as the server computed it, rather than a re-scan of the
  // resolution-limited sample array — the summary bar's peak stays truthful even
  // when the window buckets are coarser than the device's 5 s posts.
  const totalStats = useMemo(() => seriesStats(visibleChannels.flatMap((c) => c.peakWatts)), [visibleChannels])

  const voltsRange = useMemo(() => {
    const values = visibleChannels.filter((c) => c.ratedVoltageVolts === 220).flatMap((c) => c.volts)
    return seriesStats(values)
  }, [visibleChannels])

  // Aggregate current: the sum of the branch readings, sensed channels only.
// Using the same helper as the inventory keeps the two pages from disagreeing
// about what "total current" means.
  const ampsNow = useMemo(
    () =>
      aggregatedCurrent(
        visibleChannels.map((channel) => ({
          amps: channel.amps,
          provenance: channel.provenance,
        })),
      ),
    [visibleChannels],
  )

  // "Total watts now" must come from the server's per-bucket SUM over the
  // selected channels (E6), not from the last value of the flattened channel
  // list — that would be whichever channel happens to sort last. Null stays an
  // em dash; it is never rendered as a false 0 W.
  const wattsNow = useMemo(() => {
    const values = totals?.watts
    if (!values) return null
    for (let i = values.length - 1; i >= 0; i -= 1) {
      const value = values[i]
      if (value !== null && value !== undefined) return value
    }
    return null
  }, [totals])

  // Window statistics over the aggregate trace — the same numbers the chart
  // plots, so a card can never disagree with the line above it. Same null
  // discipline as everywhere else: a gap is a gap, never a 0 W sample.
  const aggregateStats = useMemo(() => describeSeries(totals?.watts ?? []), [totals])

  // Bucket index of the extremes, so "peak at 14:46" is a real timestamp
  // rather than a decorative label.
  const extremes = useMemo(() => {
    const values = totals?.watts ?? []
    let minIndex = -1
    let maxIndex = -1
    values.forEach((value, index) => {
      if (value === null || value === undefined || !Number.isFinite(value)) return
      if (minIndex === -1 || (value as number) < (values[minIndex] as number)) minIndex = index
      if (maxIndex === -1 || (value as number) > (values[maxIndex] as number)) maxIndex = index
    })
    return { minIndex, maxIndex }
  }, [totals])

  // Energized share is expressed against REPORTED buckets, never against the
  // whole window: a bucket the device never posted to is a gap, and counting it
  // as idle load would claim a 0 W reading that was never taken.
  const duty = useMemo(() => {
    const values = totals?.watts ?? []
    const bucketSeconds = series?.bucketSeconds ?? 0
    let reported = 0
    let energized = 0
    let zeroLoad = 0
    for (const value of values) {
      if (value === null || value === undefined || !Number.isFinite(value)) continue
      reported += 1
      if ((value as number) > 0) energized += 1
      else zeroLoad += 1
    }
    return {
      reported,
      energized,
      buckets: values.length,
      reportedSeconds: reported * bucketSeconds,
      windowSeconds: values.length * bucketSeconds,
      ratio: reported > 0 ? (energized / reported) * 100 : null,
      zeroLoadShare: reported > 0 ? (zeroLoad / reported) * 100 : null,
    }
  }, [totals, series])

  const loadDistribution = useMemo(() => histogram(totals?.watts ?? [], HISTOGRAM_BINS), [totals])

  const distribution = useMemo(() => {
    if (!loadDistribution) return null
    const { min, max, counts } = loadDistribution
    const width = (max - min) / counts.length
    const total = counts.reduce((sum, count) => sum + count, 0)
    const peakIndex = counts.reduce((best, count, index) => (count > counts[best] ? index : best), 0)
    const peakCount = counts[peakIndex] || 1
    return {
      total,
      peak: peakIndex,
      peakCount,
      width,
      bins: counts.map((count, index) => ({
        lower: min + index * width,
        upper: min + (index + 1) * width,
        count,
        share: total > 0 ? (count / total) * 100 : 0,
        /** Bar height as a percentage of the modal bin, so the modal bin is always full-scale. */
        height: (count / peakCount) * 100,
      })),
    }
  }, [loadDistribution])

  const isDimmed = status === 'stale' || status === 'error'
  const faulted = sensorFault !== null
  const isEmpty = series !== null && channels.length === 0
  const allValuesNull = isEmpty || channels.every((c) => c.volts.every((v) => v === null))
  const deviceHasSamples = channels.some((c) => c.sampleCount > 0)
  const staleness = stalenessState(series?.latestSampleAt ?? null, now, deviceHasSamples)

  // Warn and trip rules, from the API's configured capacity — never constants.
  // Only drawn on the WATT tabs: a 1,200 W line has no meaning on a volt or amp
  // axis, and drawing one there would imply the other units were being compared
  // against a power limit.
  const thresholdLines: ThresholdLine[] =
    thresholds && (activeTab === 'total' || activeTab === 'watts')
      ? [
          { value: thresholds.warning, label: 'Warn', tone: 'warn' },
          { value: thresholds.critical, label: 'Trip', tone: 'trip' },
        ]
      : []

  const meterMode = series?.meteringMode ?? 'Unknown'
  const meterCopy = PROVENANCE_COPY[meterMode] ?? PROVENANCE_COPY.Unknown
  const isFiltered = channelFilter.length !== ALL_CHANNEL_IDS.length
  const longWindow = activeWindow === '24h' || activeWindow === '7d'

  const toChartSeries = (pick: (c: TelemetryChannel) => Array<number | null>): ChartSeries[] =>
    visibleChannels.map((channel) => ({
      id: `ch${channel.outletId}`,
      label: `CH${channel.outletId}`,
      color: channelColor(channel.outletId),
      dash: channelDash(channel.outletId),
      glyph: PROVENANCE_GLYPH[channel.provenance] ?? '○',
      title: channel.provenanceNote,
      values: pick(channel),
    }))

  const toggleChannel = (id: number) => {
    setHidden((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    )
  }

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    event.preventDefault()
    const next = event.key === 'ArrowRight' ? index + 1 : index - 1
    const wrapped = (next + CHART_TABS.length) % CHART_TABS.length
    setActiveTab(CHART_TABS[wrapped].id)
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    buttons?.[wrapped]?.focus()
  }

  const wattsCaption = meterMode === 'Simulated' ? WATTS_CAPTION_SIMULATED : WATTS_CAPTION
  const scopeLabel = isFiltered ? 'selected channels' : 'all rig channels'

  const cards: StatCardSpec[] = [
    {
      key: 'min',
      label: 'Min power',
      icon: <ArrowDown size={16} aria-hidden="true" />,
      value: faulted ? '—' : formatMetric(aggregateStats.min, 'W'),
      unit: 'W',
      ink: 'neutral',
      dot: 'bg-outline-variant',
      note:
        faulted ? (
          <span className="text-outline">not attributed — sensor fault latched</span>
        ) : aggregateStats.min === null ? (
          'No aggregate bucket reported'
        ) : (
          <>
            <span className="text-outline">lowest bucket</span>
            {mono(` ${utcStamp(series?.timestamps[extremes.minIndex], longWindow)} UTC`)}
          </>
        ),
    },
    {
      key: 'mean',
      label: 'Mean power (μ)',
      icon: <TrendingUp size={16} aria-hidden="true" />,
      value: faulted ? '—' : formatMetric(aggregateStats.mean, 'W'),
      unit: 'W',
      ink: 'neutral',
      dot: faulted ? 'ant-dot-critical' : 'bg-outline-variant',
      hero: true,
      note:
        faulted ? (
          <span className="text-outline">
            {aggregateStats.count.toLocaleString()} buckets posted blind — the device was not reading
          </span>
        ) : (
          <>
            <span className="text-outline">over</span>
            {mono(` ${aggregateStats.count.toLocaleString()} reported buckets`)}
          </>
        ),
    },
    {
      key: 'max',
      label: 'Max power',
      icon: <ArrowUp size={16} aria-hidden="true" />,
      value: faulted ? '—' : formatMetric(aggregateStats.max, 'W'),
      unit: 'W',
      ink: 'neutral',
      dot: faulted ? 'ant-dot-critical' : 'ant-dot-warning',
      note:
        faulted ? (
          <span className="text-outline">not attributed — sensor fault latched</span>
        ) : aggregateStats.max === null ? (
          'No aggregate bucket reported'
        ) : (
          <>
            <span className="text-outline">at</span>
            {mono(` ${utcStamp(series?.timestamps[extremes.maxIndex], longWindow)} UTC`)}
          </>
        ),
    },
    {
      key: 'sigma',
      label: 'Std deviation (σ)',
      icon: <Sigma size={16} aria-hidden="true" />,
      value:
        faulted || aggregateStats.stddev === null
          ? '—'
          : `±${formatMetric(aggregateStats.stddev, 'W')}`,
      unit: 'W',
      ink: 'neutral',
      dot: 'bg-outline-variant',
      note:
        faulted ? (
          <span className="text-outline">a flat zero line has no spread worth quoting</span>
        ) : aggregateStats.stddev === null || aggregateStats.mean === null || aggregateStats.mean === 0 ? (
          <span className="text-outline">needs 2+ reported buckets for a spread</span>
        ) : (
          <>
            <span className="text-outline">CV</span>
            {mono(` ${formatPercent((aggregateStats.stddev / aggregateStats.mean) * 100)}`)}
            <span className="text-outline">· sample σ (n−1)</span>
          </>
        ),
    },
    {
      key: 'duty',
      label: 'Energized ratio',
      icon: <Zap size={16} aria-hidden="true" />,
      value: faulted ? '—' : duty.ratio === null ? '—' : formatPercent(duty.ratio),
      unit: null,
      ink: 'neutral',
      dot: faulted ? 'ant-dot-critical' : duty.reported === 0 ? 'ant-dot-critical' : 'bg-outline-variant',
      note:
        faulted ? (
          <span className="text-outline">
            an energised ratio implies the load was observed; it was not
          </span>
        ) : duty.reported === 0 ? (
          <span className="text-outline">no reported buckets in this window</span>
        ) : (
          <>
            {mono(`${formatDuration(duty.reportedSeconds)} reported`)}
            <span className="text-outline">of</span>
            {mono(` ${formatDuration(duty.windowSeconds)}`)}
          </>
        ),
    },
  ]

  return (
    <section
      className="mx-auto flex w-full max-w-[1440px] flex-col gap-space-lg"
      aria-label="Telemetry"
    >
      {/* ---------------- Header & filter bar ---------------- */}
      <header className="flex flex-col gap-space-md lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-space-xs">
          <div className="flex flex-wrap items-center gap-space-sm">
            <h1 className="font-headline-md text-headline-md text-on-surface">
              Telemetry &amp; Statistical Analytics
            </h1>
            <span
              className="inline-flex items-center gap-1.5 font-body-sm text-body-sm text-on-surface-variant"
              title={staleness.label}
            >
              <span className={`ant-dot ${LIVE_DOT[staleness.tone]}`} aria-hidden="true" />
              {LIVE_LABEL[staleness.tone]}
            </span>
          </div>
          <p className="max-w-[76ch] font-body-md text-body-md text-on-surface-variant">
            Window statistics over the aggregate trace, the per-channel load over time, and the
            distribution of every reported bucket in the selected window.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-space-sm">
          {/* Window filter — pills. A segmented control implies five views; these
              are five windows over the SAME data, and a pill says that. */}
          <div
            className="flex flex-wrap items-center gap-1 rounded-lg bg-surface-container p-0.5"
            role="group"
            aria-label="Telemetry window"
          >
            {TELEMETRY_WINDOWS.map((option) => (
              <button
                key={option.id}
                type="button"
                title={option.label}
                aria-label={option.label}
                aria-pressed={option.id === activeWindow}
                onClick={() => setActiveWindow(option.id)}
                className={`h-7 rounded px-2.5 font-metric-value text-metric-value transition-colors ${
                  option.id === activeWindow
                    ? 'bg-surface-container-lowest font-semibold text-primary shadow-sm'
                    : 'text-on-surface-variant hover:text-on-surface'
                }`}
              >
                {option.id}
              </button>
            ))}
          </div>

          {/* Server-resolved window, not a picker: the backend owns the bucket grid */}
          <div
            className="flex h-10 items-center gap-2 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 shadow-card"
            title="Bucket range resolved by the server for the selected window"
          >
            <CalendarDays size={15} className="text-outline" aria-hidden="true" />
            <span className="font-metric-value text-metric-value text-on-surface-variant">
              {utcStamp(series?.from, longWindow)} – {utcStamp(series?.to, longWindow)} UTC
            </span>
          </div>

          <button
            type="button"
            className="ant-btn ant-btn-default w-8 !px-0"
            aria-label="Refresh telemetry now"
            onClick={() => void load(false)}
          >
            <RefreshCw
              size={16}
              className={status === 'refreshing' ? 'animate-spin motion-reduce:animate-none' : ''}
              aria-hidden="true"
            />
          </button>
        </div>
      </header>

      {/* ---------------- Channel filter pills ----------------
          Pills, not a dropdown. A dropdown hid the thing being filtered behind
          a click, and on a five-channel rig the whole roster fits on screen —
          so showing it costs nothing and means the provenance of each channel
          (● measured / ◐ nominal) is visible at the same moment as the choice.

          A filtered-out pill stays legible rather than fading out: "hidden" must
          not look like "no data", which is a different claim this page is
          careful about everywhere else. */}
      <div className="flex flex-col gap-space-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-label-sm text-label-sm uppercase text-on-surface-variant">
            Channels
          </span>
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter channels">
            {ALL_CHANNEL_IDS.map((id) => {
              const channel = channels.find((c) => c.outletId === id)
              const on = !hidden.includes(id)
              return (
                <button
                  key={id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleChannel(id)}
                  title={
                    channel
                      ? `${channel.name} · ${channel.ratedVoltageVolts} V · ${channel.provenance}\n${channel.provenanceNote}`
                      : `CH${id} · the API returned no samples for this channel in this window`
                  }
                  className={`flex h-7 items-center gap-1.5 rounded-md border px-2 font-metric-value text-metric-value transition-colors ${
                    on
                      ? 'border-outline-variant bg-surface-container-lowest text-on-surface hover:border-primary'
                      : 'border-outline-variant/60 bg-surface-container text-on-surface-variant'
                  }`}
                >
                  <span
                    className="h-3 w-1 shrink-0 rounded-sm"
                    style={{ background: channelColor(id) }}
                    aria-hidden="true"
                  />
                  {`CH${id}`}
                  <span
                    className="text-outline"
                    title={channel?.provenance ?? 'No samples'}
                    aria-label={channel?.provenance ?? 'No samples'}
                  >
                    {channel ? PROVENANCE_GLYPH[channel.provenance] ?? '○' : '○'}
                  </span>
                </button>
              )
            })}
          </div>

          {isFiltered && (
            <button
              type="button"
              className="ant-btn ant-btn-default h-7"
              onClick={() => setHidden([])}
            >
              Show all {ALL_CHANNEL_IDS.length}
            </button>
          )}
        </div>
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          <span title="Read from a sensor">●</span> measured ·{' '}
          <span title="A nominal rating, not a measurement">◐</span> nominal ·{' '}
          <span title="Nothing sampled in this window">○</span> no samples
        </p>
      </div>

      {/* ---------------- Provenance nameplate ----------------
          The rig shape stays visible: that is a fact a glance needs. The
          explanation of it, the per-channel notes and the exclusion record
          move behind one disclosure — this page is the one an examiner opens
          with "were those numbers measured?", and the record has to be a click
          away and complete, not so permanent that the statistics it qualifies
          are pushed off the screen. */}
      <div className={`flex flex-col gap-space-sm rounded-lg border p-space-md ${BANNER_FRAME}`}>
        <div className="flex flex-wrap items-baseline gap-x-space-sm gap-y-1">
          <span className="font-label-md text-label-md uppercase text-on-surface-variant">
            {METERING_MODE_LABEL[meterMode] ?? 'Unknown'}
          </span>
          <span className="font-title-md text-title-md text-on-surface">
            {meterMode === 'Metered'
              ? 'Four sensed branches, one shared voltage reading, one nominal rail'
              : meterMode === 'Simulated'
                ? 'No sensor is being read — the ESP32 is synthesising these values'
                : 'Provenance not reported by the device'}
          </span>
        </div>

        <Disclosure
          label="Reading provenance and exclusions"
          summary={`What these readings are, and are not — the device's own provenance note, the shared-volts caveat, and ${NOT_MEASURED.length} quantities this build does not measure`}
        >
          <p className="max-w-[96ch] font-body-sm text-body-sm text-on-surface-variant">
            {meterCopy.banner}
          </p>

          {/*
            The API's own per-channel note is rendered verbatim and in full. This
            is the most defensible sentence anywhere in this console: it is the
            only statement about a reading that is written by the code that
            produced it, not by the UI. It used to be truncated to fit a card,
            and then it was five permanent paragraphs.

            It is also, verbatim, THE SAME SENTENCE FOUR TIMES: the backend
            returns one rig-shape note for the four sensed branches, so CH1–CH4
            came back with an identical 45-word string and the panel printed it
            180 words deep with nothing to distinguish the rows. So the notes
            are grouped by what they actually say. A note shared by more than
            one channel is printed once, under the channel ids it covers — which
            is the fact the repetition was accidentally proving — and a channel
            whose note differs from the rest keeps its own line. Nothing is
            paraphrased, truncated or dropped; CH5, which genuinely is nominal,
            is the line that survives on its own.
          */}
          {channels.length > 0 && (
            <dl className="flex flex-col gap-1.5 border-t border-outline-variant pt-2">
              {groupedProvenance(channels).map((group) => (
                <div key={group.note} className="flex flex-col sm:flex-row sm:gap-2">
                  <dt className="shrink-0 font-metric-value text-metric-value font-medium text-on-surface sm:w-40">
                    {channelRange(group.channels)}
                    <span className="ml-1.5 font-body-sm text-body-sm font-normal text-outline">
                      {group.channels.map((c) => PROVENANCE_GLYPH[c.provenance] ?? '○').join('')}
                    </span>
                  </dt>
                  <dd className="font-body-sm text-body-sm text-on-surface-variant">
                    {group.shared ? (
                      <>
                        <span className="text-outline">
                          One note, returned identically for {group.channels.length} channels:
                        </span>{' '}
                      </>
                    ) : null}
                    {group.note}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          <p className="max-w-[96ch] font-body-sm text-body-sm text-on-surface-variant">
            {SHARED_VOLTS_NOTE} Retention:{' '}
            <span className="font-metric-value text-metric-value">{TELEMETRY_RETENTION_DAYS}</span>{' '}
            days of raw samples are stored; older samples are pruned. Pruning runs only while the host
            is awake, so history can be shorter than that.
          </p>

          {/* The exclusion record, stated so "absent" stays distinguishable from
              "forgot to render". Every entry once appeared on this console as a
              plausible figure. */}
          <div className="rounded-lg border border-outline-variant px-space-md py-space-sm">
            <p className="font-title-md text-title-md text-on-surface">
              Not measured — no figure is shown for these
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
        </Disclosure>
      </div>

      {status === 'unauthorized' ? (
        <article className="ant-card">
          <div className="ant-card-body flex flex-col gap-space-sm">
            <div className="flex items-center gap-space-sm">
              <Info size={18} className="text-error" aria-hidden="true" />
              <h2 className="font-title-lg text-title-lg text-on-surface">
                Sign in to view telemetry
              </h2>
            </div>
            <p className="max-w-[76ch] font-body-md text-body-md text-on-surface-variant">{error}</p>
          </div>
        </article>
      ) : series === null && (status === 'loading' || status === 'idle') ? (
        <article className="ant-card">
          <div className="ant-card-body flex flex-col gap-space-sm">
            <div className="flex items-center gap-space-sm">
              <Activity size={18} className="text-primary" aria-hidden="true" />
              <h2 className="font-title-lg text-title-lg text-on-surface">
                Reading the telemetry window
              </h2>
            </div>
            <p className="max-w-[76ch] font-body-md text-body-md text-on-surface-variant">
              Fetching the {activeWindow} buckets from Postgres. Nothing is drawn until the first
              bucket arrives — an empty axis would read as a zero load that was never measured.
            </p>
          </div>
        </article>
      ) : allValuesNull ? (
        <article className="ant-card">
          <div className="ant-card-body flex flex-col gap-space-sm">
            <div className="flex items-center gap-space-sm">
              <Info size={18} className="text-tertiary" aria-hidden="true" />
              <h2 className="font-title-lg text-title-lg text-on-surface">
                No telemetry in this window
              </h2>
            </div>
            <p className="max-w-[76ch] font-body-md text-body-md text-on-surface-variant">
              The ESP32 posts every 5 s, so an empty {series?.windowLabel.toLowerCase() ?? 'window'}{' '}
              means the device has not reported in that period — it may be offline, or the host may
              have been asleep. Nothing is plotted rather than plotting zeros.
            </p>
          </div>
        </article>
      ) : channelFilter.length === 0 ? (
        <article className="ant-card">
          <div className="ant-card-body flex flex-col items-start gap-space-sm">
            <div className="flex items-center gap-space-sm">
              <Info size={18} className="text-tertiary" aria-hidden="true" />
              <h2 className="font-title-lg text-title-lg text-on-surface">
                No channels selected
              </h2>
            </div>
            <p className="max-w-[76ch] font-body-md text-body-md text-on-surface-variant">
              Every channel is filtered out, so there is nothing to plot. The last good data is kept
              on screen rather than blanked — re-enable at least one channel to read the window.
            </p>
            <button
              type="button"
              className="ant-btn ant-btn-primary"
              onClick={() => setHidden([])}
            >
              Show all {ALL_CHANNEL_IDS.length} channels
            </button>
          </div>
        </article>
      ) : (
        <>
          {/* ---------------- Sensor fault, in place ----------------
              The global rail above already says it. This is the version that
              sits directly on the numbers, because on this page the numbers
              are far enough down that an operator reading the statistics may
              never have scrolled back past the chart header — and a window
              statistics row is exactly where an unattributable mean is most
              likely to be quoted. */}
          {faulted && sensorFault && (
            <div
              className="wash-critical flex items-start gap-space-sm px-space-md py-space-sm"
              role="alert"
            >
              <TriangleAlert size={18} className="mt-0.5 shrink-0 text-error" aria-hidden="true" />
              <div className="min-w-0">
                <p className="font-title-md text-title-md text-on-surface">
                  These statistics are computed over buckets the device posted blind
                </p>
                <p className="mt-0.5 max-w-[96ch] font-body-sm text-body-sm text-on-surface-variant">
                  {faultConsequence(sensorFault)} The trace below is still drawn — it is the record of
                  what was posted — but the min, mean, max and spread above it are held at no reading
                  rather than reported as a flat zero.
                </p>
              </div>
            </div>
          )}

          {/* ---------------- Window statistics ---------------- */}
          <div
            className="grid grid-cols-1 gap-space-md sm:grid-cols-2 xl:grid-cols-5"
            aria-label="Telemetry summary"
          >
            {cards.map((card) => (
              <article className="ant-card" key={card.key}>
                <div className="ant-card-body flex flex-1 flex-col justify-between gap-space-xs p-space-md">
                  <div className="flex items-center justify-between gap-space-sm">
                    <h2 className="font-title-lg text-title-lg text-on-surface-variant">{card.label}</h2>
                    <span className="text-outline" aria-hidden="true">
                      {card.icon}
                    </span>
                  </div>
                  <div className="flex items-baseline gap-1">
                    <span
                      className={
                        card.hero
                          ? `font-metric-display text-metric-display ${VALUE_INK[card.ink]}`
                          : `font-metric-value text-metric-value ${VALUE_INK[card.ink]}`
                      }
                    >
                      {card.value}
                    </span>
                    {card.unit && (
                      <span className="font-metric-value text-metric-value font-medium text-on-surface-variant">
                        {card.unit}
                      </span>
                    )}
                  </div>
                  <p className="flex items-center gap-1 font-body-sm text-body-sm text-on-surface-variant">
                    <span className={`ant-dot ${card.dot}`} aria-hidden="true" />
                    <span className="min-w-0">{card.note}</span>
                  </p>
                </div>
              </article>
            ))}
          </div>

          {failedAttempts > 0 && (
            <div className="wash-advisory flex flex-wrap items-center gap-space-sm px-space-md py-space-sm">
              <span className="ant-dot ant-dot-warning" aria-hidden="true" />
              <span className="font-body-sm text-body-sm text-on-surface">
                {error === 'Backend unreachable' ? (
                  <>
                    Backend cold start — retrying (
                    <span className="font-metric-value text-metric-value">{failedAttempts}</span>)
                  </>
                ) : (
                  <>
                    Retrying (
                    <span className="font-metric-value text-metric-value">{failedAttempts}</span>) —{' '}
                    {error ?? 'request failed'}
                  </>
                )}
              </span>
              <span className="font-body-sm text-body-sm text-on-surface-variant">
                showing the last good reading
              </span>
            </div>
          )}

          {/* ---------------- Time-series chart ---------------- */}
          <article className={`ant-card ${isDimmed ? 'opacity-60' : ''}`}>
            <div className="flex flex-col gap-space-md border-b border-outline-variant px-space-lg py-space-md lg:flex-row lg:items-center lg:justify-between">
              <div
                className="-mb-px flex flex-wrap items-center gap-space-lg"
                role="tablist"
                aria-label="Telemetry series"
              >
                {CHART_TABS.map((tab, index) => {
                  const selected = tab.id === activeTab
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      aria-controls="telemetry-plot"
                      tabIndex={selected ? 0 : -1}
                      onClick={() => setActiveTab(tab.id)}
                      onKeyDown={(event) => onTabKeyDown(event, index)}
                      className={`relative py-space-xs font-title-lg text-title-lg transition-colors ${
                        selected
                          ? 'text-primary font-semibold'
                          : 'text-on-surface-variant font-medium hover:text-on-surface'
                      }`}
                    >
                      {tab.label}
                      {selected && (
                        <span
                          className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-primary"
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  )
                })}
              </div>

              {/* Legend / controls */}
              <div className="flex flex-wrap items-center gap-space-md font-body-sm text-body-sm">
                {activeTab === 'total' ? (
                  <>
                    <span className="flex items-center gap-1.5">
                      <span className="h-0.5 w-3 bg-primary" aria-hidden="true" />
                      <span className="text-on-surface">Aggregate P_total (W)</span>
                    </span>
                    <span className="text-on-surface-variant">
                      {isFiltered ? (
                        'selected channels'
                      ) : (
                        <>
                          all{' '}
                          <span className="font-metric-value text-metric-value">
                            {ALL_CHANNEL_IDS.length}
                          </span>{' '}
                          rig channels
                        </>
                      )}
                    </span>
                  </>
                ) : (
                  visibleChannels.map((channel) => (
                    <span
                      key={`lg-${activeTab}-${channel.outletId}`}
                      className="flex items-center gap-1.5"
                      title={channel.provenanceNote}
                    >
                      <span
                        className="h-0.5 w-3"
                        style={{
                          background: channelColor(channel.outletId),
                          borderStyle: channelDash(channel.outletId) ? 'dashed' : 'solid',
                        }}
                        aria-hidden="true"
                      />
                      <span className="text-on-surface">
                        {PROVENANCE_GLYPH[channel.provenance] ?? '○'}{' '}
                        <span className="font-metric-value text-metric-value">
                          CH{channel.outletId}
                        </span>
                      </span>
                    </span>
                  ))
                )}
              </div>
            </div>

            <div
              className="ant-card-body"
              id="telemetry-plot"
              role="tabpanel"
              aria-label={CHART_TABS.find((tab) => tab.id === activeTab)?.label}
            >
              {activeTab === 'total' && (
                <TimeSeriesChart
                  title={`Total load — ${scopeLabel}`}
                  unit="W"
                  series={[
                    {
                      id: 'total',
                      label: isFiltered ? 'Selected channels' : 'All channels',
                      color: '#2B5A8F',
                      values: totals?.watts ?? [],
                    },
                  ]}
                  timestamps={series?.timestamps ?? []}
                  showArea
                  height={300}
                  thresholds={thresholdLines}
                  scaleToThresholds={scaleToThresholds}
                />
              )}
              {activeTab === 'watts' && (
                <TimeSeriesChart
                  title="Per-channel watts"
                  unit="W"
                  series={toChartSeries((c) => c.watts)}
                  timestamps={series?.timestamps ?? []}
                  height={300}
                  thresholds={thresholdLines}
                  scaleToThresholds={scaleToThresholds}
                />
              )}
              {activeTab === 'amps' && (
                <TimeSeriesChart
                  title="Per-channel current"
                  unit="A"
                  series={toChartSeries((c) => c.amps)}
                  timestamps={series?.timestamps ?? []}
                />
              )}
              {activeTab === 'volts' && (
                <TimeSeriesChart
                  title="Per-channel volts"
                  unit="V"
                  series={toChartSeries((c) => c.volts)}
                  timestamps={series?.timestamps ?? []}
                />
              )}

              {/* Scale control. Only meaningful while a threshold is drawn, so
                  it is not offered on the amp and volt tabs where a power limit
                  would be meaningless. */}
              {thresholdLines.length > 0 && (
                <div className="mt-space-sm flex flex-wrap items-center gap-space-sm font-body-sm text-body-sm">
                  <span className="text-on-surface-variant">Y-axis</span>
                  <div className="flex items-center gap-1 rounded-md bg-surface-container p-0.5" role="group" aria-label="Chart y-axis scale">
                    <button
                      type="button"
                      aria-pressed={scaleToThresholds}
                      onClick={() => setScaleToThresholds(true)}
                      title="Include the warn and trip lines in the axis range, so the trace is shown against the full configured capacity"
                      className={`h-6 rounded px-2 font-metric-value text-metric-value transition-colors ${
                        scaleToThresholds
                          ? 'bg-surface-container-lowest font-semibold text-primary shadow-sm'
                          : 'text-on-surface-variant hover:text-on-surface'
                      }`}
                    >
                      Full capacity
                    </button>
                    <button
                      type="button"
                      aria-pressed={!scaleToThresholds}
                      onClick={() => setScaleToThresholds(false)}
                      title="Fit the axis to the trace alone, for reading the waveform"
                      className={`h-6 rounded px-2 font-metric-value text-metric-value transition-colors ${
                        !scaleToThresholds
                          ? 'bg-surface-container-lowest font-semibold text-primary shadow-sm'
                          : 'text-on-surface-variant hover:text-on-surface'
                      }`}
                    >
                      Fit trace
                    </button>
                  </div>
                  {thresholds && (
                    <span className="font-metric-value text-metric-value text-outline">
                      {`Warn ${thresholds.warning.toLocaleString()} W · Trip ${thresholds.critical.toLocaleString()} W`}
                    </span>
                  )}
                </div>
              )}

              <p className="mt-space-md max-w-[96ch] font-body-sm text-body-sm text-on-surface-variant">
                {activeTab === 'amps'
                  ? AMPS_CAPTION
                  : activeTab === 'volts'
                    ? `${VOLTS_CAPTION}${meterMode === 'Metered' ? ` ${VOLTS_CAPTION_METERED}` : ''}`
                    : wattsCaption}
              </p>
            </div>
          </article>

          {/* ---------------- Channel × time heatmap ---------------- */}
          <article className="ant-card">
            <div className="ant-card-header">
              <div>
                <h2 className="font-title-lg text-title-lg text-on-surface">
                  Channel load over time
                </h2>
                <p className="max-w-[76ch] font-body-sm text-body-sm text-on-surface-variant">
                  One row per channel, one column per time slot, shaded by the mean load in
                  that slot. An empty cell is a slot the device never reported in — not a slot
                  it reported as idle.
                </p>
              </div>
              <span className="shrink-0 font-metric-value text-metric-value text-on-surface-variant">
                {`${series?.bucketCount ?? 0} buckets · ${series?.resolution ?? '—'}`}
              </span>
            </div>
            <div className="ant-card-body">
              <ChannelHeatmap
                channels={visibleChannels}
                timestamps={series?.timestamps ?? []}
                bucketSeconds={series?.bucketSeconds ?? 0}
                faulted={faulted}
              />
            </div>
          </article>

          {/* ---------------- Load distribution ---------------- */}
          <article className="ant-card">
            <div className="ant-card-header">
              <div>
                <h2 className="font-title-lg text-title-lg text-on-surface">
                  Aggregate load distribution
                </h2>
                <p className="font-body-sm text-body-sm text-on-surface-variant">
                  {distribution
                    ? (
                        <>
                          <span className="font-metric-value text-metric-value">
                            {Math.round(distribution.width)}
                          </span>{' '}
                          W bands across the reported buckets in this window
                        </>
                      )
                    : 'Probability mass per band across the window'}
                </p>
              </div>
              <span className="shrink-0 font-metric-value text-metric-value text-on-surface-variant">
                {distribution
                  ? `N = ${distribution.total.toLocaleString()} buckets`
                  : 'no data'}
              </span>
            </div>
            <div className="ant-card-body">
              {/*
                A distribution of a flat zero line is the single most convincing
                lie this page could tell: every bar lines up, the dominant band is
                crisp, the percentages sum to 100, and the picture it draws is an
                artifact of the fault rather than a shape of the load. The panel
                keeps its frame and its position — removing it would shift every
                reading below it — and states what it cannot show instead.
              */}
              {faulted ? (
                <div className="prov-rail prov-rail--faulted">
                  <p className="font-title-md text-title-md text-on-surface">
                    No distribution is drawn while the fault is latched
                  </p>
                  <p className="mt-1 max-w-[76ch] font-body-sm text-body-sm text-on-surface-variant">
                    Every bucket in this window posted zero because no sensor was
                    answering, so the samples collapse into a single band. Plotting that
                    as a load distribution would present the absence of a measurement as
                    the shape of a load. The count of buckets that were posted is still
                    stated below, because that part is real.
                  </p>
                  <p className="mt-1.5 font-metric-value text-metric-value text-on-surface-variant">
                    {aggregateStats.count.toLocaleString()} buckets posted ·{' '}
                    {series?.bucketCount ?? 0} expected ·{' '}
                    {`${series?.bucketSeconds ?? 0} s each`}
                  </p>
                </div>
              ) : distribution ? (
                <>
                  <div
                    className="flex h-40 items-end gap-1"
                    role="img"
                    aria-label={`Aggregate load distribution across ${distribution.total} reported buckets, modal band ${formatMetric(distribution.bins[distribution.peak].lower, 'W')} to ${formatMetric(distribution.bins[distribution.peak].upper, 'W')} watts`}
                  >
                    {distribution.bins.map((bin, index) => {
                      const isPeak = index === distribution.peak
                      return (
                        <div key={bin.lower} className="flex h-full flex-1 flex-col gap-1">
                          <span
                            className={`text-center font-metric-value text-metric-value ${isPeak ? 'font-semibold text-primary' : 'text-outline'}`}
                          >
                            {formatPercent(bin.share)}
                          </span>
                          <div className="flex min-h-0 flex-1 items-end">
                            <div
                              className={`w-full rounded-t transition-colors ${
                                isPeak ? 'bg-primary' : 'bg-primary-fixed hover:bg-primary-container'
                              }`}
                              style={{ height: `${Math.max(2, bin.height)}%` }}
                              title={`${formatMetric(bin.lower, 'W')}–${formatMetric(bin.upper, 'W')} W · ${formatPercent(bin.share)} (n=${bin.count})`}
                            />
                          </div>
                          <span
                            className={`whitespace-nowrap text-center font-metric-value text-metric-value ${isPeak ? 'font-semibold text-primary' : 'text-on-surface-variant'}`}
                          >
                            {formatMetric(bin.lower, 'W')}
                          </span>
                        </div>
                      )
                    })}
                  </div>

                  {/* Screen-reader story: the band counts, reachable without reading the bars. */}
                  <table className="sr-only">
                    <caption>Aggregate load distribution across the reported buckets</caption>
                    <thead>
                      <tr>
                        <th scope="col">Band (W)</th>
                        <th scope="col">Buckets</th>
                        <th scope="col">Share</th>
                      </tr>
                    </thead>
                    <tbody>
                      {distribution.bins.map((bin) => (
                        <tr key={`sr-${bin.lower}`}>
                          <th scope="row">
                            {formatMetric(bin.lower, 'W')}–{formatMetric(bin.upper, 'W')}
                          </th>
                          <td>{bin.count}</td>
                          <td>{formatPercent(bin.share)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <div className="mt-space-md flex flex-wrap items-center justify-between gap-space-sm rounded-lg bg-surface-container-low px-space-sm py-space-sm font-body-sm text-body-sm text-on-surface-variant">
                    <span>
                      Dominant band{' '}
                      <strong className="font-metric-value text-metric-value font-semibold text-on-surface">
                        {formatMetric(distribution.bins[distribution.peak].lower, 'W')}–
                        {formatMetric(distribution.bins[distribution.peak].upper, 'W')} W
                      </strong>{' '}
                      · {formatPercent(distribution.bins[distribution.peak].share)} of reported buckets
                    </span>
                    <span>
                      zero-load buckets:{' '}
                      <span className="font-metric-value text-metric-value">
                        {duty.zeroLoadShare === null ? '—' : formatPercent(duty.zeroLoadShare)}
                      </span>
                    </span>
                  </div>
                </>
              ) : (
                <p className="font-body-sm text-body-sm text-on-surface-variant">
                  No aggregate buckets were reported in this window, so there is no distribution to
                  draw. A gap is not a zero-load sample.
                </p>
              )}
            </div>
          </article>

          {/* ---------------- Telemetry summary bar ---------------- */}
          <div className="flex flex-col gap-space-md rounded-lg border border-outline-variant bg-surface-container-lowest p-space-md shadow-sm lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-space-sm">
              <Activity size={18} className="text-primary" aria-hidden="true" />
              <span className="font-body-md text-body-md text-on-surface">{staleness.label}</span>
            </div>

            <dl className="flex flex-wrap items-center gap-x-space-lg gap-y-space-sm font-body-sm text-body-sm text-on-surface-variant">
              <div className="flex flex-wrap items-center gap-1">
                <dt>Total now</dt>
                <dd className="font-metric-value text-metric-value font-medium text-on-surface">
                  {faulted ? 'no reading' : wattsNow !== null ? `${formatMetric(wattsNow, 'W')} W` : '—'}
                </dd>
              </div>
              <div className="flex items-center gap-1">
                <dt>Peak / channel</dt>
                <dd className="font-metric-value text-metric-value font-medium text-on-surface">
                  {faulted ? 'no reading' : totalStats.max !== null ? `${formatValue(totalStats.max, 'W')} W` : '—'}
                </dd>
              </div>
              <div className="flex items-center gap-1">
                {/* Named for what it is: a range over ONE shared reading. Calling
                    it "220 V range" implied four independent measurements. */}
                <dt title={SHARED_VOLTS_NOTE}>Mains volts (shared)</dt>
                <dd className="font-metric-value text-metric-value font-medium text-on-surface">
                  {faulted
                    ? 'no reading'
                    : voltsRange.min !== null && voltsRange.max !== null
                      ? `${formatValue(voltsRange.min, 'V')}–${formatValue(voltsRange.max, 'V')} V`
                      : '—'}
                </dd>
              </div>
              <div className="flex items-center gap-1">
                <dt>Amps (sum of branches)</dt>
                <dd className="font-metric-value text-metric-value font-medium text-on-surface">
                  {faulted ? 'no reading' : ampsNow !== null ? `${formatValue(ampsNow, 'A')} A` : '—'}
                </dd>
              </div>
              {/*
                Energy (kWh) was here and has been removed.

                The API does return an `energyKwhDelta`, and on a live rig it
                reads 0 — not because nothing was used, but because the firmware
                posts energyKwh = 0.0 on every single reading and no accumulator
                runs anywhere on the device. Rendering it produced "0.000 kWh"
                under a heading that meant kilowatt-hours, which is the most
                damaging kind of wrong on this page: a number that looks
                measured, is formatted to three decimals, and is measurably
                false. The API field is untouched — it is simply not shown.
              */}
              <div className="flex items-center gap-1">
                <dt>Samples</dt>
                <dd className="font-metric-value text-metric-value font-medium text-on-surface">
                  {series ? `${series.rawSampleCount.toLocaleString()} @ ${series.resolution}` : '—'}
                </dd>
              </div>
              <div className="flex items-center gap-1">
                <dt>Window</dt>
                <dd className="font-metric-value text-metric-value font-medium">
                  {series
                    ? series.windowLabel.toLowerCase()
                    : status === 'loading'
                      ? 'loading…'
                      : 'no data'}
                </dd>
                <span className={`ant-dot ${LIVE_DOT[staleness.tone]}`} aria-hidden="true" />
              </div>
            </dl>
          </div>

          {/*
            The shared-volts caveat and the exclusion record used to sit here as
            two permanent blocks at the foot of the page. They are now in the
            provenance disclosure at the top, which is where a reader looking for
            "were these numbers measured?" actually starts — and where they can
            be read before the charts rather than after every chart.
          */}
        </>
      )}
    </section>
  )
}