import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, RefreshCw } from 'lucide-react'
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
import { backoffMs, formatValue, seriesStats, stalenessState } from '../utils/telemetry'
import { MetricCard } from './MetricCard'
import { TimeSeriesChart, type ChartSeries } from './TimeSeriesChart'

type Status = 'idle' | 'loading' | 'refreshing' | 'ready' | 'stale' | 'unauthorized' | 'error'

/** Failure threshold before the view switches to the "backend is cold" story. */
const STALE_AFTER_ATTEMPTS = 3

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
  // Empty means "all 13". Kept as a list so a partial filter is expressible.
  const [hidden, setHidden] = useState<number[]>([])
  const [series, setSeries] = useState<TelemetrySeries | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const [failedAttempts, setFailedAttempts] = useState(0)
  // Drives the relative-time labels only. Never triggers a refetch, so a 7-day
  // view does not hammer the backend once a second.
  const [now, setNow] = useState(() => Date.now())

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

  const channels = series?.channels ?? []
  const visibleChannels = useMemo(
    () => channels.filter((channel) => !hidden.includes(channel.outletId)),
    [channels, hidden],
  )

  const totals = series?.totals
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

  const wattsStats = useMemo(() => seriesStats(visibleChannels.flatMap((c) => c.watts)), [visibleChannels])

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

  const isDimmed = status === 'stale' || status === 'error'
  const isEmpty = series !== null && channels.length === 0
  const allValuesNull = isEmpty || channels.every((c) => c.volts.every((v) => v === null))
  const deviceHasSamples = channels.some((c) => c.sampleCount > 0)
  const staleness = stalenessState(series?.latestSampleAt ?? null, now, deviceHasSamples)

  const meterMode = series?.meteringMode ?? 'Unknown'
  const meterCopy = PROVENANCE_COPY[meterMode] ?? PROVENANCE_COPY.Unknown
  const isFiltered = channelFilter.length !== ALL_CHANNEL_IDS.length

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

  return (
    <section className="view-stack" aria-label="Telemetry">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Telemetry</p>
          <h2>Sensor readings · voltage, current, power</h2>
        </div>
        <div className="page-heading-actions">
          <span className={`provenance-tag ${meterCopy.tone}`}>
            {METERING_MODE_LABEL[meterMode] ?? 'Unknown'}
          </span>
          <Activity size={22} />
        </div>
      </div>

      <p className={`safe-note provenance-banner ${meterCopy.tone}`}>{meterCopy.banner}</p>
      <p className="safe-note">
        Retention: {TELEMETRY_RETENTION_DAYS} days of raw samples are stored; older samples are pruned.
        Pruning runs only while the host is awake, so history can be shorter than that.
      </p>

      <div className="telemetry-toolbar">
        <div className="window-seg" role="group" aria-label="Telemetry window">
          {TELEMETRY_WINDOWS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={option.id === activeWindow ? 'is-active' : ''}
              aria-pressed={option.id === activeWindow}
              onClick={() => setActiveWindow(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="icon-button"
          aria-label="Refresh telemetry now"
          onClick={() => void load(false)}
        >
          <RefreshCw size={16} />
        </button>

        <span className="section-meta">
          {series
            ? `${series.rawSampleCount.toLocaleString()} samples · ${series.resolution} · ${series.windowLabel.toLowerCase()}`
            : status === 'loading'
              ? 'Loading…'
              : 'No data'}
        </span>
      </div>

      <div className="channel-chips" role="group" aria-label="Channel filter">
        <button
          type="button"
          className={`channel-chip all ${!isFiltered ? 'is-on' : ''}`}
          aria-pressed={!isFiltered}
          onClick={() => setHidden([])}
        >
          All
        </button>
        {ALL_CHANNEL_IDS.map((id) => {
          const channel = channels.find((c) => c.outletId === id)
          const off = hidden.includes(id)
          return (
            <button
              key={id}
              type="button"
              className={`channel-chip ${off ? 'is-off' : 'is-on'}`}
              aria-pressed={!off}
              title={channel ? `${channel.name} · ${channel.ratedVoltageVolts} V` : `Channel ${id}`}
              onClick={() => toggleChannel(id)}
            >
              <span
                className="chip-bar"
                style={{ background: channelColor(id) }}
                aria-hidden="true"
              />
              CH{id}
            </button>
          )
        })}
      </div>

      {status === 'unauthorized' ? (
        <article className="info-card">
          <h3>Sign in to view telemetry</h3>
          <p>{error}</p>
        </article>
      ) : allValuesNull ? (
        <article className="info-card">
          <h3>No telemetry in this window</h3>
          <p>
            The ESP32 posts every 5 s, so an empty {series?.windowLabel.toLowerCase() ?? 'window'} means the
            device has not reported in that period — it may be offline, or the host may have been asleep.
            Nothing is plotted rather than plotting zeros.
          </p>
        </article>
      ) : (
        <>
          <div className="overview-grid" aria-label="Telemetry summary">
            <MetricCard
              icon={<Activity />}
              label="Total watts now"
              value={wattsNow !== null ? `${formatValue(wattsNow, 'W')} W` : '—'}
              note={isFiltered ? 'selected channels · allowance-weighted' : 'all 13 channels · allowance-weighted'}
            />
            <MetricCard
              icon={<Activity />}
              label="Peak watts (window)"
              value={`${formatValue(wattsStats.max ?? 0, 'W')} W`}
              note={totals?.energyKwhDelta != null ? `${totals.energyKwhDelta.toFixed(3)} kWh in window` : 'derived · allowance-weighted'}
            />
            <MetricCard
              icon={<Activity />}
              label="Volts (CH1–CH8 range)"
              value={
                voltsRange.min !== null && voltsRange.max !== null
                  ? `${formatValue(voltsRange.min, 'V')}–${formatValue(voltsRange.max, 'V')} V`
                  : '—'
              }
              note={
                meterMode === 'Metered'
                  ? 'measured on the mains feed'
                  : meterMode === 'Simulated'
                    ? 'simulated · nominal ratings'
                    : 'provenance unknown'
              }
            />
            <MetricCard
              icon={<Activity />}
              label="Amps total (latest)"
              value={`${formatValue(ampsNow, 'A')} A`}
              note="derived as P/V · not sampled"
            />
          </div>

          {failedAttempts > 0 && (
            <p className={`stale-pill ${status === 'stale' ? 'delayed' : ''}`}>
              {error === 'Backend unreachable'
                ? `Backend cold start — retrying (${failedAttempts})`
                : `Retrying (${failedAttempts}) — ${error ?? 'request failed'}`}
            </p>
          )}

          <div className={`telemetry-charts ${isDimmed ? 'is-stale' : ''}`}>
            <article className="chart-panel" aria-label="Total load">
              <TimeSeriesChart
                title={isFiltered ? 'Total load — selected channels' : 'Total load — all 13 channels'}
                unit="W"
                series={[
                  {
                    id: 'total',
                    label: isFiltered ? 'Selected channels' : 'All channels',
                    color: 'var(--accent)',
                    values: totals?.watts ?? [],
                  },
                ]}
                timestamps={series?.timestamps ?? []}
                showArea
              />
              <p className="chart-caption">
                {meterMode === 'Simulated' ? WATTS_CAPTION_SIMULATED : WATTS_CAPTION}
              </p>
            </article>

            <article className="chart-panel" aria-label="Per-channel power">
              <div className="legend-grid">
                {visibleChannels.map((channel) => (
                  <span className="legend-item" key={`lg-w-${channel.outletId}`} title={channel.provenanceNote}>
                    <span
                      className="legend-swatch"
                      style={{
                        background: channelColor(channel.outletId),
                        borderStyle: channelDash(channel.outletId) ? 'dashed' : 'solid',
                      }}
                      aria-hidden="true"
                    />
                    {PROVENANCE_GLYPH[channel.provenance] ?? '○'} CH{channel.outletId} · {channel.name} ·{' '}
                    {channel.ratedVoltageVolts} V
                  </span>
                ))}
              </div>
              <TimeSeriesChart
                title="Per-channel watts"
                unit="W"
                series={toChartSeries((c) => c.watts)}
                timestamps={series?.timestamps ?? []}
              />
              <p className="chart-caption">{meterMode === 'Simulated' ? WATTS_CAPTION_SIMULATED : WATTS_CAPTION}</p>
            </article>

            <article className="chart-panel" aria-label="Per-channel current">
              <TimeSeriesChart
                title="Per-channel current"
                unit="A"
                series={toChartSeries((c) => c.amps)}
                timestamps={series?.timestamps ?? []}
              />
              <p className="chart-caption">{AMPS_CAPTION}</p>
            </article>

            <article className="chart-panel" aria-label="Per-channel voltage">
              <TimeSeriesChart
                title="Per-channel volts"
                unit="V"
                series={toChartSeries((c) => c.volts)}
                timestamps={series?.timestamps ?? []}
              />
              <p className="chart-caption">
                {VOLTS_CAPTION}
                {meterMode === 'Metered' ? ` ${VOLTS_CAPTION_METERED}` : ''}
              </p>
            </article>
          </div>

          <p className={`stale-pill ${staleness.tone}`}>
            {staleness.label}
            {totalStats.max !== null ? ` · peak ${formatValue(totalStats.max, 'W')} W/channel` : ''}
          </p>
        </>
      )}
    </section>
  )
}
