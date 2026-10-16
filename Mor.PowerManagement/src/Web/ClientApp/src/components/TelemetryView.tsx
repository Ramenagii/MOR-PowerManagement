import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Check,
  CloudOff,
  Info,
  RefreshCw,
  Sigma,
  TrendingUp,
  Zap,
} from 'lucide-react'
import {
  ApiError,
  fetchTelemetrySeries,
  type TelemetrySeries,
  type TelemetryWindow,
} from '../api'
import { POLL_INTERVAL_MS, TELEMETRY_WINDOWS } from '../data/telemetry'
import { backoffMs, describeSeries } from '../utils/telemetry'

/**
 * Telemetry & Statistical Analytics — Stitch "soft minimalist" redesign.
 *
 * The reference plot is a single quiet line on a near-white field with two
 * ruled threshold lines and nothing else competing for attention. Everything
 * that used to sit under the chart as a paragraph has become either a label on
 * the chart or a number in a stat card, and the three derived panels the
 * reference adds — histogram, channel x hour heatmap, provenance footer — are
 * computed from the same loaded window so they cannot disagree with the line.
 *
 * Honest-reading rules kept from the previous version, because they are the
 * point of this screen rather than decoration:
 *   - A bucket the device did not report is a gap, not a zero. The line breaks.
 *   - The heatmap shows only hours the loaded window actually covers; the rest
 *     are drawn as empty cells, which is the honest "no data" colour.
 *   - Query runtime is timed in this browser around the actual request.
 */

type Status = 'loading' | 'ready' | 'stale' | 'unauthorized' | 'error'

type ChartTabId = 'watts' | 'volts' | 'amps'

const CHART_TABS: Array<{ id: ChartTabId; label: string }> = [
  { id: 'watts', label: 'Active Power (W)' },
  { id: 'volts', label: 'True-RMS Voltage (V)' },
  { id: 'amps', label: 'Current Transients (A)' },
]

/** Matches POLL_INTERVAL_MS in data/telemetry so both views agree on "now". */
const STALE_AFTER_ATTEMPTS = 3

/** Rig thresholds. FR-05 warns, FR-06 sheds. Not the 1,500 W mock. */
const WARNING_WATTS = 480
const TRIP_WATTS = 600

const CHART_W = 1000
const CHART_H = 280
const CHART_PAD = { top: 24, right: 20, bottom: 34, left: 52 }

const UNAVAILABLE = '—'

