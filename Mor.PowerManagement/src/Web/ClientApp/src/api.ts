import { CRITICAL_THRESHOLD, MAX_CAPACITY, WARNING_THRESHOLD } from './data/dashboard'
import type { EventLog, Outlet, OutletStatus, Priority, Severity } from './types/dashboard'

const API_BASE = '/api'

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      ...init,
    })
  } catch {
    throw new ApiError(0, 'Backend unreachable')
  }

  if (response.status === 204) return undefined as T
  if (!response.ok) throw new ApiError(response.status, `Request failed: ${response.status}`)
  // Identity endpoints (login/logout) return 200 with an empty body — only parse when there is content.
  const text = await response.text()
  return (text ? (JSON.parse(text) as T) : undefined) as T
}

// Backend serializes JSON in camelCase with enums as numbers:
// OutletPriority Low=1..Critical=4, OutletStatus Active=0..Disconnected=3,
// EventSeverity Info=0..Critical=3, SystemState Normal=0..Critical=2.
function toPriority(value: number): Priority {
  switch (value) {
    case 4:
      return 'Critical'
    case 3:
      return 'High'
    case 2:
      return 'Medium'
    default:
      return 'Low'
  }
}

const outletStatuses: OutletStatus[] = ['Active', 'Standby', 'Restricted', 'Disconnected']

function toStatus(value: number): OutletStatus {
  return outletStatuses[value] ?? 'Disconnected'
}

const severities: Severity[] = ['info', 'success', 'warning', 'critical']

function toSeverity(value: number): Severity {
  return severities[value] ?? 'info'
}

type BackendOutlet = {
  id: number
  name: string
  role: string
  meterChannel: string
  relayChannel: string
  priority: number
  allowanceWatts: number
  ratedVoltageVolts: number
  watts: number
  status: number
  schedule: string
  idleLimitMinutes: number | null
  lastSeen: string | null
}

type BackendEvent = {
  id: number
  timestamp: string
  title: string
  detail: string
  severity: number
}

type BackendState = {
  outlets: BackendOutlet[]
  totalWatts: number
  remainingWatts: number
  loadPercent: number
  state: number
  energizedCount: number
  thresholds: {
    maxCapacityWatts: number
    warningThresholdWatts: number
    criticalThresholdWatts: number
    standbyThresholdWatts: number
  }
  recentEvents: BackendEvent[]
  deviceOnline: boolean
  deviceLastSeen: string | null
}

export type DashboardSnapshot = {
  outlets: Outlet[]
  events: EventLog[]
  thresholds: { max: number; warning: number; critical: number }
  deviceOnline: boolean
  deviceLastSeen: string | null
}

function formatEventTime(timestamp: string): string {
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) return timestamp
  return parsed.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}

function mapOutlet(outlet: BackendOutlet): Outlet {
  return {
    id: outlet.id,
    name: outlet.name,
    role: outlet.role,
    meter: outlet.meterChannel,
    relay: outlet.relayChannel,
    priority: toPriority(outlet.priority),
    allowance: outlet.allowanceWatts,
    volts: outlet.ratedVoltageVolts ?? 220,
    watts: outlet.watts,
    status: toStatus(outlet.status),
    schedule: outlet.schedule,
    idleLimit: outlet.idleLimitMinutes === null ? 'Exempt' : `${outlet.idleLimitMinutes} min`,
  }
}

function mapEvent(event: BackendEvent): EventLog {
  return {
    id: event.id,
    time: formatEventTime(event.timestamp),
    title: event.title,
    detail: event.detail,
    severity: toSeverity(event.severity),
  }
}

export async function fetchDashboardState(): Promise<DashboardSnapshot> {
  const state = await request<BackendState>('/Dashboard/state')
  return {
    outlets: state.outlets.map(mapOutlet),
    events: state.recentEvents.map(mapEvent),
    thresholds: {
      max: state.thresholds.maxCapacityWatts || MAX_CAPACITY,
      warning: state.thresholds.warningThresholdWatts || WARNING_THRESHOLD,
      critical: state.thresholds.criticalThresholdWatts || CRITICAL_THRESHOLD,
    },
    deviceOnline: state.deviceOnline ?? false,
    deviceLastSeen: state.deviceLastSeen ?? null,
  }
}

export type PolicyItem = {
  id: string
  name: string
  condition: string
  action: string
}

type BackendPolicy = {
  id: number
  code: string
  name: string
  condition: string
  action: string
}

export async function fetchPolicies(): Promise<PolicyItem[]> {
  const policies = await request<BackendPolicy[]>('/Dashboard/policies')
  return policies.map((policy) => ({
    id: policy.code,
    name: policy.name,
    condition: policy.condition,
    action: policy.action,
  }))
}

export async function activateOutlet(id: number): Promise<void> {
  await request(`/Dashboard/outlets/${id}/activation`, { method: 'POST' })
}

export async function disconnectOutlet(id: number): Promise<void> {
  await request(`/Dashboard/outlets/${id}/disconnection`, { method: 'POST' })
}

export async function applySelectiveResponse(): Promise<void> {
  await request('/Dashboard/shedding/selective', { method: 'POST', body: JSON.stringify({ count: 2 }) })
}

// Identity cookie endpoints (surfaced under /api/Users/*).
export async function checkSession(): Promise<string> {
  const info = await request<{ email: string }>('/Users/manage/info')
  return info.email
}

export async function login(email: string, password: string): Promise<void> {
  await request('/Users/login?useCookies=true', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
}

export async function logout(): Promise<void> {
  await request('/Users/logout', { method: 'POST', body: '{}' })
}
