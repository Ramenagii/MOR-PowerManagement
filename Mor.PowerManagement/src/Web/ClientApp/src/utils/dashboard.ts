import { CRITICAL_THRESHOLD, WARNING_THRESHOLD } from '../data/dashboard'
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

export function systemState(load: number) {
  if (load >= CRITICAL_THRESHOLD) return 'Critical'
  if (load >= WARNING_THRESHOLD) return 'Warning'
  return 'Normal'
}

export function statusClass(status: OutletStatus) {
  return status.toLowerCase()
}
