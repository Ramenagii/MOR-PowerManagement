import { useCallback, useEffect, useMemo, useState } from 'react'
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'framer-motion'
import { Activity, CloudOff, Gauge, LogOut, Plug, PlugZap, RotateCcw, ScanLine, ShieldCheck } from 'lucide-react'
import {
  ApiError,
  activateOutlet,
  checkSession,
  fetchDashboardState,
  ingestScenario,
  logout,
} from './api'
import { EventLogPanel } from './components/EventLogPanel'
import { ChannelInventoryView } from './components/ChannelInventoryView'
import { HardwareView } from './components/HardwareView'
import { LoadingScreen } from './components/LoadingScreen'
import { LoginGate } from './components/LoginGate'
import { MetricCard } from './components/MetricCard'
import {
  OutletCard,
  RELAY_UNAVAILABLE,
  branchSensorNote,
  NOMINAL_RAIL_NOTE,
} from './components/OutletCard'
import { Disclosure } from './components/Disclosure'
import { PoliciesView } from './components/PoliciesView'
import { PolicyAdminView } from './components/PolicyAdminView'
import { ScenarioPanel } from './components/ScenarioPanel'
import { SensorFaultRail } from './components/SensorFaultRail'
import { TelemetryView } from './components/TelemetryView'
import { AppTopBar } from './components/AppTopBar'
import {
  baseOutlets,
  CRITICAL_THRESHOLD,
  initialEvents,
  MAX_CAPACITY,
  WARNING_THRESHOLD,
} from './data/dashboard'
import type { AppView, EventLog, Outlet, Severity } from './types/dashboard'
import { formatWatts, getTimeStamp, isEnergizedOutlet, totalLoad } from './utils/dashboard'
import { detectSensorFault } from './utils/sensorFault'
import {
  buildScenarioPayload,
  capacityBlockProfile,
  idleProfile,
  normalProfile,
  overloadProfile,
  selectiveProfile,
  type ScenarioProfile,
} from './utils/scenarios'

type Session = 'checking' | 'authed' | 'login' | 'offline'

/**
 * Pacing. The ESP32 posts every 1 s, so a 5 s dashboard poll threw away four
 * out of five readings and made the console feel stalled. These are kept in
 * step with the device cadence; the device remains the clock.
 *
 * 500 ms rather than 1 s: the database is cloud-hosted, so each state request
 * costs roughly 180 ms of round trip. Polling at 1 s meant the number on screen
 * was on average ~700 ms stale on top of the device's own 1 s posting interval,
 * which read as a lagging dashboard rather than a live one.
 */
const DASHBOARD_POLL_MS = 500

// The intro overlay used to hold the whole app behind it for 3.6 s, which read
// as a hang on every load. It is a brand beat, not a wait: long enough to read,
// short enough that the console is usable immediately.
const INTRO_MS = 700

// Route transitions are 0.48-0.56 s, which is cinema pacing for an operations
// screen an operator may switch several times a minute.
const ROUTE_TRANSITION_S = 0.2
const SHELL_TRANSITION_S = 0.22

/** The three operating bands the capacity meter is calibrated against. */
function stateTagClass(state: string): string {
  if (state === 'Critical') return 'ant-tag ant-tag-error'
  if (state === 'Warning') return 'ant-tag ant-tag-warning'
  return 'ant-tag ant-tag-success'
}

/**
 * The meter fill is a BAND readout, not a measurement-quality readout, so it
 * wears the three load bands straight off the standard: nominal sage below the
 * warning threshold, advisory amber in the warning band, critical coral at and
 * over the trip threshold. The previous build painted everything below warning
 * in the interactive blue, which read as "no opinion" on a track whose entire
 * job is to have an opinion about where the load sits.
 */
function meterFillClass(state: string): string {
  if (state === 'Critical') return 'bg-error'
  if (state === 'Warning') return 'bg-tertiary'
  return 'bg-secondary'
}

/** Clamp a threshold onto the meter's 0-100% track. */
function trackPercent(value: number, max: number): number {
  if (!(max > 0)) return 0
  return Math.min(Math.max((value / max) * 100, 0), 100)
}

/**
 * The one hatch grammar in the console: a solid bar reads as a measurement, a
 * hatched one reads as "there is a slot here and nothing trustworthy can go in
 * it". Reused verbatim by every meter that is suppressed rather than measured.
 */
