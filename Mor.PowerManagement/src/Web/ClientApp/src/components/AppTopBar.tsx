import { Bolt, Power } from 'lucide-react'
import type { AppView } from '../types/dashboard'

/**
 * Top navigation bar, replacing the previous hamburger menu.
 *
 * The redesign's defining structural change is a horizontal tab bar across the
 * top of the viewport rather than a collapsed drawer: with six views a drawer
 * costs two clicks per navigation and hides the whole map of the app. The
 * tab set is kept in step with ViewMenu's ordering so both read the same.
 */
const TABS: Array<{ id: AppView; label: string }> = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'channels', label: 'Channel Inventory' },
  { id: 'telemetry', label: 'Telemetry & Analytics' },
  { id: 'admin', label: 'Policy Admin' },
  { id: 'policies', label: 'Policies' },
  { id: 'hardware', label: 'Hardware' },
]

type AppTopBarProps = {
  activeView: AppView
  onChange: (view: AppView) => void
  systemState: string
  deviceOnline: boolean
  userEmail: string | null
}

export function AppTopBar({
  activeView,
  onChange,
  systemState,
  deviceOnline,
  userEmail,
}: AppTopBarProps) {
  const tone = systemState.toLowerCase()

  return (
    <header className="app-topbar">
      <div className="app-topbar-brand">
        <span className="app-topbar-mark" aria-hidden="true">
          <Bolt size={20} />
        </span>
        <span className="app-topbar-title">MOR Power</span>
        <span className="app-topbar-version">v2.4</span>
      </div>

      <nav className="app-topbar-tabs" aria-label="Console sections">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`app-topbar-tab ${activeView === tab.id ? 'is-active' : ''}`}
            aria-current={activeView === tab.id ? 'page' : undefined}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <div className="app-topbar-spacer" />

      <div className="app-topbar-actions">
        {/* Device state is reported honestly: offline means no recent telemetry,
            and the design's "System Normal" pill must not imply otherwise. */}
        <span
          className={`app-state-pill ${deviceOnline ? tone : 'warning'}`}
          title={
            deviceOnline
              ? 'ESP32 reported telemetry recently'
              : 'No ESP32 telemetry in the last 30 seconds'
          }
        >
          <span className="app-state-dot" />
          {deviceOnline ? `System ${systemState}` : 'Device offline'}
        </span>

        {/*
          The design shows an "Emergency Trip" button. There is no such command
          in the API, and wiring a fake one would put a false control on the
          defense screen. POL-01 fault isolation is reachable through the
          scenario panel instead, so the button is omitted rather than faked.
        */}

        <span className="app-avatar" title={userEmail ?? 'Signed out'} aria-hidden="true">
          {userEmail ? userEmail.slice(0, 1).toUpperCase() : <Power size={16} />}
        </span>
      </div>
    </header>
  )
}