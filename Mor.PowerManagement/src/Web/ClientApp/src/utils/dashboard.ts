import type { Outlet, OutletStatus } from '../types/dashboard'

export function getTimeStamp() {
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date())
}

export function formatWatts(value: number) {
  return `${Math.round(value).toLocaleString()} W`
}

export function totalLoad(outlets: Outlet[]) {
  return outlets.reduce((sum, outlet) => sum + outlet.watts, 0)
}

export function isEnergizedOutlet(status: OutletStatus) {
  return status === 'Active' || status === 'Standby'
}

/**
 * System band for a load, against thresholds the caller read from the server.
 *
 * The trip points are arguments rather than module constants on purpose. This
 * used to compare against a copy of the rig's 600/480 W held in data/dashboard,
 * so the top bar's "System Normal" was a statement about a number the console
 * had invented — and with an offline rig at 0 W it cheerfully reported Normal
 * against a limit that did not exist.
 *
 * A critical of 0 means "no limit has been reported". 0 load is then not a band,
 * it is an absence of information, so the answer is Normal only because there is
 * nothing to be warning about — and the dashboard's own banner is what tells the
 * operator that the threshold behind that verdict is missing.
 */
export function systemState(load: number, warning: number, critical: number) {
  if (critical > 0 && load >= critical) return 'Critical'
  if (warning > 0 && load >= warning) return 'Warning'
  return 'Normal'
}

export function statusClass(status: OutletStatus) {
  return status.toLowerCase()
}
