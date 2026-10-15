import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Activity,
  ArrowDown,
  ArrowUp,
  CalendarDays,
  ChevronDown,
  Info,
  RefreshCw,
  Sigma,
  SlidersHorizontal,
  TrendingUp,
  Zap,
} from 'lucide-react'
import {
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
  POLL_INTERVAL_MS,
  PROVENANCE_COPY,
  PROVENANCE_GLYPH,
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
  BAND_DOT,
  BAND_LABEL,
  CRITICAL_THRESHOLD,
  WARNING_THRESHOLD,
  loadBand,
  type LoadBand,
} from '../data/dashboard'
import {
  backoffMs,
  describeSeries,
  formatValue,
  histogram,
  seriesStats,
  stalenessState,
  type Unit,
} from '../utils/telemetry'
import { TimeSeriesChart, type ChartSeries } from './TimeSeriesChart'

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
 * Green is not a state colour in this console. A duty cycle reading is a
 * measured statistic, not an approval, so the energised ratio is inked the same
 * neutral as the min/max beside it; blue stays reserved for the one figure this
 * view treats as its headline.
 */
const VALUE_INK: Record<'neutral' | 'primary' | 'success', string> = {
  neutral: 'text-on-surface',
  primary: 'text-primary',
  success: 'text-on-surface-variant',
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
  // View-only state: which plotted series is mounted, and whether the channel
  // filter panel is open. Neither changes what is fetched.
  const [activeTab, setActiveTab] = useState<ChartTabId>('total')
  const [channelsOpen, setChannelsOpen] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const requestSeqRef = useRef(0)
  // Mirrors failedAttempts so the self-rescheduling poll can read it without
  // taking it as a dependency (which would restart the timer on every miss).
  const failuresRef = useRef(0)
  const channelFilterRef = useRef<HTMLDivElement>(null)

  const channelFilter = useMemo(() => ALL_CHANNEL_IDS.filter((id) => !hidden.includes(id)), [hidden])

  const load = useCallback(
    async (isRefresh: boolean) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      const seq = ++requestSeqRef.current

      setStatus(isRefresh ? 'refreshing' : 'loading')

      try {
        const payload = await fetchTelemetrySeries(activeWindow, channelFilter, controller.signal)

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

  // The channel filter is a disclosure, not a trap: dismiss on outside click or
  // Escape so a keyboard operator is never stranded inside the panel.
  useEffect(() => {
    if (!channelsOpen) return

    const onPointerDown = (event: MouseEvent) => {
      if (channelFilterRef.current && !channelFilterRef.current.contains(event.target as Node)) {
        setChannelsOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setChannelsOpen(false)
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [channelsOpen])

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

  // Sum of the last non-null amps across the selected channels, so "total" means
  // total. Nulls are skipped, never treated as zero.
  const ampsNow = useMemo(() => {
    let sum = 0
    for (const channel of visibleChannels) {
      for (let i = channel.amps.length - 1; i >= 0; i -= 1) {
        const value = channel.amps[i]
        if (value !== null && value !== undefined) {
          sum += value
          break
        }
      }
    }
    return sum
  }, [visibleChannels])

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
  const isEmpty = series !== null && channels.length === 0
  const allValuesNull = isEmpty || channels.every((c) => c.volts.every((v) => v === null))
  const deviceHasSamples = channels.some((c) => c.sampleCount > 0)
  const staleness = stalenessState(series?.latestSampleAt ?? null, now, deviceHasSamples)

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

  // Band and headroom are stated against the rig's configured thresholds rather
  // than hardcoded, so an admin threshold change moves the indicator with it.
  const currentBand: LoadBand =
    wattsNow === null ? 'normal' : loadBand(wattsNow, WARNING_THRESHOLD, CRITICAL_THRESHOLD)
  const headroomWatts = wattsNow === null ? null : CRITICAL_THRESHOLD - wattsNow

  const cards: StatCardSpec[] = [
    {
      key: 'min',
      label: 'Min power',
      icon: <ArrowDown size={16} aria-hidden="true" />,
      value: formatMetric(aggregateStats.min, 'W'),
      unit: 'W',
      ink: 'neutral',
      dot: 'bg-outline-variant',
      note:
        aggregateStats.min === null ? (
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
      value: formatMetric(aggregateStats.mean, 'W'),
      unit: 'W',
      ink: 'primary',
      dot: 'bg-outline-variant',
      hero: true,
      note: (
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
      value: formatMetric(aggregateStats.max, 'W'),
      unit: 'W',
      ink: 'neutral',
      dot: 'ant-dot-warning',
      note:
        aggregateStats.max === null ? (
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
        aggregateStats.stddev === null
          ? '—'
          : `±${formatMetric(aggregateStats.stddev, 'W')}`,
      unit: 'W',
      ink: 'neutral',
      dot: 'bg-outline-variant',
      note:
        aggregateStats.stddev === null || aggregateStats.mean === null || aggregateStats.mean === 0 ? (
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
      value: duty.ratio === null ? '—' : formatPercent(duty.ratio),
      unit: null,
      ink: 'success',
      dot: duty.reported === 0 ? 'ant-dot-critical' : 'bg-outline-variant',
      note:
        duty.reported === 0 ? (
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
      {/*
        No lede paragraph. The view is read as an instrument, so the header is
        just the live dot and the window label; the explanation of what this
        view is for lives in the retention tooltip at the foot.
      */}
      <header className="flex flex-col gap-space-md lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-space-xs">
          <div className="flex flex-wrap items-center gap-space-sm">
            <h1 className="font-headline-md text-headline-md text-on-surface">
              Telemetry &amp; Analytics
            </h1>
            <span
              className="inline-flex items-center gap-1.5 font-body-sm text-body-sm text-on-surface-variant"
              title={staleness.label}
            >
              <span className={`ant-dot ${LIVE_DOT[staleness.tone]}`} aria-hidden="true" />
              {LIVE_LABEL[staleness.tone]}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-space-sm">
          {/* Channel filter — the tag dropdown */}
          <div className="relative" ref={channelFilterRef}>
            <button
              type="button"
              className="ant-btn ant-btn-default"
              aria-haspopup="true"
              aria-expanded={channelsOpen}
              onClick={() => setChannelsOpen((current) => !current)}
            >
              <SlidersHorizontal size={16} className="text-outline" aria-hidden="true" />
              <span className="text-on-surface-variant">Channels</span>
              <span className="font-metric-value text-metric-value font-medium text-on-surface">
                {isFiltered
                  ? `${channelFilter.length} of ${ALL_CHANNEL_IDS.length}`
                  : `All ${ALL_CHANNEL_IDS.length}`}
              </span>
              <ChevronDown size={14} className="text-outline" aria-hidden="true" />
            </button>

            {channelsOpen && (
              <div className="absolute right-0 top-10 z-30 flex w-[320px] flex-col gap-space-sm rounded-lg border border-outline-variant bg-surface-container-lowest p-space-sm shadow-lg">
                <div className="flex items-center justify-between">
                  <span className="font-title-md text-title-md text-on-surface">Channel filter</span>
                  <span className="flex gap-space-xs">
                    <button
                      type="button"
                      className="ant-btn ant-btn-default h-6"
                      onClick={() => setHidden([])}
                    >
                      All
                    </button>
                    <button
                      type="button"
                      className="ant-btn ant-btn-default h-6"
                      onClick={() => setHidden([...ALL_CHANNEL_IDS])}
                    >
                      None
                    </button>
                  </span>
                </div>

                <ul className="flex flex-col gap-1">
                  {ALL_CHANNEL_IDS.map((id) => {
                    const channel = channels.find((c) => c.outletId === id)
                    const off = hidden.includes(id)
                    return (
                      <li key={id}>
                        <button
                          type="button"
                          aria-pressed={!off}
                          onClick={() => toggleChannel(id)}
                          title={
                            channel
                              ? `${channel.name} · ${channel.ratedVoltageVolts} V · ${channel.provenanceNote}`
                              : `Channel ${id} · no samples in this window`
                          }
                          className={`flex w-full items-center gap-space-sm rounded border px-space-sm py-space-xs text-left transition-colors ${
                            off
                              ? 'border-surface-container bg-surface-container-low text-outline'
                              : 'border-outline-variant bg-surface-container-lowest text-on-surface hover:border-primary'
                          }`}
                        >
                          <span
                            className="h-3.5 w-1 shrink-0 rounded-sm"
                            style={{ background: channelColor(id) }}
                            aria-hidden="true"
                          />
                          <span className="font-metric-value text-metric-value font-medium">CH{id}</span>
                          <span className="min-w-0 flex-1 truncate font-body-sm text-body-sm">
                            {channel ? channel.name : 'no samples'}
                          </span>
                          <span className="font-metric-value text-metric-value text-on-surface-variant">
                            {channel ? `${channel.ratedVoltageVolts} V` : '—'}
                          </span>
                          <span
                            className="font-body-sm text-body-sm"
                            title={channel ? channel.provenance : 'Unknown'}
                            aria-label={channel ? channel.provenance : 'Unknown'}
                          >
                            {channel ? PROVENANCE_GLYPH[channel.provenance] ?? '○' : '○'}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>

                <p className="font-body-sm text-body-sm text-on-surface-variant">
                  ● measured · ◐ derived · ○ simulated
                </p>
              </div>
            )}
          </div>

          {/* Window segmented control */}
          <div className="ant-segmented" role="group" aria-label="Telemetry window">
            {TELEMETRY_WINDOWS.map((option) => (
              <button
                key={option.id}
                type="button"
                title={option.label}
                aria-label={option.label}
                aria-pressed={option.id === activeWindow}
                onClick={() => setActiveWindow(option.id)}
                className={`ant-segmented-item font-metric-value text-metric-value ${
                  option.id === activeWindow
                    ? 'ant-segmented-item-active font-semibold text-primary'
                    : 'hover:text-on-surface'
                }`}
              >
                {option.id}
              </button>
            ))}
          </div>

          {/* Server-resolved window, not a picker: the backend owns the bucket grid */}
          <div
            className="flex h-8 items-center gap-2 rounded-lg border border-surface-container bg-surface-container-lowest px-2.5 shadow-sm"
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

      {/*
        Provenance chip. This was a full-width honesty banner — the one block of
        prose the view opened with. The text is not deleted, it is the tooltip;
        the chip itself states the mode in two words so the fact is never more
        than a glance away, and it stays monochrome because "simulated" is a
        provenance fact and not one of the three health states.
      */}
      <div
        className={`flex w-fit max-w-full items-center gap-2 rounded-full border px-3 py-1 ${BANNER_FRAME}`}
        title={meterCopy.banner}
      >
        <span className="font-body-sm text-body-sm font-medium uppercase tracking-wide text-on-surface-variant">
          {METERING_MODE_LABEL[meterMode] ?? 'Unknown'}
        </span>
        <span className="font-metric-value text-metric-value text-outline">
          {meterMode === 'Metered'
            ? 'INA226 + branch CT'
            : meterMode === 'Simulated'
              ? 'ESP32 synthesised'
              : 'not reported'}
        </span>
      </div>

      {status === 'unauthorized' ? (
        <article className="ant-card">
          <div className="ant-card-body flex items-center gap-space-sm">
            <Info size={18} className="shrink-0 text-error" aria-hidden="true" />
            <span className="font-title-lg text-title-lg text-on-surface">{error}</span>
          </div>
        </article>
      ) : series === null && (status === 'loading' || status === 'idle') ? (
        <article className="ant-card">
          <div className="ant-card-body flex items-center gap-space-sm">
            <Activity size={18} className="shrink-0 text-primary" aria-hidden="true" />
            <span
              className="font-title-lg text-title-lg text-on-surface"
              title="Fetching the buckets from Postgres. Nothing is drawn until the first bucket arrives — an empty axis would read as a zero load that was never measured."
            >
              {`Reading ${activeWindow}…`}
            </span>
          </div>
        </article>
      ) : allValuesNull ? (
        <article className="ant-card">
          <div className="ant-card-body flex items-center gap-space-sm">
            <Info size={18} className="shrink-0 text-tertiary" aria-hidden="true" />
            <span
              className="font-title-lg text-title-lg text-on-surface"
              title="The ESP32 posts every second, so an empty window means the device has not reported in that period — it may be offline, or the host may have been asleep. Nothing is plotted rather than plotting zeros."
            >
              No samples in window
            </span>
          </div>
        </article>
      ) : channelFilter.length === 0 ? (
        <article className="ant-card">
          <div className="ant-card-body flex flex-wrap items-center gap-space-sm">
            <Info size={18} className="shrink-0 text-tertiary" aria-hidden="true" />
            <span
              className="font-title-lg text-title-lg text-on-surface"
              title="Every channel is filtered out, so there is nothing to plot. The last good data is kept on screen rather than blanked."
            >
              No channels
            </span>
            <button type="button" className="ant-btn ant-btn-primary" onClick={() => setHidden([])}>
              {`Show all ${ALL_CHANNEL_IDS.length}`}
            </button>
          </div>
        </article>
      ) : (
        <>
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
            <div className="flex flex-wrap items-center gap-space-sm rounded-lg border border-tertiary-fixed-dim bg-tertiary-fixed px-space-md py-space-sm">
              <span className="ant-dot ant-dot-warning" aria-hidden="true" />
              <span className="font-body-sm text-body-sm text-on-tertiary-fixed">
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
              <span className="font-body-sm text-body-sm text-on-tertiary-fixed">
                showing the last good reading
              </span>
            </div>
          )}

          {/* ---------------- Time-series chart ---------------- */}
          <article className={`ant-card ${isDimmed ? 'opacity-60' : ''}`}>
            <div className="flex flex-col gap-space-md border-b border-surface-container px-space-lg py-space-md lg:flex-row lg:items-center lg:justify-between">
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
                      color: '#0057c2',
                      values: totals?.watts ?? [],
                    },
                  ]}
                  timestamps={series?.timestamps ?? []}
                  showArea
                />
              )}
              {activeTab === 'watts' && (
                <TimeSeriesChart
                  title="Per-channel watts"
                  unit="W"
                  series={toChartSeries((c) => c.watts)}
                  timestamps={series?.timestamps ?? []}
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

              {/*
                The per-axis caption used to sit under the chart as a paragraph.
                It is the most important honesty note in this view — derived
                amps, nominal volts — so it is kept verbatim as a tooltip and
                flagged by a ⓘ rather than deleted or truncated.
              */}
              <span
                className="mt-space-md inline-flex w-fit items-center gap-1.5 font-code text-code text-outline"
                title={
                  activeTab === 'amps'
                    ? AMPS_CAPTION
                    : activeTab === 'volts'
                      ? `${VOLTS_CAPTION}${meterMode === 'Metered' ? ` ${VOLTS_CAPTION_METERED}` : ''}`
                      : wattsCaption
                }
              >
                <Info size={12} aria-hidden="true" />
                {activeTab === 'watts' ? 'derived share' : activeTab === 'amps' ? 'derived P/V' : 'rated rail'}
              </span>
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
              {distribution ? (
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
                                isPeak ? 'bg-primary' : 'bg-primary-fixed-dim hover:bg-primary-fixed'
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
                <span
                  className="font-body-sm text-body-sm text-on-surface-variant"
                  title="No aggregate buckets were reported in this window, so there is no distribution to draw. A gap is not a zero-load sample."
                >
                  No buckets reported — a gap is not a zero-load sample.
                </span>
              )}
            </div>
          </article>

          {/* ---------------- Telemetry summary bar ---------------- */}
          <div className="flex flex-col gap-space-md rounded-lg border border-surface-container bg-surface-container-lowest p-space-md shadow-sm lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-space-sm">
              <Activity size={18} className="text-primary" aria-hidden="true" />
              <span className="font-body-md text-body-md text-on-surface">{staleness.label}</span>
              <span
                className={`ant-dot ${BAND_DOT[currentBand]}`}
                title={
                  currentBand === 'normal'
                    ? `Below the ${WARNING_THRESHOLD} W warning threshold`
                    : currentBand === 'warning'
                      ? 'Inside the warning band — FR-05 raises an event'
                      : 'At or over the critical threshold — FR-06 sheds'
                }
                aria-hidden="true"
              />
              <span className="font-metric-value text-metric-value text-on-surface-variant">
                {BAND_LABEL[currentBand]}
              </span>
            </div>

            <dl className="flex flex-wrap items-center gap-x-space-lg gap-y-space-sm font-body-sm text-body-sm text-on-surface-variant">
              <div className="flex items-center gap-1">
                <dt>Total now</dt>
                <dd className="font-metric-value text-metric-value font-medium text-on-surface">
                  {wattsNow !== null ? `${formatMetric(wattsNow, 'W')} W` : '—'}
                </dd>
              </div>
              <div
                className="flex items-center gap-1"
                title={`Margin between the newest reported bucket and the ${CRITICAL_THRESHOLD} W critical threshold`}
              >
                <dt>Headroom</dt>
                <dd
                  className={`font-metric-value text-metric-value font-medium ${
                    headroomWatts === null
                      ? 'text-on-surface'
                      : headroomWatts <= 0
                        ? 'text-error'
                        : currentBand === 'warning'
                          ? 'text-tertiary-container'
                          : 'text-on-surface'
                  }`}
                >
                  {headroomWatts === null
                    ? '—'
                    : headroomWatts <= 0
                      ? `${formatMetric(Math.abs(headroomWatts), 'W')} W over`
                      : `${formatMetric(headroomWatts, 'W')} W`}
                </dd>
              </div>
              <div className="flex items-center gap-1">
                <dt>Peak / channel</dt>
                <dd className="font-metric-value text-metric-value font-medium text-on-surface">
                  {totalStats.max !== null ? `${formatValue(totalStats.max, 'W')} W` : '—'}
                </dd>
              </div>
              <div className="flex items-center gap-1">
                <dt>220 V class</dt>
                <dd className="font-metric-value text-metric-value font-medium text-on-surface">
                  {voltsRange.min !== null && voltsRange.max !== null
                    ? `${formatValue(voltsRange.min, 'V')}–${formatValue(voltsRange.max, 'V')} V`
                    : '—'}
                </dd>
              </div>
              <div className="flex items-center gap-1">
                <dt>Amps</dt>
                <dd className="font-metric-value text-metric-value font-medium text-on-surface">
                  {formatValue(ampsNow, 'A')} A
                </dd>
              </div>
              <div className="flex items-center gap-1">
                <dt>Energy</dt>
                <dd className="font-metric-value text-metric-value font-medium text-on-surface">
                  {totals?.energyKwhDelta != null
                    ? `${totals.energyKwhDelta.toFixed(3)} kWh`
                    : '—'}
                </dd>
              </div>
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

          <div
            className="font-body-sm text-body-sm text-on-surface-variant"
            title={`Retention: ${TELEMETRY_RETENTION_DAYS} days of raw samples are stored; older samples are pruned. Pruning runs only while the host is awake, so history can be shorter than that.`}
          >
            {`ⓘ ${TELEMETRY_RETENTION_DAYS}d retention`}
          </div>
        </>
      )}
    </section>
  )
}