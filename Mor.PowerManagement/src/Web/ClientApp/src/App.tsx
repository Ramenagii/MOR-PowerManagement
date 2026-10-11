import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'framer-motion'
import { Activity, CloudOff, Gauge, LogOut, Plug, PlugZap, RotateCcw, ScanLine, ShieldCheck } from 'lucide-react'
import {
  ApiError,
  activateOutlet,
  checkSession,
  disconnectOutlet,
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
import { OutletCard } from './components/OutletCard'
import { PoliciesView } from './components/PoliciesView'
import { PolicyAdminView } from './components/PolicyAdminView'
import { ScenarioPanel } from './components/ScenarioPanel'
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
 */
const DASHBOARD_POLL_MS = 1000

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

function meterFillClass(state: string): string {
  if (state === 'Critical') return 'bg-error'
  if (state === 'Warning') return 'bg-tertiary-container'
  return 'bg-primary'
}

/** Clamp a threshold onto the meter's 0-100% track. */
function trackPercent(value: number, max: number): number {
  if (!(max > 0)) return 0
  return Math.min(Math.max((value / max) * 100, 0), 100)
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
    const timer = window.setInterval(() => {
      void refreshFromBackend().catch(() => setBackendOnline(false))
    }, DASHBOARD_POLL_MS)
    return () => window.clearInterval(timer)
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

  const toggleOutletLocal = (id: number) => {
    const outlet = outlets.find((item) => item.id === id)
    if (!outlet) return

    if (isEnergizedOutlet(outlet.status)) {
      setOutlets((current) =>
        current.map((item) =>
          item.id === id ? { ...item, status: 'Disconnected', watts: 0 } : item,
        ),
      )
      addEvent('Manual relay action', `${outlet.name} was disconnected from the dashboard.`, 'info')
      return
    }

    const projectedLoad = load + outlet.allowance
    if (projectedLoad > thresholds.critical) {
      addEvent(
        'Manual activation blocked',
        `${outlet.name} was restricted because projected load exceeds the configured threshold.`,
        'warning',
      )
      return
    }

    setOutlets((current) =>
      current.map((item) => {
        if (item.id !== id) return item
        // Mirrors the backend activation estimate: the 90W floor applies only
        // to mains channels, never to the 110V or 5V rails.
        const estimate = Math.round(item.allowance * 0.72)
        return {
          ...item,
          status: 'Active',
          watts: item.volts >= 220 ? Math.max(90, estimate) : estimate,
        }
      }),
    )
    addEvent('Manual relay action', `${outlet.name} was activated after capacity assessment.`, 'success')
  }

  const toggleOutlet = (id: number) => {
    const outlet = outlets.find((item) => item.id === id)
    if (!outlet) return
    const action = isEnergizedOutlet(outlet.status)
      ? () => disconnectOutlet(id)
      : () => activateOutlet(id)
    void runLive(action, () => toggleOutletLocal(id))
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
              ChannelInventoryView ships its own legacy `.design-main` frame — it
              was ported first and is not editable here — so it opts out of the
              shared page padding rather than stacking 24px twice. Every other
              view gets the same 24px margin and 1440px column.
            */}
            <div
              className={
                activeView === 'channels'
                  ? 'w-full'
                  : 'mx-auto flex w-full max-w-[1440px] flex-col gap-space-lg px-margin py-space-lg'
              }
            >
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
                      <h1 className="font-headline-md text-headline-md tracking-tight text-on-surface">
                        Power Operations Dashboard
                      </h1>
                      <span className={`${stateTagClass(currentState)} font-code uppercase`}>
                        {`System ${currentState}`}
                      </span>
                    </div>
                    <p className="max-w-3xl font-body-md text-body-md text-on-surface-variant">
                      Live load against the configured master capacity, every controlled channel, and
                      what the policy engine decided about them.
                    </p>
                  </header>

                  {/* --- Four-up summary ------------------------------------------- */}
                  <section
                    className="grid grid-cols-1 gap-space-md sm:grid-cols-2 xl:grid-cols-4"
                    aria-label="System overview"
                  >
                    <MetricCard
                      icon={<Gauge />}
                      label="Total load"
                      value={formatWatts(load)}
                      note={`${Math.round(loadPercent)}% of ${formatWatts(thresholds.max)} capacity`}
                    />
                    <MetricCard
                      icon={<ShieldCheck />}
                      label="Remaining capacity"
                      value={formatWatts(remaining)}
                      note={`${formatWatts(thresholds.warning)} warning / ${formatWatts(thresholds.critical)} critical`}
                    />
                    <MetricCard
                      icon={<PlugZap />}
                      label="Energized outlets"
                      value={`${activeCount}/${outlets.length}`}
                      note="Active and standby relay channels"
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
                      note="INA226 on the mains feed, ADS1015 CT per mains branch · CH5 USB is a residual"
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
                        <span className="font-metric-display text-metric-display text-on-surface">
                          {Math.round(load).toLocaleString()}
                          <span className="font-code text-code font-semibold text-on-surface-variant"> W</span>
                        </span>
                        <span className="font-code text-code text-outline">
                          {`/ ${Math.round(thresholds.max).toLocaleString()} W`}
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
                          aria-valuenow={Math.round(loadPercent)}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-label={`Total load, ${Math.round(loadPercent)} percent of configured capacity`}
                        >
                          <div
                            className={`ant-meter-fill ${meterFillClass(currentState)}`}
                            style={{ width: `${loadPercent}%` }}
                          />
                        </div>
                        <span
                          className="absolute -top-1 h-4 w-0.5 -translate-x-1/2 rounded-sm bg-tertiary-container"
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
                          <span className="font-code text-code text-on-surface-variant">Normal band</span>
                          <span className="font-metric-value text-metric-value font-semibold text-secondary">
                            {`0 – ${Math.round(thresholds.warning).toLocaleString()} W`}
                          </span>
                        </div>
                        <div className="flex items-baseline justify-between gap-2 border-l-2 border-l-tertiary-container pl-2">
                          <span className="font-code text-code text-on-surface-variant">Warning · FR-05</span>
                          <span className="font-metric-value text-metric-value font-semibold text-tertiary-container">
                            {`${Math.round(thresholds.warning).toLocaleString()} – ${Math.round(
                              thresholds.critical,
                            ).toLocaleString()} W`}
                          </span>
                        </div>
                        <div className="flex items-baseline justify-between gap-2 border-l-2 border-l-error pl-2">
                          <span className="font-code text-code text-on-surface-variant">Critical · FR-06</span>
                          <span className="font-metric-value text-metric-value font-semibold text-error">
                            {`≥ ${Math.round(thresholds.critical).toLocaleString()} W`}
                          </span>
                        </div>
                      </div>

                      <p className="font-code text-code text-outline">
                        Ticks are placed at {warningTrack.toFixed(0)}% and {criticalTrack.toFixed(0)}% of
                        P_limit. State refreshes every 5 s from GET /api/Dashboard/state.
                      </p>
                    </div>
                  </section>

                  {/* --- Controlled channels -------------------------------------- */}
                  <section className="ant-card overflow-hidden" aria-label="Outlet-level monitoring">
                    <div className="ant-card-header">
                      <div className="flex min-w-0 items-center gap-2">
                        <Plug size={18} className="shrink-0 text-primary" aria-hidden="true" />
                        <h2 className="font-title-lg text-title-lg font-semibold text-on-surface">
                          {`${outlets.length} controlled channels`}
                        </h2>
                      </div>
                      <span className="shrink-0 font-code text-code text-on-surface-variant">
                        {`${activeCount} energized · ${outlets.length - activeCount} open or idle`}
                      </span>
                    </div>
                    <div className="ant-card-body">
                      <div className="grid grid-cols-1 gap-space-md sm:grid-cols-2 xl:grid-cols-3">
                        {outlets.map((outlet) => (
                          <OutletCard key={outlet.id} outlet={outlet} onToggle={toggleOutlet} />
                        ))}
                      </div>
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