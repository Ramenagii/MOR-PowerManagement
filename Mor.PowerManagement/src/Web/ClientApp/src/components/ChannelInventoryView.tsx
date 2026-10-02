import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, AlertTriangle, Gauge, Radio, RefreshCw, Zap } from 'lucide-react'
import {
  ApiError,
  fetchDashboardState,
  fetchTelemetrySeries,
  type DashboardSnapshot,
  type TelemetryChannel,
  type TelemetrySeries,
  type TelemetryWindow,
} from '../api'
import {
  AMPS_CAPTION,
  METERING_MODE_LABEL,
  POLL_INTERVAL_MS,
  PROVENANCE_COPY,
  PROVENANCE_GLYPH,
  VOLTS_CAPTION,
  WATTS_CAPTION,
  WATTS_CAPTION_SIMULATED,
  channelColor,
} from '../data/telemetry'
import type { Outlet } from '../types/dashboard'
import { describeSeries, formatValue, histogram, stalenessState } from '../utils/telemetry'
import { MetricCard } from './MetricCard'

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
 * The honesty constraint drives most of this file. Per-channel volts and amps
 * are DERIVED, not metered -- there is one PZEM on the common mains feed. Every
 * figure carries a provenance badge and the banners quote PROVENANCE_COPY rather
 * than inventing reassurance, so a panelist asking "is this measured?" gets the
 * true answer on screen.
 */

type Status = 'loading' | 'ready' | 'unauthorized' | 'error'

/** Short window: the inventory is a live view, not a trend view. */
const LIVE_WINDOW: TelemetryWindow = '15m'

/** Sampling period, reused from the telemetry view so both stay in step. */
const REFRESH_MS = POLL_INTERVAL_MS[LIVE_WINDOW] ?? 10_000

/** Bin count for the per-channel load distribution. */
const HISTOGRAM_BINS = 8

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

function railLabel(volts: number): string {
  if (volts >= 200) return '220 V mains'
  if (volts >= 100) return '110 V step-down'
  return `${volts} V USB`
}

/**
 * formatValue, but null-tolerant. A channel with no sample in the window must read
 * as a dash, not as "0.0" — conflating a gap with zero load is exactly the error
 * this thesis is about not making.
 */
function fmt(value: number | null, unit: 'V' | 'A' | 'W'): string {
  return value === null ? '—' : formatValue(value, unit)
}


