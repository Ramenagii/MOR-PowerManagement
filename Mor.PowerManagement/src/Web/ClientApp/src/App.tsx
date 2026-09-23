import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'framer-motion'
import { Activity, Gauge, PlugZap, ScanLine, ShieldCheck } from 'lucide-react'
import {
  ApiError,
  activateOutlet,
  applySelectiveResponse,
  checkSession,
  disconnectOutlet,
  fetchDashboardState,
  logout,
} from './api'
import { EventLogPanel } from './components/EventLogPanel'
import { HardwareView } from './components/HardwareView'
import { LoadwiseBrand } from './components/LoadwiseBrand'
import { LoadingScreen } from './components/LoadingScreen'
import { LoginGate } from './components/LoginGate'
import { MetricCard } from './components/MetricCard'
import { OutletCard } from './components/OutletCard'
import { PoliciesView } from './components/PoliciesView'
import { ScenarioPanel } from './components/ScenarioPanel'
import { ViewMenu } from './components/ViewMenu'
import {
  baseOutlets,
  CRITICAL_THRESHOLD,
  initialEvents,
  MAX_CAPACITY,
  priorityRank,
  WARNING_THRESHOLD,
} from './data/dashboard'
import type { AppView, EventLog, Outlet, Severity } from './types/dashboard'
import { formatWatts, getTimeStamp, isEnergizedOutlet, totalLoad } from './utils/dashboard'

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

  const resetNormal = () => {
    setOutlets(baseOutlets)
    setEvents([
      {
        id: Date.now(),
        time: getTimeStamp(),
        title: 'Scenario reset',
        detail: 'Baseline simulated laboratory load restored.',
        severity: 'success',
      },
      ...initialEvents,
    ])
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

  const blockInsufficientCapacity = () => {
    setOutlets((current) =>
      current.map((outlet) => {
        if (outlet.id === 1) return { ...outlet, watts: 520, status: 'Active' }
        if (outlet.id === 2) return { ...outlet, watts: 500, status: 'Active' }
        if (outlet.id === 3) return { ...outlet, watts: 420, status: 'Active' }
        if (outlet.id === 4) return { ...outlet, watts: 330, status: 'Active' }
        if (outlet.id === 5) return { ...outlet, watts: 150, status: 'Active' }
        return { ...outlet, watts: 0, status: 'Restricted' }
      }),
    )
    addEvent(
      'Pre-activation restriction',
      'A new low-priority outlet request was restricted because projected load would exceed the configured threshold.',
      'warning',
    )
  }

  const postActivationOverload = () => {
    setOutlets((current) =>
      current.map((outlet) => {
        if (outlet.id === 6) return { ...outlet, watts: 460, status: 'Active' }
        if (outlet.id === 5) return { ...outlet, watts: 160, status: 'Active' }
        return outlet.status === 'Disconnected' ? { ...outlet, status: 'Standby' } : outlet
      }),
    )
    addEvent(
      'Post-activation verification failed',
      'Measured outlet load exceeded the expected allowance after relay activation.',
      'critical',
    )
  }

  const selectiveResponseLocal = () => {
    const lowPriority = outlets
      .filter((outlet) => isEnergizedOutlet(outlet.status))
      .sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority])
      .slice(0, 2)
      .map((outlet) => outlet.id)

    setOutlets((current) =>
      current.map((outlet) =>
        lowPriority.includes(outlet.id)
          ? { ...outlet, status: 'Disconnected', watts: 0 }
          : outlet,
      ),
    )
    addEvent(
      'Selective load response applied',
      'Low-priority outlets were disconnected first while high-priority outlets remained active when possible.',
      'critical',
    )
  }

  const selectiveResponse = () => {
    void runLive(applySelectiveResponse, selectiveResponseLocal)
  }

  const idleShutdown = () => {
    setOutlets((current) =>
      current.map((outlet) =>
        outlet.status === 'Standby' || outlet.watts <= 80
          ? { ...outlet, status: 'Disconnected', watts: 0 }
          : outlet,
      ),
    )
    addEvent(
      'Idle/standby policy enforced',
      'Persistent low-load outlet activity was disconnected according to the configured idle threshold.',
      'info',
    )
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
      current.map((item) =>
        item.id === id
          ? { ...item, status: 'Active', watts: Math.max(90, Math.round(item.allowance * 0.72)) }
          : item,
      ),
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
                      onNormal={resetNormal}
                      onActivate={requestActivation}
                      onBlock={blockInsufficientCapacity}
                      onOverload={postActivationOverload}
                      onSelective={selectiveResponse}
                      onIdle={idleShutdown}
                    />
                  </aside>
                </section>

                <EventLogPanel events={events} />
              </>
            )}

            {activeView === 'policies' && <PoliciesView />}

            {activeView === 'hardware' && <HardwareView />}
          </motion.div>
        </AnimatePresence>
      </motion.main>
    </LayoutGroup>
  )
}

export default App
