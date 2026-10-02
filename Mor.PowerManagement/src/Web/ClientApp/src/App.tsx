import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'framer-motion'
import { Activity, Gauge, PlugZap, ScanLine, ShieldCheck } from 'lucide-react'
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
import { LoadwiseBrand } from './components/LoadwiseBrand'
import { LoadingScreen } from './components/LoadingScreen'
import { LoginGate } from './components/LoginGate'
import { MetricCard } from './components/MetricCard'
import { OutletCard } from './components/OutletCard'
import { PoliciesView } from './components/PoliciesView'
import { PolicyAdminView } from './components/PolicyAdminView'
import { ScenarioPanel } from './components/ScenarioPanel'
import { TelemetryView } from './components/TelemetryView'
import { ViewMenu } from './components/ViewMenu'
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

function App() {
  const [outlets, setOutlets] = useState<Outlet[]>(baseOutlets)
  const [events, setEvents] = useState<EventLog[]>(initialEvents)
  const [thresholds, setThresholds] = useState({
    max: MAX_CAPACITY,
    warning: WARNING_THRESHOLD,
    critical: CRITICAL_THRESHOLD,
  })
  const [session, setSession] = useState<Session>('checking')
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
      .then(() => {
        if (cancelled) return
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
    }, 5000)
    return () => window.clearInterval(timer)
  }, [session, refreshFromBackend])

  useEffect(() => {
    const timer = window.setTimeout(() => setIntroDone(true), 3600)
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

  return (
    <LayoutGroup id={`loadwise-${introKey}`}>
      <AnimatePresence mode="popLayout">
        {!introDone && <LoadingScreen key={`intro-${introKey}`} />}
      </AnimatePresence>
      <motion.main
        className={`app-shell ${introDone ? 'is-ready' : 'is-waiting'}`}
        initial={false}
        animate={introDone ? { opacity: 1, y: 0 } : { opacity: 0, y: 12 }}
        transition={{ duration: 0.56, ease: [0.22, 1, 0.36, 1] }}
      >
        <header className="topbar">
          <div className="topbar-identity">
            <AnimatePresence>
              {introDone && (
                <motion.div
                  className="topbar-logo-slot"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                >
                  <LoadwiseBrand variant="header" />
                </motion.div>
              )}
            </AnimatePresence>
            <div>
              <p className="eyebrow">Shared Laboratory Power Management</p>
              <h1>Power Management Console</h1>
            </div>
          </div>
          <div className="topbar-actions">
            <span className={`system-pill ${backendOnline ? 'normal' : 'warning'}`}>
              {connectionLabel}
            </span>
            <span
              className={`system-pill ${deviceOnline ? 'normal' : 'warning'}`}
              title={deviceOnline ? 'ESP32 posted telemetry in the last 30 seconds' : 'No ESP32 telemetry in the last 30 seconds'}
            >
              {deviceOnline ? 'ESP32 online' : 'ESP32 offline'}
            </span>
            <button type="button" className="replay-button" onClick={replayIntro}>
              Replay intro
            </button>
            {session === 'offline' && (
              <button type="button" className="replay-button" onClick={() => setSession('login')}>
                Sign in
              </button>
            )}
            {session === 'authed' && (
              <button type="button" className="replay-button" onClick={handleLogout}>
                Sign out
              </button>
            )}
            <div className={`system-pill ${currentState.toLowerCase()}`}>
              <Activity size={18} />
              {currentState}
            </div>
          </div>
        </header>

        <ViewMenu activeView={activeView} onChange={setActiveView} />

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={activeView}
            className={`route-view ${activeView}-route`}
            layoutId="loadwise-route-surface"
            initial={routeInitial}
            animate={routeAnimate}
            exit={routeExit}
            transition={{ duration: 0.48, ease: [0.22, 1, 0.36, 1] }}
          >
            {activeView === 'dashboard' && (
              <>
                <section className="overview-grid" aria-label="System overview">
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
                  <MetricCard
                    icon={<ScanLine />}
                    label="Metering channels"
                    value={`${outlets.length}`}
                    note="Single mains PZEM-004T v3.0 on the common feed"
                  />
                </section>

                <section className="load-panel" aria-label="Load capacity meter">
                  <div className="section-heading">
                    <div>
                      <p className="eyebrow">Real-time load condition</p>
                      <h2>Capacity and thresholds</h2>
                    </div>
                    <span>
                      {formatWatts(load)} / {formatWatts(thresholds.max)}
                    </span>
                  </div>
                  <div className="meter" aria-label="Total load usage">
                    <div className="warning-mark" />
                    <div className="critical-mark" />
                    <div
                      className={`meter-fill ${currentState.toLowerCase()}`}
                      style={{ width: `${loadPercent}%` }}
                    />
                  </div>
                  <div className="threshold-row">
                    <span>Normal</span>
                    <span>Warning: {formatWatts(thresholds.warning)}</span>
                    <span>Critical: {formatWatts(thresholds.critical)}</span>
                  </div>
                </section>

                <section className="workspace-grid dashboard-workspace">
                  <div className="outlet-section">
                    <div className="section-heading">
                      <div>
                        <p className="eyebrow">Outlet-level monitoring</p>
                        <h2>{`${outlets.length} controlled channels`}</h2>
                      </div>
                    </div>
                    <div className="outlet-grid">
                      {outlets.map((outlet) => (
                        <OutletCard key={outlet.id} outlet={outlet} onToggle={toggleOutlet} />
                      ))}
                    </div>
                  </div>

                  <aside className="side-stack">
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
                  </aside>
                </section>

                <EventLogPanel events={events} />
              </>
            )}

            {activeView === 'channels' && <ChannelInventoryView />}

            {activeView === 'telemetry' && <TelemetryView />}

            {activeView === 'admin' && <PolicyAdminView />}

            {activeView === 'policies' && <PoliciesView />}

            {activeView === 'hardware' && <HardwareView />}
          </motion.div>
        </AnimatePresence>
      </motion.main>
    </LayoutGroup>
  )
}

export default App
