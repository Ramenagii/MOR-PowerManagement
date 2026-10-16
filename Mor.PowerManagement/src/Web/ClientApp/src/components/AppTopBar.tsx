import { useRef, useState } from 'react'
import { LogOut, Power } from 'lucide-react'
import { PowerShieldMark } from './PowerShieldMark'
import { NotificationCentre } from './NotificationCentre'
import type { EventLog } from '../types/dashboard'
import type { AppView } from '../types/dashboard'

/**
 * Top navigation bar, replacing the previous hamburger menu.
 *
 * The redesign's defining structural change is a horizontal tab bar across the
 * top of the viewport rather than a collapsed drawer: with six views a drawer
 * costs two clicks per navigation and hides the whole map of the app. The
 * tab set is kept in step with ViewMenu's ordering so both read the same.
 *
 * Ported to the Ant standard: flat-first surface, hairline bottom rule,
 * underline tabs (active = primary text + a 2px primary baseline), and every
 * control on the shared 32px (h-8) height box so the bar reads as one row.
 *
 * The bar itself stays 60px tall rather than shrinking to its 32px controls:
 * ChannelInventoryView (already ported, not editable here) offsets its own
 * content by --page-margin + 44px through the legacy `.design-main` rule, which
 * assumes a 60px bar. Trimming the bar would open a 20px hole under that view.
 */
const TABS: Array<{ id: AppView; label: string }> = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'channels', label: 'Channel Inventory' },
  { id: 'telemetry', label: 'Telemetry' },
  { id: 'admin', label: 'Framework Admin' },
  { id: 'policies', label: 'Framework' },
  { id: 'hardware', label: 'Hardware' },
]

type AppTopBarProps = {
  activeView: AppView
  onChange: (view: AppView) => void
  systemState: string
  deviceOnline: boolean
  userEmail: string | null
  onLogout: () => void
  events: EventLog[]
}

/**
 * Status colour for the load itself. Offline never borrows the load colour —
 * an unknown state must not read as a healthy one, so it falls back to the
 * tertiary token exactly as the legacy bar did.
 *
 * The normal/healthy dot is deliberately NOT green. Green is not a state
 * colour anywhere in this console: "nothing is wrong" is the absence of an
 * alarm, so it wears the neutral outline token and the bar keeps amber and
 * red as the only two things it can shout about. `.ant-dot-normal` is still
 * `bg-secondary` in ant.css, which is shared and deliberately untouched, so
 * the neutral is applied here as a utility (the utilities layer wins over the
 * components layer ant-dot lives in) rather than by editing shared CSS.
 */
function stateDot(systemState: string, deviceOnline: boolean): string {
  if (!deviceOnline) return 'ant-dot ant-dot-warning'
  if (systemState === 'Critical') return 'ant-dot ant-dot-critical'
  if (systemState === 'Warning') return 'ant-dot ant-dot-warning'
  return 'ant-dot bg-outline-variant'
}

export function AppTopBar({
  activeView,
  onChange,
  systemState,
  deviceOnline,
  userEmail,
  onLogout,
  events,
}: AppTopBarProps) {
  const [profileOpen, setProfileOpen] = useState(false)
  const profileButton = useRef<HTMLButtonElement>(null)

  return (
    <header className="sticky top-0 z-40 h-[60px] border-b border-surface-container bg-surface-container-lowest">
      <div className="mx-auto flex h-full w-full max-w-[1440px] items-center gap-space-md px-margin">
        {/* ---- Identity ---------------------------------------------------- */}
        <div className="flex shrink-0 items-center gap-space-sm">
          <NotificationCentre events={events} userKey={userEmail} />
          <PowerShieldMark className="h-8 w-[29px] shrink-0" title="MOR Power" />
          <span className="hidden whitespace-nowrap font-title-lg text-title-lg font-semibold text-on-surface sm:inline">
            MOR Power
          </span>
          <span className="hidden whitespace-nowrap rounded-sm bg-surface-container px-1.5 py-0.5 font-metric-value text-metric-value text-on-surface-variant md:inline">
            v2.4
          </span>
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
                className={`shrink-0 whitespace-nowrap border-b-2 font-title-md text-title-md transition-colors ${
                  active
                    ? 'border-primary font-semibold text-primary'
                    : 'border-transparent font-medium text-on-surface-variant hover:border-outline-variant hover:text-primary'
                }`}
              >
                {tab.label}
              </button>
            )
          })}
        </nav>

        {/* ---- Status ------------------------------------------------------ */}
        <div className="flex shrink-0 items-center gap-space-sm">
          {/* Device state is reported honestly: offline means no recent telemetry,
              and the design's "System Normal" pill must not imply otherwise. */}
          <span
            className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-outline-variant bg-surface-container-low px-2.5 font-body-sm text-body-sm text-on-surface"
            title={
              deviceOnline
                ? 'ESP32 reported telemetry recently'
                : 'No ESP32 telemetry in the last 30 seconds'
            }
          >
            <span className={stateDot(systemState, deviceOnline)} aria-hidden="true" />
            <span className="hidden sm:inline">
              {deviceOnline ? `System ${systemState}` : 'Device offline'}
            </span>
            <span className="sm:hidden">{deviceOnline ? systemState : 'Offline'}</span>
          </span>

          {/*
            The design shows an "Emergency Trip" button. There is no such command
            in the API, and wiring a fake one would put a false control on the
            defense screen. FR-01 fault isolation is reachable through the
            scenario panel instead, so the button is omitted rather than faked.
          */}

          <div
            className="relative"
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setProfileOpen(false)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && profileOpen) {
                setProfileOpen(false)
                profileButton.current?.focus()
              }
            }}
          >
            <button
              ref={profileButton}
              type="button"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary font-title-md text-title-md font-semibold text-on-primary transition-shadow hover:ring-2 hover:ring-primary/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              title={userEmail ?? 'Profile'}
              aria-label="Open profile menu"
              aria-haspopup="menu"
              aria-expanded={profileOpen}
              onClick={() => setProfileOpen((open) => !open)}
            >
              {userEmail ? userEmail.slice(0, 1).toUpperCase() : <Power size={16} aria-hidden="true" />}
            </button>
            {profileOpen && (
              <div
                className="absolute right-0 top-11 z-50 w-60 overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest p-1.5 shadow-xl"
                role="menu"
                aria-label="Profile menu"
              >
                <div className="truncate px-3 py-2 font-body-sm text-body-sm text-on-surface-variant" title={userEmail ?? undefined}>
                  {userEmail ?? 'Signed in'}
                </div>
                <div className="my-1 border-t border-surface-container" />
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left font-body-sm text-body-sm text-on-surface transition-colors hover:bg-surface-container-low focus-visible:bg-surface-container-low focus-visible:outline-none"
                  onClick={() => {
                    setProfileOpen(false)
                    onLogout()
                  }}
                >
                  <LogOut size={16} aria-hidden="true" />
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  )
}