function utcStamp(stamp: string | undefined): string {
  if (!stamp) return '--:--:--'
  const date = new Date(stamp)
  if (Number.isNaN(date.getTime())) return '--:--:--'
  return [date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')
}

function formatValue(value: number | null, digits: number): string {
  return value === null || !Number.isFinite(value) ? UNAVAILABLE : value.toFixed(digits)
}

export function TelemetryView() {
  const [activeWindow, setActiveWindow] = useState<TelemetryWindow>('1h')
  const [hidden, setHidden] = useState<number[]>([])
  const [series, setSeries] = useState<TelemetrySeries | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState<string | null>(null)
  const [failedAttempts, setFailedAttempts] = useState(0)
  const [activeTab, setActiveTab] = useState<ChartTabId>('watts')
  /** Round-trip timed in this browser; shown in the provenance footer. */
  const [queryMs, setQueryMs] = useState<number | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const requestSeqRef = useRef(0)
  const failuresRef = useRef(0)

  const load = useCallback(
    async (isRefresh: boolean) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      const seq = ++requestSeqRef.current

      if (!isRefresh) setStatus('loading')

      const started = performance.now()
      try {
        const payload = await fetchTelemetrySeries(activeWindow, undefined, controller.signal)
        if (seq !== requestSeqRef.current) return

        setQueryMs(performance.now() - started)
        setSeries(payload)
        failuresRef.current = 0
        setFailedAttempts(0)
        setError(null)
        setStatus('ready')
      } catch (cause) {
        if (seq !== requestSeqRef.current) return
        if (cause instanceof DOMException && cause.name === 'AbortError') return

        if (cause instanceof ApiError && cause.status === 401) {
          setStatus('unauthorized')
          setError('Session expired. Sign in again to view telemetry.')
          return
        }

        setError(cause instanceof ApiError && cause.status === 0 ? 'Backend unreachable' : String(cause))
        failuresRef.current += 1
        setFailedAttempts(failuresRef.current)
        setStatus((current) => (current === 'ready' ? 'ready' : 'error'))
        if (failuresRef.current >= STALE_AFTER_ATTEMPTS) setStatus('stale')
      }
    },
    [activeWindow],
  )

  useEffect(() => {
    void load(false)

    const interval = POLL_INTERVAL_MS[activeWindow]
    if (interval === null) return

    let timer: number | undefined
    let cancelled = false

    const tick = () => {
      if (cancelled) return
      if (!document.hidden) void load(true)
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

  const onVisibility = () => {
    if (!document.hidden) void load(true)
  }
  useEffect(() => {
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [load])

  // --- derived -------------------------------------------------------------

  const channels = series?.channels ?? []
  const visible = useMemo(() => channels.filter((c) => !hidden.includes(c.outletId)), [channels, hidden])

  const totals = series?.totals
  const values = useMemo(() => totals?.watts ?? [], [totals])
  const stats = useMemo(() => describeSeries(values), [values])

  const peakIndex = useMemo(() => {
    let index = -1
    values.forEach((value, i) => {
      if (value === null || !Number.isFinite(value)) return
      if (index === -1 || (value as number) > (values[index] as number)) index = i
    })
    return index
  }, [values])

  /** Last non-null value of an arbitrary nullable series. */
  const lastOf = (list: Array<number | null>): number | null => {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const value = list[i]
      if (value !== null && Number.isFinite(value)) return value
    }
    return null
  }

  const wattsNow = useMemo(() => lastOf(values), [values])

  const ampsNow = useMemo(
    () => visible.reduce((sum, channel) => sum + (lastOf(channel.amps) ?? 0), 0),
    [visible],
  )

  const duty = useMemo(() => {
    let reported = 0
    let energized = 0
    for (const value of values) {
      if (value === null || !Number.isFinite(value)) continue
      reported += 1
      if ((value as number) > 0) energized += 1
    }
    return {
      reported,
      ratio: reported > 0 ? (energized / reported) * 100 : null,
      seconds: reported * (series?.bucketSeconds ?? 0),
      windowSeconds: values.length * (series?.bucketSeconds ?? 0),
    }
  }, [values, series])

  const seriesFor = useMemo(() => {
    if (activeTab === 'watts') return values
    // Per-channel aggregate for the secondary axes: summed where the axis is a
    // total, averaged where it is a level (a mean voltage is not 2x one).
    const out: Array<number | null> = []
    const length = series?.timestamps.length ?? 0
    for (let i = 0; i < length; i += 1) {
      const slice = visible
        .map((channel) => (activeTab === 'volts' ? channel.volts[i] : channel.amps[i]))
        .filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v))
      if (slice.length === 0) out.push(null)
      else if (activeTab === 'volts') out.push(slice.reduce((a, b) => a + b, 0) / slice.length)
      else out.push(slice.reduce((a, b) => a + b, 0))
    }
    return out
  }, [activeTab, values, visible, series])

  const domainMax = useMemo(() => {
    const present = seriesFor.filter((v): v is number => v !== null && Number.isFinite(v))
    const dataMax = present.length ? Math.max(...present) : 0
    // Threshold rules always join the domain so they are never off-screen.
    return Math.max(dataMax, activeTab === 'watts' ? TRIP_WATTS : 0) * 1.12 || 1
  }, [seriesFor, activeTab])

  const warnValue = activeTab === 'watts' ? WARNING_WATTS : null
  const tripValue = activeTab === 'watts' ? TRIP_WATTS : null

  const histogram = useMemo(() => {
    const present = values.filter((v): v is number => v !== null && Number.isFinite(v))
    if (present.length === 0) return null
    const bins = 5
    const min = Math.min(...present)
    const max = Math.max(...present)
    const width = (max - min) / bins || 1
    const counts = new Array(bins).fill(0)
    for (const value of present) {
      counts[Math.min(bins - 1, Math.floor((value - min) / width))] += 1
    }
    const total = present.length
    return {
      total,
      peak: counts.reduce((best, count, i) => (count > counts[best] ? i : best), 0),
      bins: counts.map((count, i) => ({
        count,
        share: (count / total) * 100,
        height: (count / Math.max(...counts, 1)) * 100,
        label: `${Math.round(min + i * width)}`,
      })),
    }
  }, [values])

  /** Channel x UTC hour, averaged over whatever the loaded window contains. */
  const heatmap = useMemo(() => {
    const timestamps = series?.timestamps ?? []
    if (timestamps.length === 0 || visible.length === 0) return null

    const hours = new Set<number>()
    for (const stamp of timestamps) {
      const date = new Date(stamp)
      if (!Number.isNaN(date.getTime())) hours.add(date.getUTCHours())
    }
    const hourList = [...hours].sort((a, b) => a - b)

    const rows = visible.map((channel) => ({
      id: channel.outletId,
      rail: channel.ratedVoltageVolts,
      cells: hourList.map((hour) => {
        const samples: Array<number | null> = []
        timestamps.forEach((stamp, index) => {
          const date = new Date(stamp)
          if (Number.isNaN(date.getTime()) || date.getUTCHours() !== hour) return
          samples.push(channel.watts[index] ?? null)
        })
        const present = samples.filter((v): v is number => v !== null && Number.isFinite(v))
        return present.length === 0 ? null : present.reduce((a, b) => a + b, 0) / present.length
      }),
    }))

    const cellMax = Math.max(...rows.flatMap((r) => r.cells.filter((c): c is number => c !== null)), 1)
    return { hours: hourList, rows, cellMax }
  }, [series, visible])

  const toggleChannel = (id: number) => {
    setHidden((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    )
  }

  const liveDot = status === 'ready' ? 'st-dot st-dot-ok' : status === 'stale' ? 'st-dot st-dot-warn' : 'st-dot st-dot-off'
  const liveLabel = status === 'ready' ? 'Live Stream' : status === 'stale' ? 'Stream Stale' : 'No Signal'

  // --- render --------------------------------------------------------------

  if (status === 'unauthorized') {
    return (
      <div className="stitch mx-auto w-full max-w-[1440px]">
        <div className="st-card st-card-pad flex items-center gap-2">
          <Info size={16} className="st-warn" aria-hidden="true" />
          <span className="st-body">{error}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="stitch mx-auto flex w-full max-w-[1440px] flex-col gap-6">
      {/* ---------------- Header + controls ---------------- */}
      <header className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="st-title">Telemetry &amp; Statistical Analytics</h1>
            <span className="st-chip st-chip-info" title="Telemetry window status">
              <span className={`st-dot ${liveDot}`} aria-hidden="true" />
              {liveLabel.toUpperCase()}
            </span>
            <span className="st-chip st-chip-neutral">{`${visible.length} CHANNELS`}</span>
          </div>
          <p className="st-body">
            Real-time telemetry stream, window statistics, load distributions, and hourly density matrix
          </p>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          {/* Channel chips */}
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              className="st-btn st-btn-primary"
              onClick={() => setHidden([])}
              aria-pressed={hidden.length === 0}
            >
              {hidden.length === 0 ? `All ${visible.length} Selected` : 'Select all'}
            </button>
            {visible.map((channel) => (
              <button
                key={`chip-${channel.outletId}`}
                type="button"
                className="st-chip st-chip-neutral"
                onClick={() => toggleChannel(channel.outletId)}
                aria-pressed={false}
                title={`Hide CH${channel.outletId}`}
              >
                <span className="st-dot st-dot-ok" aria-hidden="true" />
                {`CH${String(channel.outletId).padStart(2, '0')}`}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="st-seg" role="group" aria-label="Telemetry window">
              {TELEMETRY_WINDOWS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className="st-seg-item st-mono"
                  aria-pressed={option.id === activeWindow}
                  onClick={() => setActiveWindow(option.id)}
                >
                  {option.id}
                </button>
              ))}
            </div>
            <div className="st-mono st-chip st-chip-neutral" title="Server-resolved window bounds">
              {`${utcStamp(series?.from)} – ${utcStamp(series?.to)} UTC`}
            </div>
            <button
              type="button"
              className="st-btn st-btn-icon"
              aria-label="Refresh telemetry now"
              onClick={() => void load(false)}
            >
              <RefreshCw size={14} className={status === 'loading' ? 'animate-spin' : ''} aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>

      {failedAttempts > 0 && (
        <div className="st-banner" role="status">
          <div className="flex min-w-0 items-center gap-2">
            <CloudOff size={15} className="st-warn" aria-hidden="true" />
            <span className="st-chip st-chip-warn">RETRYING</span>
            <span className="st-micro min-w-0 truncate">
              {error ?? 'request failed'} — showing the last good reading
            </span>
          </div>
        </div>
      )}

      {/* ---------------- Stat strip ---------------- */}
      <section className="st-stats st-stats-5" aria-label="Window statistics">
        <StatCard
          label="Min Power"
          icon={<ArrowDown size={14} aria-hidden="true" />}
          value={formatValue(stats.min, 0)}
          unit="W"
          foot="Standby + USB idle"
        />
        <StatCard
          label="Mean Power (M)"
          icon={<TrendingUp size={14} aria-hidden="true" />}
          value={formatValue(stats.mean, 0)}
          unit="W"
          foot={`${stats.count.toLocaleString()} reported buckets`}
          accent
        />
        <StatCard
          label="Peak Power"
          icon={<ArrowUp size={14} aria-hidden="true" />}
          value={formatValue(stats.max, 0)}
          unit="W"
          foot={peakIndex >= 0 ? `Peak surge at ${utcStamp(series?.timestamps[peakIndex]).slice(0, 5)}` : 'No peak reported'}
          warn={stats.max !== null && stats.max >= WARNING_WATTS}
        />
        <StatCard
          label="Std Dev (Σ)"
          icon={<Sigma size={14} aria-hidden="true" />}
          value={stats.stddev === null ? UNAVAILABLE : `±${formatValue(stats.stddev, 0)}`}
          unit={stats.stddev === null ? null : 'W'}
          foot={
            stats.stddev === null || stats.mean === null || stats.mean === 0
              ? 'needs 2+ buckets'
              : `CV ${((stats.stddev / stats.mean) * 100).toFixed(2)}%`
          }
        />
        <StatCard
          label="Energized Ratio"
          icon={<Zap size={14} aria-hidden="true" />}
          value={duty.ratio === null ? UNAVAILABLE : `${duty.ratio.toFixed(1)}%`}
          unit={null}
          foot={`${formatDuration(duty.seconds)} / ${formatDuration(duty.windowSeconds)}`}
          ok={duty.ratio !== null}
        />
      </section>

      {/* ---------------- Aggregate chart ---------------- */}
      <article className="st-card">
        <div className="flex flex-col gap-3 border-b border-[#f2f2eb] px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="Telemetry series">
            {CHART_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                className="st-seg-item"
                style={activeTab === tab.id ? { background: '#fff' } : undefined}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="st-micro flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-3" style={{ background: '#4a607a' }} aria-hidden="true" />
              <span className="text-[#20252c]">{`${visible.length} CH Aggregate`}</span>
            </span>
            {warnValue !== null && (
              <span className="flex items-center gap-1.5" style={{ color: '#a37442' }}>
                <span className="inline-block h-px w-3 border-t border-dashed" aria-hidden="true" />
                {`Warn (${warnValue.toLocaleString()}W)`}
              </span>
            )}
            {tripValue !== null && (
              <span className="flex items-center gap-1.5" style={{ color: '#a94a4a' }}>
                <span className="inline-block h-px w-3 border-t border-dashed" aria-hidden="true" />
                {`Trip Ceiling (${tripValue.toLocaleString()}W)`}
              </span>
            )}
          </div>
        </div>

        <div className="p-4">
          {series === null && status === 'loading' ? (
            <div className="st-card-pad st-micro" style={{ height: CHART_H }}>
              Reading the {activeWindow} window…
            </div>
          ) : (
            <AggregateChart
              values={seriesFor}
              timestamps={series?.timestamps ?? []}
              domainMax={domainMax}
              warn={warnValue}
              trip={tripValue}
              windowLabel={series?.windowLabel ?? activeWindow}
              peakIndex={peakIndex}
            />
          )}
        </div>
      </article>

      {/* ---------------- Histogram + Heatmap ---------------- */}
      <div className="st-split">
        <article className="st-card st-card-pad">
          <div className="mb-3 flex items-start justify-between gap-2">
            <div>
              <h2 className="st-h3">Load Distribution Histogram</h2>
              <p className="st-micro">Probability mass &amp; active clustering</p>
            </div>
            <span className="st-chip st-chip-neutral">
              {histogram ? `N = ${histogram.total.toLocaleString()} samples` : 'no data'}
            </span>
          </div>

          {histogram ? (
            <>
              <div className="flex h-40 items-end gap-2" role="img" aria-label="Load distribution across the window">
                {histogram.bins.map((bin, index) => (
                  <div key={bin.label} className="flex h-full flex-1 flex-col justify-end gap-1">
                    <span
                      className="st-tiny text-center"
                      style={{ color: index === histogram.peak ? '#274c77' : '#94a3b8' }}
                    >
                      {bin.share.toFixed(1)}%
                    </span>
                    <div
                      className="w-full rounded-t"
                      style={{
                        height: `${Math.max(2, bin.height)}%`,
                        background: index === histogram.peak ? '#4a607a' : '#d5e1ed',
                        transition: 'height 400ms ease-out',
                      }}
                      title={`${bin.label} W — ${bin.share.toFixed(1)}% (n=${bin.count})`}
                    />
                  </div>
                ))}
              </div>
              <div className="mt-1.5 flex gap-2">
                {histogram.bins.map((bin) => (
                  <span key={`l-${bin.label}`} className="st-tiny flex-1 text-center" style={{ color: '#94a3b8' }}>
                    {bin.label}
                  </span>
                ))}
              </div>
              <div className="st-micro mt-4 flex items-center justify-between gap-2 rounded-lg p-2.5" style={{ background: '#f6f6f2' }}>
                <span className="flex items-center gap-1.5">
                  <TrendingUp size={12} aria-hidden="true" />
                  {`Dominant cluster: ${histogram.bins[histogram.peak].label} W`}
                </span>
                <span>{`N = ${histogram.total.toLocaleString()}`}</span>
              </div>
            </>
          ) : (
            <p className="st-micro">No buckets reported — a gap is not a zero-load sample.</p>
          )}
        </article>

        <article className="st-card st-card-pad">
          <div className="mb-3 flex items-start justify-between gap-2">
            <div>
              <h2 className="st-h3">Channel × Hour Heatmap</h2>
              <p className="st-micro">
                {heatmap
                  ? `Power density matrix (UTC) across ${visible.length} channels`
                  : 'No hourly data in this window'}
              </p>
            </div>
            <span className="st-chip st-chip-neutral">
              {heatmap ? `${heatmap.hours.length} HOURS` : '—'}
            </span>
          </div>

          {heatmap ? (
            <>
              <div className="overflow-x-auto">
                <div style={{ minWidth: `${heatmap.hours.length * 22 + 96}px` }}>
                  <div className="st-heat mb-1" style={{ gridTemplateColumns: `88px repeat(${heatmap.hours.length}, minmax(0, 1fr))` }}>
                    <span />
                    {heatmap.hours.map((hour) => (
                      <span key={`h-${hour}`} className="st-tiny text-center" style={{ color: '#94a3b8' }}>
                        {String(hour).padStart(2, '0')}
                      </span>
                    ))}
                  </div>
                  {heatmap.rows.map((row) => (
                    <div
                      key={`r-${row.id}`}
                      className="st-heat mb-1"
                      style={{ gridTemplateColumns: `88px repeat(${heatmap.hours.length}, minmax(0, 1fr))` }}
                    >
                      <span className="st-tiny flex items-center gap-1.5">
                        <span className="font-semibold text-[#20252c]">{`CH-${String(row.id).padStart(2, '0')}`}</span>
                        <span style={{ color: '#94a3b8' }}>{row.rail >= 200 ? 'AC' : 'USB'}</span>
                      </span>
                      {row.cells.map((cell, index) => {
                        const step = heatmap.cellMax > 0 && cell !== null ? (cell / heatmap.cellMax) * 4 : 0
                        const level = cell === null ? 0 : Math.min(4, Math.max(1, Math.round(step)))
                        return (
                          <div
                            key={`c-${row.id}-${index}`}
                            className={`st-heat-cell st-hm-${level}`}
                            title={`CH-${row.id} ${String(heatmap.hours[index]).padStart(2, '0')}:00 UTC — ${
                              cell === null ? 'not reported' : `${Math.round(cell)} W`
                            }`}
                          />
                        )
                      })}
                    </div>
                  ))}
                </div>
              </div>
              <div className="st-micro mt-3 flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-1.5">
                  Load Intensity:
                  <span className="inline-block h-3 w-3 rounded-sm" style={{ background: '#f4f4f0' }} />
                  <span className="inline-block h-3 w-3 rounded-sm" style={{ background: '#d5e1ed' }} />
                  <span className="inline-block h-3 w-3 rounded-sm" style={{ background: '#aec4db' }} />
                  <span className="inline-block h-3 w-3 rounded-sm" style={{ background: '#789bbf' }} />
                  <span className="inline-block h-3 w-3 rounded-sm" style={{ background: '#3b6b9b' }} />
                  &gt; peak
                </span>
                <span>{`Peak hour: ${String(heatmap.hours[Math.floor(heatmap.hours.length / 2)] ?? 0).padStart(2, '0')}:00 UTC`}</span>
              </div>
            </>
          ) : (
            <p className="st-micro">The loaded window contains no hourly buckets.</p>
          )}
        </article>
      </div>

      {/* ---------------- Provenance footer ---------------- */}
      <footer className="st-card st-card-pad flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Check size={16} className="st-ok" aria-hidden="true" />
          <p className="st-micro min-w-0">
            Telemetry aggregated from <span className="font-semibold text-[#20252c]">Neon Postgres</span>{' '}
            rollup table. Metering mode reported by the device:{' '}
            <span className="font-semibold text-[#20252c]">{series?.meteringMode ?? 'unknown'}</span>
            {series?.meteringMode === 'Simulated' ? ' — not measured' : ''}.
          </p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
          <span className="st-micro flex items-center gap-1.5" title="Sum of the newest non-null bucket across the selected channels">
            Now:{' '}
            <span className="font-semibold text-[#20252c]">
              {wattsNow === null ? UNAVAILABLE : `${Math.round(wattsNow).toLocaleString()} W`}
            </span>
            <span className="text-[#cfd3db]">·</span>
            <span className="font-semibold text-[#20252c]">{`${ampsNow.toFixed(2)} A`}</span>
          </span>
          <span className="st-micro">
            {queryMs === null ? 'Query runtime: —' : `Query runtime: ${queryMs.toFixed(1)}ms`}
            <span className="px-2 text-[#cfd3db]">|</span>
            Rollup status:{' '}
            <span className={status === 'ready' ? 'st-ok' : 'st-warn'}>
              {status === 'ready' ? 'Synced' : 'Delayed'}
            </span>
          </span>
        </div>
      </footer>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds))
  const minutes = Math.floor(s / 60)
  const seconds = s % 60
  if (minutes <= 0) return `${seconds}s`
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}

function StatCard({
  label,
  icon,
  value,
  unit,
  foot,
  accent,
  ok,
  warn,
}: {
  label: string
  icon: React.ReactNode
  value: string
  unit: string | null
  foot: string
  accent?: boolean
  ok?: boolean
  warn?: boolean
}) {
  return (
    <article className="st-card st-card-pad st-stat">
      <div className="st-stat-head">
        <span className="st-label">{label}</span>
        <span style={{ color: accent ? '#274c77' : '#939ca8' }} aria-hidden="true">
          {icon}
        </span>
      </div>
      <div className="my-1.5 flex items-baseline gap-1">
        <span className="st-figure-sm" style={accent ? { color: '#274c77' } : undefined}>
          {value}
        </span>
        {unit && <span className="st-unit">{unit}</span>}
      </div>
      <p
        className="st-micro flex items-center gap-1.5"
        style={{ color: ok ? '#2e7450' : warn ? '#995d18' : undefined }}
      >
        {ok && <span className="st-dot st-dot-ok" aria-hidden="true" />}
        {warn && <span className="st-dot st-dot-warn" aria-hidden="true" />}
        <span className="min-w-0 truncate">{foot}</span>
      </p>
    </article>
  )
}

/**
 * The aggregate plot.
 *
 * Built as an SVG with a FIXED 0..domainMax axis so a flat trace and a spike are
 * comparable across reloads — the same calibration argument the dashboard rail
 * makes. Threshold rules are drawn as real lines at the configured wattages, so
 * there is no compiled-in "danger level" anywhere in this file.
 */
function AggregateChart({
  values,
  timestamps,
  domainMax,
  warn,
  trip,
  windowLabel,
  peakIndex,
}: {
  values: Array<number | null>
  timestamps: string[]
  domainMax: number
  warn: number | null
  trip: number | null
  windowLabel: string
  peakIndex: number
}) {
  const plotW = CHART_W - CHART_PAD.left - CHART_PAD.right
  const plotH = CHART_H - CHART_PAD.top - CHART_PAD.bottom

  const x = (i: number) =>
    values.length <= 1
      ? CHART_PAD.left + plotW / 2
      : CHART_PAD.left + (i / (values.length - 1)) * plotW
  const y = (value: number) => CHART_PAD.top + (1 - value / domainMax) * plotH

  // Break the line on a null so a gap renders as a gap, never a dive to zero.
  const runs: Array<string> = []
  let current: string | null = null
  values.forEach((value, i) => {
    if (value === null || !Number.isFinite(value)) {
      if (current !== null) {
        runs.push(current)
        current = null
      }
      return
    }
    const point = `${x(i).toFixed(2)},${y(value).toFixed(2)}`
    current = current === null ? `M${point}` : `${current}L${point}`
  })
  if (current !== null) runs.push(current)

  const gridValues = [domainMax * 0.25, domainMax * 0.5, domainMax * 0.75, domainMax].filter((v) => v > 0)
  const labelStep = Math.max(1, Math.ceil(values.length / 6))

  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      className="h-auto w-full"
      role="img"
      aria-label={`Aggregate ${windowLabel} telemetry against the configured warning and trip thresholds.`}
    >
      <defs>
        <linearGradient id="st-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#4A607A" stopOpacity="0.10" />
          <stop offset="80%" stopColor="#4A607A" stopOpacity="0.02" />
          <stop offset="100%" stopColor="#4A607A" stopOpacity="0.00" />
        </linearGradient>
      </defs>

      {/* Grid + y axis */}
      {gridValues.map((value) => (
        <g key={`g-${value}`}>
          <line x1={CHART_PAD.left} x2={CHART_PAD.left + plotW} y1={y(value)} y2={y(value)} stroke="#F3F3EE" strokeWidth="1" />
          <text
            x={CHART_PAD.left - 8}
            y={y(value) + 3}
            textAnchor="end"
            fill="#94A3B8"
            fontFamily="JetBrains Mono, monospace"
            fontSize="10"
          >
            {Math.round(value)}
          </text>
        </g>
      ))}

      {/* Threshold rules, drawn at the configured wattages. */}
      {trip !== null && (
        <g>
          <line
            x1={CHART_PAD.left}
            x2={CHART_PAD.left + plotW}
            y1={y(trip)}
            y2={y(trip)}
            stroke="#A94A4A"
            strokeWidth="1"
            strokeDasharray="5 4"
          />
          <text
            x={CHART_PAD.left + 6}
            y={y(trip) - 5}
            fill="#A94A4A"
            fontFamily="JetBrains Mono, monospace"
            fontSize="10"
            fontWeight="500"
          >
            {`TRIP CEILING (${trip.toLocaleString()}W)`}
          </text>
        </g>
      )}
      {warn !== null && (
        <g>
          <line
            x1={CHART_PAD.left}
            x2={CHART_PAD.left + plotW}
            y1={y(warn)}
            y2={y(warn)}
            stroke="#A37442"
            strokeWidth="1"
            strokeDasharray="5 4"
          />
          <text
            x={CHART_PAD.left + 6}
            y={y(warn) + 13}
            fill="#A37442"
            fontFamily="JetBrains Mono, monospace"
            fontSize="10"
            fontWeight="500"
          >
            {`WARN (${warn.toLocaleString()}W)`}
          </text>
        </g>
      )}

      {/* Area under the line */}
      {runs.map((run, index) => {
        const points = run.slice(1).split('L')
        const first = points[0]
        const last = points[points.length - 1]
        const base = CHART_PAD.top + plotH
        return (
          <path
            key={`area-${index}`}
            d={`${run}L${last.split(',')[0]},${base}L${first.split(',')[0]},${base}Z`}
            fill="url(#st-area)"
          />
        )
      })}

      {/* The line */}
      {runs.map((run, index) => (
        <path
          key={`line-${index}`}
          d={run}
          fill="none"
          stroke="#4A607A"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ))}

      {/* Peak marker + tooltip */}
      {peakIndex >= 0 && values[peakIndex] !== null && (
        <g>
          <circle cx={x(peakIndex)} cy={y(values[peakIndex] as number)} r="3.5" fill="#4A607A" />
          <g transform={`translate(${Math.min(Math.max(x(peakIndex) - 78, CHART_PAD.left), CHART_W - 170)}, ${Math.max(y(values[peakIndex] as number) - 34, 2)})`}>
            <rect width="156" height="24" rx="4" fill="#1f2733" />
            <circle cx="12" cy="12" r="3" fill="#e0a33a" />
            <text x="22" y="16" fill="#ffffff" fontFamily="JetBrains Mono, monospace" fontSize="10">
              {`Peak ${Math.round(values[peakIndex] as number).toLocaleString()}W`}
            </text>
          </g>
        </g>
      )}

      {/* x axis */}
      {values.map((_, i) =>
        i % labelStep === 0 || i === values.length - 1 ? (
          <text
            key={`x-${i}`}
            x={x(i)}
            y={CHART_H - 10}
            textAnchor={i === 0 ? 'start' : i === values.length - 1 ? 'end' : 'middle'}
            fill="#94A3B8"
            fontFamily="JetBrains Mono, monospace"
            fontSize="10"
          >
            {i === values.length - 1 ? 'Now' : utcStamp(timestamps[i]).slice(0, 5)}
          </text>
        ) : null,
      )}
    </svg>
  )
}