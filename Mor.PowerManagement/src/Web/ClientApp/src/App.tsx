import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'framer-motion'
import { LogOut, RotateCcw } from 'lucide-react'
import {
  ApiError,
  activateOutlet,
  checkSession,
  disconnectOutlet,
  fetchDashboardState,
  ingestScenario,
  logout,
  UNMEASURED_INA226,
  type Ina226Reading,
} from './api'
import { ChannelInventoryView } from './components/ChannelInventoryView'
import { Dashboard } from './components/Dashboard'
import { HardwareView } from './components/HardwareView'
import { LoadingScreen } from './components/LoadingScreen'
import { LoginGate } from './components/LoginGate'
import { PolicyAdminView } from './components/PolicyAdminView'
import { PoliciesView } from './components/PoliciesView'
import { TelemetryView } from './components/TelemetryView'
import { AppTopBar } from './components/AppTopBar'
import { baseOutlets, initialEvents } from './data/dashboard'
import type { AppView, EventLog, Outlet, Severity } from './types/dashboard'
import { formatWatts, getTimeStamp, isEnergizedOutlet, systemState, totalLoad } from './utils/dashboard'
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

function App() {
  // Shape only. `baseOutlets` carries no wattage, no rated rail and no relay
  // state, and `initialEvents` is empty — the first successful poll replaces all
  // of it. Nothing that renders as a measurement exists before the server says
  // so.
  const [outlets, setOutlets] = useState<Outlet[]>(baseOutlets)
  const [events, setEvents] = useState<EventLog[]>(initialEvents)
  // 0 is "the server has not told us". It is not 600/480/600: a guessed ceiling
  // renders as "0 % of 600 W limit — full headroom" on a rig that knows nothing,
  // and the hero shows a dash for every limit-derived figure instead.
  const [thresholds, setThresholds] = useState({ max: 0, warning: 0, critical: 0 })
  const [session, setSession] = useState<Session>('checking')
  // Shown in the top bar avatar and the footer. checkSession() already returns
  // the signed-in address, so this costs nothing extra.
  const [userEmail, setUserEmail] = useState<string | null>(null)
  const [backendOnline, setBackendOnline] = useState(false)
  const [deviceOnline, setDeviceOnline] = useState(false)
  const [mainsVolts, setMainsVolts] = useState<number | null>(null)
  const [ina226, setIna226] = useState<Ina226Reading>(UNMEASURED_INA226)
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
    setMainsVolts(snapshot.mainsVolts)
    setIna226(snapshot.ina226)
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
          // Backend unreachable. There is no simulated baseline to fall back to:
          // the shell renders zeros and says why.
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
  const currentState = systemState(load, thresholds.warning, thresholds.critical)

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

  /*
   * Offline the browser cannot ask the engine anything, so these two paths
   * refuse rather than pretend. They used to make the decision locally AND write
   * a wattage into the row — 190 W on the activation request, `allowance * 0.72`
   * with a 90 W floor on the manual toggle — which is the exact failure the whole
   * console is built against: a number the operator reads, that no instrument
   * ever produced, sitting in a column labelled watts.
   *
   * `thresholds.critical` is 0 until the server supplies it, so "is there room"
   * cannot even be evaluated here. Saying so is the honest answer and it tells
   * the operator what to do about it.
   */
  const requestActivationLocal = () => {
    const requested = outlets.find((outlet) => outlet.id === 1)
    if (!requested) return

    if (thresholds.critical <= 0) {
      addEvent(
        'Activation not assessed',
        'No configured capacity has been read from the server, so this request cannot be judged in the browser. Sign in to dispatch it to the policy engine.',
        'warning',
      )
      return
    }

    const projectedLoad = load + requested.allowance
    if (projectedLoad > thresholds.critical) {
      addEvent(
        'Activation blocked',
        `Outlet 1 request denied: ${formatWatts(load)} current load + ${formatWatts(
          requested.allowance,
        )} allowance exceeds the configured critical threshold.`,
        'warning',
      )
      return
    }

    setOutlets((current) =>
      current.map((outlet) =>
        // Status only. The branch is energized but nothing has been metered on
        // it, so it reports 0 W until a telemetry batch says otherwise.
        outlet.id === 1 ? { ...outlet, status: 'Active', watts: 0 } : outlet,
      ),
    )
    addEvent(
      'Outlet activation allowed',
      'Pre-activation capacity assessment passed; Outlet 1 relay energized. No wattage is shown for it — the local path cannot measure.',
      'success',
    )
  }

  // FUTURE 4+USB: SIM-02 id 1 stays valid — CH1 exists in both the 2-outlet and
  // the 4+USB rig, so this activation request needs no retarget when the full
  // bench is restored.
  const requestActivation = () => {
    void runLive(() => activateOutlet(1), requestActivationLocal)
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

    if (thresholds.critical <= 0) {
      addEvent(
        'Manual activation not assessed',
        `No configured capacity has been read from the server, so ${outlet.name} cannot be capacity-checked in the browser. Sign in to dispatch the request to the policy engine.`,
        'warning',
      )
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
        /*
          Status only — deliberately no wattage.
          This used to mirror the backend activation estimate
          (`Math.max(90, allowance * 0.72)` on mains) and write the result into
          the row. That estimate is a server-side planning figure for deciding
          whether to permit a switch-on; rendering it in the watts column made a
          guess look like a measurement on the one screen whose job is to say
          which numbers are real. The relay moves; the row stays at 0 until
          telemetry reports a draw.
        */
        return { ...item, status: 'Active', watts: 0 }
      }),
    )
    addEvent(
      'Manual relay action',
      `${outlet.name} was activated after capacity assessment. No wattage is shown for it until telemetry reports one.`,
      'success',
    )
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

  // Was "Simulated — backend offline". Nothing simulates any more: the rig stops
  // reporting and every figure drops to 0 with the reason attached. Calling that
  // a simulation implied the zeros were the output of a working model.
  const connectionLabel =
    session === 'authed' && backendOnline ? 'Live — backend' : 'Offline — backend unreachable'

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

        {/*
          The OFFLINE banner now lives inside <Dashboard>, next to the figures
          it explains. It used to sit here as a standalone card above the shell,
          which meant two places to describe the same failure and a banner whose
          sign-in button was far from the readouts it invalidated.
        */}

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
              Two views opt out of the shared page frame and own their own
              container instead:

              - 'channels' ships its own legacy `.design-main` frame, ported
                first and not editable here.
              - 'dashboard' is the MOR Power reference design, which specifies
                its own 1180px column and 20px gutters. Giving it the shared
                1440px/24px wrapper would both widen it past the reference and
                stack the padding twice.

              Every other view keeps the same 24px margin and 1440px column.
            */}
            <div
              className={
                activeView === 'channels' || activeView === 'dashboard'
                  ? 'w-full'
                  : 'mx-auto flex w-full max-w-[1440px] flex-col gap-space-lg px-margin py-space-lg'
              }
            >
              {activeView === 'dashboard' && (
                <Dashboard
                  outlets={outlets}
                  thresholds={thresholds}
                  events={events}
                  deviceOnline={deviceOnline}
                  backendOnline={backendOnline}
                  mainsVolts={mainsVolts}
                  ina226={ina226}
                  scenario={{
                    onNormal: scenarioNormal,
                    onActivate: requestActivation,
                    onBlock: scenarioCapacityBlock,
                    onOverload: scenarioOverload,
                    onSelective: scenarioSelective,
                    onIdle: scenarioIdle,
                    notice: scenarioNotice,
                    busy: scenarioBusy,
                  }}
                  onToggleOutlet={toggleOutlet}
                  onSignIn={() => setSession('login')}
                />
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