export function ChannelInventoryView() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null)
  const [series, setSeries] = useState<TelemetrySeries | null>(null)
  const [status, setStatus] = useState<Status>('loading')
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
      <section className="view-stack" aria-label="Channel Inventory">
        <div className="page-heading">
          <div>
            <p className="eyebrow">Channel Inventory</p>
            <h2>Session expired</h2>
          </div>
        </div>
        <div className="panel">
          <p className="safe-note">Sign in again to view the sensor inventory.</p>
        </div>
      </section>
    )
  }

  if (status === 'error') {
    return (
      <section className="view-stack" aria-label="Channel Inventory">
        <div className="page-heading">
          <div>
            <p className="eyebrow">Channel Inventory</p>
            <h2>Inventory unavailable</h2>
          </div>
        </div>
        <div className="panel">
          <p className="safe-note">
            {error ?? 'The dashboard state could not be loaded.'} This view needs both
            <code> /Dashboard/state</code> and <code> /Dashboard/telemetry</code>.
          </p>
        </div>
      </section>
    )
  }

  if (!snapshot) {
    return (
      <section className="view-stack" aria-label="Channel Inventory">
        <div className="page-heading">
          <div>
            <p className="eyebrow">Channel Inventory</p>
            <h2>Loading channels</h2>
          </div>
        </div>
        <div className="chart-empty">Reading the device roster and the latest samples…</div>
      </section>
    )
  }

  const readings = joinChannels(snapshot.outlets, series)
  const byId = new Map(snapshot.outlets.map((o) => [o.id, o]))
  const energizedCount = snapshot.outlets.filter((o) => o.status === 'Active').length
  const totalWatts = snapshot.outlets.reduce((sum, outlet) => sum + (outlet.watts || 0), 0)
  const capacity = snapshot.thresholds.max
  const loadPercent = capacity > 0 ? (totalWatts / capacity) * 100 : 0
  const mode = series?.meteringMode ?? 'Unknown'
  const provenance = PROVENANCE_COPY[mode] ?? PROVENANCE_COPY.Unknown
  const freshness = stalenessState(series?.latestSampleAt ?? null, now, snapshot.deviceOnline)

  return (
    <section className="view-stack" aria-label="Channel Inventory">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Sensor inventory</p>
          <h2>All metering channels</h2>
        </div>
        <div className="page-heading-actions">
          <span className={`stale-pill ${freshness.tone}`}>{freshness.label}</span>
          <button
            type="button"
            className="icon-button"
            aria-label="Refresh inventory"
            onClick={() => void load(true)}
          >
            <RefreshCw size={16} className={refreshing ? 'spin' : undefined} />
          </button>
        </div>
      </div>

      <div className={`provenance-banner ${provenance.tone}`}>
        <AlertTriangle size={18} />
        <div>
          <strong>{`Metering mode: ${METERING_MODE_LABEL[mode] ?? mode}`}</strong>
          <p>{provenance.banner}</p>
        </div>
      </div>

      <section className="overview-grid" aria-label="Inventory summary">
        <MetricCard
          icon={<Zap />}
          label="Total draw"
          value={`${Math.round(totalWatts)} W`}
          note={`${capacity} W configured capacity`}
        />
        <MetricCard
          icon={<Gauge />}
          label="Capacity used"
          value={`${loadPercent.toFixed(1)}%`}
          note={`${Math.max(0, capacity - totalWatts).toFixed(0)} W remaining`}
        />
        <MetricCard
          icon={<Radio />}
          label="Energized"
          value={`${energizedCount}/${readings.length}`}
          note="Active relay channels"
        />
        <MetricCard
          icon={<Activity />}
          label="Window"
          value={series?.windowLabel ?? '—'}
          note={
            series
              ? `${series.bucketCount} buckets · ${series.rawSampleCount} raw samples`
              : 'No telemetry yet'
          }
        />
      </section>


      <div className="channel-grid">
        {readings.map((reading) => {
          const outlet = byId.get(reading.channel.outletId)
          const accent = channelColor(reading.channel.outletId)
          const stats = describeSeries(reading.channel.watts)
          // histogram() returns null when a channel reported nothing at all, so
          // the whole distribution block is skipped rather than rendered empty.
          const bars = histogram(reading.channel.watts, HISTOGRAM_BINS)
          const tallest = bars?.counts.reduce((max, count) => (count > max ? count : max), 0) ?? 0
          const usedPercent =
            outlet && outlet.allowance > 0 && reading.watts !== null
              ? Math.min(100, (reading.watts / outlet.allowance) * 100)
              : 0

          return (
            <article
              key={reading.channel.outletId}
              className={`channel-card ${outlet?.status.toLowerCase() ?? 'disconnected'}`}
            >
              <header className="channel-card-header">
                <div>
                  <span className="channel-id" style={{ color: accent }}>
                    {`CH${String(reading.channel.outletId).padStart(2, '0')}`}
                  </span>
                  <h3>{outlet?.name ?? reading.channel.name}</h3>
                </div>
                <span className={`status-badge ${outlet?.status.toLowerCase() ?? 'disconnected'}`}>
                  {outlet?.status ?? 'Unknown'}
                </span>
              </header>

              <p className="channel-rail">{railLabel(reading.channel.ratedVoltageVolts)}</p>

              <dl className="channel-readings">
                <div>
                  <dt>Voltage</dt>
                  <dd>{fmt(reading.volts, 'V')}</dd>
                  <span>V</span>
                </div>
                <div>
                  <dt>Current</dt>
                  <dd>{fmt(reading.amps, 'A')}</dd>
                  <span>A</span>
                </div>
                <div>
                  <dt>Power</dt>
                  <dd>{fmt(reading.watts, 'W')}</dd>
                  <span>W</span>
                </div>
              </dl>

              {outlet && (
                <>
                  <div className="mini-meter" aria-label="Allowance used">
                    <div
                      style={{
                        width: `${usedPercent}%`,
                        background: usedPercent > 100 ? 'var(--red-ink)' : accent,
                      }}
                    />
                  </div>
                  <p className="channel-allowance">
                    {reading.watts === null ? '—' : Math.round(reading.watts)} / {outlet.allowance}{' '}
                    W allowance · {outlet.priority} priority
                  </p>
                </>
              )}

              <div className="channel-stats" aria-label="Window statistics for this channel">
                <div>
                  <span>Min</span>
                  <strong>{stats.min === null ? '—' : Math.round(stats.min)}</strong>
                </div>
                <div>
                  <span>Mean</span>
                  <strong>{stats.mean === null ? '—' : Math.round(stats.mean)}</strong>
                </div>
                <div>
                  <span>Max</span>
                  <strong>{stats.max === null ? '—' : Math.round(stats.max)}</strong>
                </div>
                <div>
                  <span>&sigma;</span>
                  <strong>{stats.stddev === null ? '—' : stats.stddev.toFixed(1)}</strong>
                </div>
              </div>

              {tallest > 0 && (
                <div className="channel-histogram" aria-label="Power distribution over the window">
                  {bars?.counts.map((count, index) => (
                    <div
                      key={index}
                      className="histogram-bar"
                      title={`${count} samples`}
                      style={{
                        height: `${(count / tallest) * 100}%`,
                        background: accent,
                      }}
                    />
                  ))}
                </div>
              )}

              <footer className="channel-card-footer">
                <span className={`provenance-tag ${reading.channel.provenance.toLowerCase()}`}>
                  {PROVENANCE_GLYPH[reading.channel.provenance] ?? '?'}{' '}
                  {reading.channel.provenance}
                </span>
                <span className="channel-coverage">
                  {reading.coverage}/{reading.total} buckets
                </span>
              </footer>
            </article>
          )
        })}
      </div>

      <section className="panel wide-panel">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">Reading provenance</p>
            <h2>What these numbers are, and are not</h2>
          </div>
        </div>
        <div className="variable-grid">
          <article>
            <strong>Volts</strong>
            <p>{VOLTS_CAPTION}</p>
          </article>
          <article>
            <strong>Amps</strong>
            <p>{AMPS_CAPTION}</p>
          </article>
          <article>
            <strong>Watts</strong>
            <p>{mode === 'Simulated' ? WATTS_CAPTION_SIMULATED : WATTS_CAPTION}</p>
          </article>
        </div>
        <p className="safe-note">
          Live figures are the most recent non-null bucket of the{' '}
          {series?.windowLabel ?? '15 min'} window. Min / mean / max / &sigma; cover that same
          window, skipping gaps rather than treating them as zero. This view is a live snapshot —
          the trend charts and the longer windows (up to 7 days) are on the Telemetry tab.
        </p>
      </section>
    </section>
  )
}
