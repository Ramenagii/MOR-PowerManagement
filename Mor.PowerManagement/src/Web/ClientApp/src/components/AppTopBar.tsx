import { Bolt, Power } from 'lucide-react'
import type { AppView } from '../types/dashboard'
import type { SensorFault } from '../utils/sensorFault'

/**
 * Top navigation bar.
 *
 * A horizontal tab bar across the top of the viewport rather than a collapsed
 * drawer: with six views a drawer costs two clicks per navigation and hides the
 * whole map of the app.
 *
 * 64px tall. The controls on it are the standard's 40px box, so the bar is a
 * layout choice rather than a compatibility constraint — nothing below it
 * depends on the exact height any more.
 *
 * THE STATUS PILL IS THE INTERESTING PART.
 *
 * It used to say "System {band}" derived from the load total. That is wrong
 * under the current fault: the backend computes Normal from a total of 0 W
 * while the device has latched `S_fault` and stopped reading its sensors, so
 * the most reassuring word on the screen was the one least entitled to be
 * there. When a fault is in the record the pill now says what the record
 * actually says, and it wears the critical wash. Everything else on the bar is
 * allowed to be quiet; this is not.
 */
const TABS: Array<{ id: AppView; label: string }> = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'channels', label: 'Channel Inventory' },
  { id: 'telemetry', label: 'Telemetry' },
  { id: 'admin', label: 'Policy Admin' },
  { id: 'policies', label: 'Policies' },
  { id: 'hardware', label: 'Hardware' },
]

type AppTopBarProps = {
  activeView: AppView
  onChange: (view: AppView) => void
  /** Load-derived band, from the API's own thresholds. Ignored when faulted. */
  systemState: string
  /** What the pill actually renders. Already fault-aware. */
  systemLabel: string
  sensorFault: SensorFault | null
  deviceOnline: boolean
  userEmail: string | null
}

export function AppTopBar({
  activeView,
  onChange,
  systemLabel,
  sensorFault,
  deviceOnline,
  userEmail,
}: AppTopBarProps) {
  const faulted = sensorFault !== null

  return (
    <header className="sticky top-0 z-40 h-16 border-b border-outline-variant bg-surface-container-lowest">
      <div className="mx-auto flex h-full w-full max-w-[1440px] items-center gap-space-md px-margin">
        {/* ---- Identity ---------------------------------------------------- */}
        <div className="flex shrink-0 items-center gap-space-sm">
          <span
            className="grid h-8 w-8 place-items-center rounded bg-primary text-on-primary"
            aria-hidden="true"
          >
            <Bolt size={18} />
          </span>
          <span className="hidden whitespace-nowrap font-title-lg text-title-lg font-semibold text-on-surface sm:inline">
            MOR Power
          </span>
          {/*
            No build/version chip here, and none should be added. It used to
            read "v2.4", a string with no source behind it — the SPA never asked
            the host for a version, so it would silently disagree with reality
            the day the backend moved. If a version is wanted it has to come from
            an endpoint; until then the bar shows only what it can prove.
          */}
        </div>

        {/* ---- Tabs -------------------------------------------------------- */}
        <nav
          aria-label="Console sections"
          className="flex h-full min-w-0 flex-1 items-stretch gap-space-lg overflow-x-auto"
        >
          {TABS.map((tab) => {
            const active = activeView === tab.id
            return (
              <button
                key={tab.id}
                type="button"
                aria-current={active ? 'page' : undefined}
                onClick={() => onChange(tab.id)}
                className={`shrink-0 whitespace-nowrap border-b-2 px-0.5 font-title-md text-title-md transition-colors ${
                  active
                    ? 'border-primary font-semibold text-primary'
                    : 'border-transparent font-medium text-on-surface-variant hover:border-outline-strong hover:text-on-surface'
                }`}
              >
                {tab.label}
              </button>
            )
          })}
        </nav>

        {/* ---- Status ------------------------------------------------------ */}
        <div className="flex shrink-0 items-center gap-space-sm">
          {/*
            Three states, and the fault one outranks the other two: a faulted
            device that is still posting is the combination an operator is most
            likely to read as healthy, because "online" is right.
          */}
          <span
            className={`inline-flex h-10 items-center gap-2 whitespace-nowrap rounded border px-3 font-body-sm text-body-sm ${
              faulted
                ? 'border-error-fixed bg-error-container font-medium text-error'
                : deviceOnline
                  ? 'border-outline-variant bg-surface-container-low text-on-surface-variant'
                  : 'border-tertiary-fixed bg-tertiary-container font-medium text-tertiary'
            }`}
            title={
              faulted
                ? sensorFault.at
                  ? `Sensor fault latched at ${new Date(sensorFault.at).toLocaleString()}`
                  : 'Sensor fault latched — see the rail below'
                : deviceOnline
                  ? 'ESP32 reported telemetry recently'
                  : 'No ESP32 telemetry recently'
            }
          >
            <span
              className={`ant-dot ${
                faulted ? 'ant-dot-critical' : deviceOnline ? 'ant-dot-normal' : 'ant-dot-warning'
              }`}
              aria-hidden="true"
            />
            <span className="hidden sm:inline">{systemLabel}</span>
            <span className="sm:hidden">{faulted ? 'Fault' : deviceOnline ? 'OK' : 'Offline'}</span>
          </span>

          {/*
            The design shows an "Emergency Trip" button. There is no such
            command in the API, and wiring a fake one would put a false control
            on the defense screen. FR-01 fault isolation is reachable through
            the scenario panel instead, so the button is omitted rather than
            faked.
          */}

          <span
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary font-title-md text-title-md font-semibold text-on-primary"
            title={userEmail ?? 'Signed out'}
          >
            {userEmail ? userEmail.slice(0, 1).toUpperCase() : <Power size={16} aria-hidden="true" />}
          </span>
        </div>
      </div>
    </header>
  )
}