const FAULT_HATCH =
  'repeating-linear-gradient(135deg, rgba(255,255,255,0.82) 0 3px, rgba(255,255,255,0) 3px 8px)'

/** A dt/dd pair inside the disclosure — one explanation, labelled. */
function Note({ label, body }: { label: string; body: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="font-label-sm text-label-sm uppercase text-on-surface-variant">{label}</dt>
      <dd className="max-w-[76ch] font-body-sm text-body-sm text-on-surface-variant">{body}</dd>
    </div>
  )
}

function App() {
  const [outlets, setOutlets] = useState<Outlet[]>(baseOutlets)
  const [events, setEvents] = useState<EventLog[]>(initialEvents)
  const [thresholds, setThresholds] = useState({
    max: MAX_CAPACITY,
    warning: WARNING_THRESHOLD,
    critical: CRITICAL_THRESHOLD,
  })
  const [session, setSession] = useState<Session>('checking')
  // Shown in the top bar avatar and the footer. checkSession() already returns
  // the signed-in address, so this costs nothing extra.
  const [userEmail, setUserEmail] = useState<string | null>(null)
  const [backendOnline, setBackendOnline] = useState(false)
  const [deviceOnline, setDeviceOnline] = useState(false)
  const [introDone, setIntroDone] = useState(false)
  const [introKey, setIntroKey] = useState(0)
  const [activeView, setActiveView] = useState<AppView>('dashboard')
  // Outcome of the last scenario run, shown verbatim in the panel. This is the
  // honesty surface: it states whether rows were actually stored, and reports
  // the events the server's policy engine raised rather than a local string.
  const [scenarioNotice, setScenarioNotice] = useState<{
    tone: 'live' | 'simulated' | 'error'
    text: string
  } | null>(null)
  const [scenarioBusy, setScenarioBusy] = useState(false)
  const prefersReducedMotion = useReducedMotion()

  const refreshFromBackend = useCallback(async () => {
    const snapshot = await fetchDashboardState()
    setOutlets(snapshot.outlets)
    setEvents(snapshot.events)
    setThresholds(snapshot.thresholds)
    setDeviceOnline(snapshot.deviceOnline)
    setBackendOnline(true)
  }, [])

  useEffect(() => {
    let cancelled = false
    checkSession()
      .then((email) => {
        if (cancelled) return
        setUserEmail(email)
        setSession('authed')
        void refreshFromBackend().catch(() => setBackendOnline(false))
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (error instanceof ApiError && error.status === 401) {
          setSession('login')
        } else {
          // Backend unreachable: fall back to the simulated baseline.
          setSession('offline')
        }
      })
    return () => {
      cancelled = true
    }
  }, [refreshFromBackend])

  useEffect(() => {
    if (session !== 'authed') return
    // Self-scheduling, not setInterval: a Neon hiccup that takes longer than
    // the poll interval must never stack a second request on top of the first,
    // because each late arrival triggers its own full re-render and the console
    // reads as stuttering. Hidden tabs pause entirely instead of polling a
    // screen nobody is looking at.
    let cancelled = false
    let timer = 0
    const tick = () => {
      if (cancelled) return
      if (document.hidden) {
        timer = window.setTimeout(tick, DASHBOARD_POLL_MS)
        return
      }
      void refreshFromBackend()
        .catch(() => setBackendOnline(false))
        .finally(() => {
          if (!cancelled) timer = window.setTimeout(tick, DASHBOARD_POLL_MS)
        })
    }
    timer = window.setTimeout(tick, 0)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [session, refreshFromBackend])

  useEffect(() => {
    const timer = window.setTimeout(() => setIntroDone(true), INTRO_MS)
    return () => window.clearTimeout(timer)
  }, [introKey])

  useEffect(() => {
    document.body.classList.toggle('intro-active', !introDone)
    return () => document.body.classList.remove('intro-active')
  }, [introDone])

  const load = totalLoad(outlets)
  const remaining = Math.max(thresholds.max - load, 0)
  const activeCount = outlets.filter((outlet) => isEnergizedOutlet(outlet.status)).length
  const currentState =
    load >= thresholds.critical ? 'Critical' : load >= thresholds.warning ? 'Warning' : 'Normal'
  const loadPercent = Math.min((load / thresholds.max) * 100, 100)

  /*
   * Sensor fault, resolved ONCE per snapshot and passed down.
   *
   * This is the state the whole console is most likely to get wrong. The rig is
   * flashed and posting, both metering sensors are off the bus, the device has
   * latched `S_fault`, the backend has written a POL-01 isolation event — and
   * `GET /Dashboard/state` still reports `state: 0`, Normal, because a total of
   * 0 W sits under the warning threshold. Every derived figure below is
   * computed from that total.
   *
   * So the load-derived band is deliberately NOT trusted as the headline once a
   * fault is in the record: it is arithmetic over a reading the device has said
   * it cannot take. `systemLabel` is what the top bar shows, and it says
   * "Sensor fault" rather than the computed band, because a band computed from
   * unattributable zeros is a band of nothing.
   */
  const sensorFault = useMemo(
    () =>
      detectSensorFault({
        events,
        deviceOnline,
        channelCount: outlets.length,
        now: Date.now(),
      }),
    [events, deviceOnline, outlets.length],
  )

  const faulted = sensorFault !== null
  const systemLabel = faulted ? 'Sensor fault' : `System ${currentState}`

  const addEvent = (title: string, detail: string, severity: Severity = 'info') => {
    setEvents((current) => [
      {
        id: Date.now(),
        time: getTimeStamp(),
        title,
        detail,
        severity,
      },
      ...current,
    ])
  }

  // Runs the backend action when live, otherwise falls back to local simulation.
  const runLive = async (action: () => Promise<unknown>, fallback: () => void) => {
    if (session === 'authed' && backendOnline) {
      try {
        await action()
        await refreshFromBackend()
        return
      } catch {
        setBackendOnline(false)
      }
    }
    fallback()
  }

  // Defense scenarios now post real telemetry instead of only editing local
  // state. The backend stores the rows, refreshes outlet state and runs the
  // policy engine, so the events shown are the engine's own and the Telemetry
  // charts move at the same time. If the backend is unreachable the local
  // fallback still runs, and the banner says which path was taken.
  const runScenario = async (profile: ScenarioProfile, label: string) => {
    if (session !== 'authed' || !backendOnline) {
      setScenarioNotice({
        tone: 'simulated',
        text: `${label}: backend unreachable, so only the on-screen preview changed. No rows were stored.`,
      })
      return
    }

    setScenarioBusy(true)
    setScenarioNotice(null)
    try {
      const { readings, relayStates } = buildScenarioPayload(outlets, profile)
      const result = await ingestScenario({
        deviceId: 'dashboard-scenario',
        readings,
        relayStates,
      })
      await refreshFromBackend()

      const events = result.eventsRaised.length
        ? ` Policy engine raised: ${result.eventsRaised.join('; ')}.`
        : ' No threshold crossing was raised for this batch.'
      setScenarioNotice({
        tone: 'live',
        text: `${label}: ${result.readingsStored} readings stored, total ${Math.round(
          result.totalWatts,
        )} W.${events}`,
      })
    } catch (cause) {
      setScenarioNotice({
        tone: 'error',
        text: `${label} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      })
    } finally {
      setScenarioBusy(false)
    }
  }

  const scenarioNormal = () => {
    void runScenario(normalProfile(outlets), 'Normal operation')
  }

  const scenarioCapacityBlock = () => {
    void runScenario(capacityBlockProfile(outlets), 'Capacity block')
  }

  const scenarioOverload = () => {
    void runScenario(overloadProfile(outlets), 'Post-activation overload')
  }

  const scenarioSelective = () => {
    void runScenario(selectiveProfile(outlets), 'Selective response')
  }

  const scenarioIdle = () => {
    void runScenario(idleProfile(outlets), 'Idle shutdown')
  }

  const requestActivationLocal = () => {
    const requested = outlets.find((outlet) => outlet.id === 6)
    if (!requested) return

    const projectedLoad = load + requested.allowance
    if (projectedLoad > thresholds.critical) {
      addEvent(
        'Activation blocked',
        `Outlet 6 request denied: ${formatWatts(load)} current load + ${formatWatts(
          requested.allowance,
        )} allowance exceeds the configured critical threshold.`,
        'warning',
      )
      return
    }

    setOutlets((current) =>
      current.map((outlet) =>
        outlet.id === 6 ? { ...outlet, status: 'Active', watts: 190 } : outlet,
      ),
    )
    addEvent(
      'Outlet activation allowed',
      'Pre-activation capacity assessment passed; Outlet 6 relay energized.',
      'success',
    )
  }

  const requestActivation = () => {
    void runLive(() => activateOutlet(6), requestActivationLocal)
  }

  const replayIntro = () => {
    setIntroDone(false)
    setIntroKey((current) => current + 1)
  }

  const handleLogout = () => {
    void logout()
      .catch(() => undefined)
      .finally(() => setSession('login'))
  }

  const routeInitial = prefersReducedMotion
    ? { opacity: 0 }
    : { opacity: 0, y: 18, filter: 'blur(8px)' }
  const routeAnimate = { opacity: 1, y: 0, filter: 'blur(0px)' }
  const routeExit = prefersReducedMotion
    ? { opacity: 0 }
    : { opacity: 0, y: -10, filter: 'blur(6px)' }

  if (session === 'checking') {
    return <LoadingScreen />
  }

  if (session === 'login') {
    return (
      <LoginGate
        onAuthenticated={() => {
          setSession('authed')
          void refreshFromBackend().catch(() => setBackendOnline(false))
        }}
        onOffline={() => setSession('offline')}
      />
    )
  }

  const connectionLabel =
    session === 'authed' && backendOnline ? 'Live — backend' : 'Simulated — backend offline'

  const warningTrack = trackPercent(thresholds.warning, thresholds.max)
  const criticalTrack = trackPercent(thresholds.critical, thresholds.max)

  return (
    <LayoutGroup id={`loadwise-${introKey}`}>
      <AnimatePresence mode="popLayout">
        {!introDone && <LoadingScreen key={`intro-${introKey}`} />}
      </AnimatePresence>
      <motion.main
        className={`flex min-h-screen flex-col bg-background ${introDone ? '' : 'pointer-events-none select-none'}`}
        initial={false}
        animate={introDone ? { opacity: 1, y: 0 } : { opacity: 0, y: 12 }}
        transition={{ duration: SHELL_TRANSITION_S, ease: [0.22, 1, 0.36, 1] }}
      >
        {/*
          The redesign replaces the old identity topbar + hamburger drawer with a
          single sticky nav bar. The connection and ESP32 status it used to show
          now live in that bar, so nothing was dropped.
        */}
        <AppTopBar
          activeView={activeView}
          onChange={setActiveView}
          systemState={currentState}
          systemLabel={systemLabel}
          sensorFault={sensorFault}
          deviceOnline={deviceOnline}
          userEmail={userEmail}
        />

        {session === 'offline' && (
          <div className="mx-auto w-full max-w-[1440px] px-margin pt-space-lg">
            <section
              role="status"
              className="ant-card flex flex-col items-start gap-space-sm border-l-4 border-l-error p-space-lg"
              aria-label="Backend unreachable"
            >
              <div className="flex flex-wrap items-center gap-2">
                <CloudOff size={18} className="text-error" aria-hidden="true" />
                <h2 className="font-title-lg text-title-lg font-semibold text-on-surface">
                  Backend unreachable
                </h2>
                <span className="ant-tag ant-tag-error">OFFLINE</span>
              </div>
              <p className="max-w-3xl font-body-md text-body-md text-on-surface-variant">
                The console could not reach <code className="font-code text-code">/api/Dashboard/state</code>,
                so nothing below is live telemetry. The figures are the stored baseline for the test rig and
                the buttons below write nothing. Sign in again once the device is reachable.
              </p>
              <button type="button" className="ant-btn ant-btn-primary" onClick={() => setSession('login')}>
                Sign in
              </button>
            </section>
          </div>
        )}

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={activeView}
            className="origin-top flex-1"
            layoutId="loadwise-route-surface"
            initial={routeInitial}
            animate={routeAnimate}
            exit={routeExit}
            transition={{ duration: ROUTE_TRANSITION_S, ease: [0.22, 1, 0.36, 1] }}
          >
            {/*
              Every view now shares one page frame — the same 1440px column and
              the same 24px margin — so switching tabs does not shift the
              content sideways. ChannelInventoryView used to opt out and carry
              its own legacy `.design-main` padding, which left it on a
              different grid from the tab beside it; it has been ported back
              onto this one.
            */}
            <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-space-lg px-margin py-space-lg">
              {/*
                The fault rail sits above every view and outside the route
                transition, on purpose. A fault is not a property of the view you
                happen to be looking at, and animating it in on a tab change would
                imply the operator summoned it. It is also the only element on the
                page permitted to use the critical wash at full strength.
              */}
              <SensorFaultRail
                fault={sensorFault}
                onInspectHardware={() => setActiveView('hardware')}
              />

              {activeView === 'dashboard' && (
                <>
                  {/* --- Page head ------------------------------------------------- */}
                  <header className="flex flex-col gap-1">
                    <nav
                      aria-label="Breadcrumb"
                      className="flex items-center gap-1.5 font-body-sm text-body-sm text-on-surface-variant"
                    >
                      <span>Console</span>
                      <span className="text-xs text-outline" aria-hidden="true">
                        /
                      </span>
                      <span className="font-medium text-on-surface">Dashboard</span>
                    </nav>
                    <div className="mt-1 flex flex-wrap items-center gap-space-sm">
                      <h1 className="font-headline-md text-headline-md text-on-surface">
                        Power Operations Dashboard
                      </h1>
                      <span className={faulted ? 'ant-tag ant-tag-error' : stateTagClass(currentState)}>
                        {systemLabel}
                      </span>
                    </div>
                    <p className="max-w-3xl font-body-md text-body-md text-on-surface-variant">
                      Live load against the configured master capacity, every controlled channel, and
                      what the policy engine decided about them.
                    </p>
                  </header>

                  {/* --- Four-up summary -------------------------------------------
                      When the fault is latched the two load-derived cards swap their
                      figure for "no reading" and say why. They are the only cards
                      that change: the roster and the channel count are facts about
                      the rig and stay true through a sensor fault. */}
                  <section
                    className="grid grid-cols-1 gap-space-md sm:grid-cols-2 xl:grid-cols-4"
                    aria-label="System overview"
                  >
                    <MetricCard
                      icon={<Gauge />}
                      label="Total load"
                      value={faulted ? 'No reading' : formatWatts(load)}
                      note={
                        faulted
                          ? 'Device faulted — not attributable to a measurement'
                          : `${Math.round(loadPercent)}% of ${formatWatts(thresholds.max)} capacity`
                      }
                      tone={faulted ? 'critical' : undefined}
                    />
                    <MetricCard
                      icon={<ShieldCheck />}
                      label="Remaining capacity"
                      value={faulted ? 'No reading' : formatWatts(remaining)}
                      note={
                        faulted
                          ? 'Headroom cannot be stated without a load'
                          : `${formatWatts(thresholds.warning)} warning / ${formatWatts(thresholds.critical)} critical`
                      }
                      tone={faulted ? 'critical' : undefined}
                    />
                    <MetricCard
                      icon={<PlugZap />}
                      label="Energized outlets"
                      value={`${activeCount}/${outlets.length}`}
                      note="Policy status per channel — relay outputs are not driven"
                    />
                    {/* The sensor copy is the honest one: the PZEM-004T that used to sit
                        on the common feed is retired. Mains V/A/W now comes from an
                        INA226 on that feed, each mains branch carries its own CT behind
                        an ADS1015, and the 5 V USB rail has no CT at all — it is
                        reported as a residual. */}
                    <MetricCard
                      icon={<ScanLine />}
                      label="Metering channels"
                      value={`${outlets.length}`}
                      note="ADS1015 + ZMCT103C per mains branch, INA226 on the mains feed · CH5 USB is nominal"
                    />
                  </section>

                  {/* --- Capacity meter -------------------------------------------- */}
                  <section className="ant-card overflow-hidden" aria-label="Load capacity meter">
                    <div className="ant-card-header">
                      <div className="flex min-w-0 items-center gap-2">
                        <Activity size={18} className="shrink-0 text-primary" aria-hidden="true" />
                        <h2 className="font-title-lg text-title-lg font-semibold text-on-surface">
                          Capacity and thresholds
                        </h2>
                        <code className="hidden rounded bg-surface-container px-2 py-0.5 font-code text-code text-on-surface-variant sm:inline">
                          P_limit
                        </code>
                      </div>
                      <div className="flex shrink-0 items-baseline gap-1.5">
                        {/* The header figure is the load. Under a fault the load is
                            not a measurement, so the figure is withdrawn rather
                            than shown as a confident zero against a healthy-looking
                            1,200 W ceiling. */}
                        <span
                          className={`font-metric-display text-metric-display ${
                            faulted ? 'text-error' : 'text-on-surface'
                          }`}
                        >
                          {faulted ? 'No reading' : Math.round(load).toLocaleString()}
                          {faulted ? null : (
                            <span className="font-metric-value text-metric-value font-semibold text-on-surface-variant">
                              {' '}
                              W
                            </span>
                          )}
                        </span>
                        <span className="font-metric-value text-metric-value text-outline">
                          {`/ ${Math.round(thresholds.max).toLocaleString()} W limit`}
                        </span>
                      </div>
                    </div>

                    <div className="ant-card-body flex flex-col gap-space-md">
                      {/* The two ticks are the signature of this panel: margin to trip
                          read as a position on a calibrated scale, not as two numbers
                          the operator has to compare by eye. */}
                      <div className="relative">
                        <div
                          className="ant-meter"
                          role="meter"
                          aria-valuenow={faulted ? undefined : Math.round(loadPercent)}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-label={
                            faulted
                              ? 'Total load — not attributable, sensor fault latched'
                              : `Total load, ${Math.round(loadPercent)} percent of configured capacity`
                          }
                        >
                          {/* Hatched across the whole track when faulted: an empty
                              track at 0% is indistinguishable from a healthy idle
                              rig, which is the whole misread this prevents. */}
                          <div
                            className={`ant-meter-fill ${faulted ? 'bg-error' : meterFillClass(currentState)}`}
                            style={{
                              width: faulted ? '100%' : `${loadPercent}%`,
                              backgroundImage: faulted ? FAULT_HATCH : undefined,
                              opacity: faulted ? 0.3 : undefined,
                            }}
                          />
                        </div>
                        <span
                          className="absolute -top-1 h-4 w-0.5 -translate-x-1/2 rounded-sm bg-tertiary"
                          style={{ left: `${warningTrack}%` }}
                          aria-hidden="true"
                        />
                        <span
                          className="absolute -top-1 h-4 w-0.5 -translate-x-1/2 rounded-sm bg-error"
                          style={{ left: `${criticalTrack}%` }}
                          aria-hidden="true"
                        />
                      </div>

                      <div className="grid grid-cols-1 gap-space-sm sm:grid-cols-3">
                        <div className="flex items-baseline justify-between gap-2 border-l-2 border-l-secondary pl-2">
                          <span className="font-metric-value text-metric-value text-on-surface-variant">
                            Normal band
                          </span>
                          <span className="font-metric-value text-metric-value font-semibold text-secondary">
                            {`0 – ${Math.round(thresholds.warning).toLocaleString()} W`}
                          </span>
                        </div>
                        <div className="flex items-baseline justify-between gap-2 border-l-2 border-l-tertiary pl-2">
                          <span className="font-metric-value text-metric-value text-on-surface-variant">
                            Warning · FR-05
                          </span>
                          <span className="font-metric-value text-metric-value font-semibold text-tertiary">
                            {`${Math.round(thresholds.warning).toLocaleString()} – ${Math.round(
                              thresholds.critical,
                            ).toLocaleString()} W`}
                          </span>
                        </div>
                        <div className="flex items-baseline justify-between gap-2 border-l-2 border-l-error pl-2">
                          <span className="font-metric-value text-metric-value text-on-surface-variant">
                            Critical · FR-06
                          </span>
                          <span className="font-metric-value text-metric-value font-semibold text-error">
                            {`≥ ${Math.round(thresholds.critical).toLocaleString()} W`}
                          </span>
                        </div>
                      </div>

                      {/* The poll arithmetic moves to the disclosure below the
                          outlet grid. It is a true statement about this panel's
                          freshness, but it is not a reading and it does not
                          belong under a meter — one line of process note on a
                          dashboard is how the meter ends up explaining itself
                          instead of being read. */}
                    </div>
                  </section>

                  {/* --- Controlled channels --------------------------------------
                      `faulted` is handed to every card so each one can hold its
                      figure at "no reading" rather than showing a measured zero.
                      There is no relay command to disable here: the card carries
                      no control, and the reason it does not is stated once in
                      the disclosure below the grid. */}
                  <section className="ant-card overflow-hidden" aria-label="Outlet-level monitoring">
                    <div className="ant-card-header">
                      <div className="flex min-w-0 items-center gap-2">
                        <Plug size={18} className="shrink-0 text-primary" aria-hidden="true" />
                        <h2 className="font-title-lg text-title-lg font-semibold text-on-surface">
                          {`${outlets.length} controlled channels`}
                        </h2>
                      </div>
                      <span className="shrink-0 font-metric-value text-metric-value text-on-surface-variant">
                        {`${activeCount} energized · ${outlets.length - activeCount} open or idle`}
                      </span>
                    </div>
                    <div className="ant-card-body">
                      <div className="grid grid-cols-1 gap-space-md sm:grid-cols-2 xl:grid-cols-3">
                        {outlets.map((outlet) => (
                          <OutletCard key={outlet.id} outlet={outlet} faulted={faulted} />
                        ))}
                      </div>
                    </div>

                    {/* --- Control and metering notes, stated once -------------
                        Every paragraph below used to be printed once per card in
                        the grid above. Three sentences, repeated five times, is
                        not five explanations — it is fifteen lines of wall between
                        the operator and the figures, and the figures are the
                        reason the page is open. Each is identical across the
                        grid, so each is said once here, immediately after the
                        cards it qualifies, behind a control that says so. */}
                    <div className="border-t border-outline-variant">
                      <Disclosure
                        label="Control and metering notes"
                        summary={`Why the outlet cards carry no relay control, and where each channel's numbers come from — ${outlets.length} cards, 4 notes`}
                      >
                        <dl className="flex flex-col gap-3">
                          <Note
                            label="Relay outputs"
                            body={
                              <>
                                {RELAY_UNAVAILABLE}
                                {faulted
                                  ? ' The prototype is also isolated by the latched fault.'
                                  : ''}
                              </>
                            }
                          />
                          <Note
                            label="Mains branches (CH1–CH4)"
                            body={branchSensorNote(220)}
                          />
                          <Note label="USB rail (CH5)" body={NOMINAL_RAIL_NOTE} />
                          <Note
                            label="Metering panel"
                            body={`Ticks are placed at ${warningTrack.toFixed(0)}% and ${criticalTrack.toFixed(0)}% of P_limit. This panel refetches ${DASHBOARD_POLL_MS} ms after the last request settles, from GET /api/Dashboard/state, so the figure on screen trails the device's own 1 s posting interval by up to one poll cycle.`}
                          />
                        </dl>
                      </Disclosure>
                    </div>
                  </section>

                  <ScenarioPanel
                    onNormal={scenarioNormal}
                    onActivate={requestActivation}
                    onBlock={scenarioCapacityBlock}
                    onOverload={scenarioOverload}
                    onSelective={scenarioSelective}
                    onIdle={scenarioIdle}
                    notice={scenarioNotice}
                    busy={scenarioBusy}
                  />

                  <EventLogPanel events={events} />
                </>
              )}

              {activeView === 'channels' && <ChannelInventoryView />}

              {activeView === 'telemetry' && <TelemetryView />}

              {activeView === 'admin' && <PolicyAdminView />}

              {activeView === 'policies' && <PoliciesView />}

              {activeView === 'hardware' && <HardwareView />}
            </div>
          </motion.div>
        </AnimatePresence>

        {session === 'authed' && (
          <footer className="mt-auto flex flex-col gap-space-sm border-t border-surface-container bg-surface-container-lowest px-margin py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-x-space-lg gap-y-1 font-code text-code text-on-surface-variant">
              <span>{userEmail ?? 'signed in'}</span>
              <span className="flex items-center gap-1.5">
                <span
                  className={`ant-dot ${backendOnline ? 'ant-dot-normal' : 'ant-dot-warning'}`}
                  aria-hidden="true"
                />
                {connectionLabel}
              </span>
              <span>{deviceOnline ? 'ESP32 online' : 'ESP32 offline'}</span>
            </div>
            <div className="flex shrink-0 items-center gap-space-sm">
              <button type="button" className="ant-btn ant-btn-default" onClick={replayIntro}>
                <RotateCcw size={16} className="text-outline" aria-hidden="true" />
                Replay intro
              </button>
              <button type="button" className="ant-btn ant-btn-default" onClick={handleLogout}>
                <LogOut size={16} className="text-outline" aria-hidden="true" />
                Sign out
              </button>
            </div>
          </footer>
        )}
      </motion.main>
    </LayoutGroup>
  )
}

export default App