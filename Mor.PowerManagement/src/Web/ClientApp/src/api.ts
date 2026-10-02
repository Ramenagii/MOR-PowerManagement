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
// Inverse of toPriority: the backend binds OutletPriority as its numeric value, so
// the admin form's string has to go back as a number or the PUT silently no-ops
// (FluentValidation ignores the unparseable member, Priority is not validated).
const priorityValues: Record<Priority, number> = {
  Low: 1,
  Medium: 2,
  High: 3,
  Critical: 4,
}

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
    // Returned by GetDashboardState so the admin form can round-trip every
    // field UpdateThresholdsCommand accepts, rather than write blind.
    standbyIdleMinutes: number
    stabilizationDelayMs: number
  }
  recentEvents: BackendEvent[]
  deviceOnline: boolean
  deviceLastSeen: string | null
}

export type ThresholdSet = {
  max: number
  warning: number
  critical: number
  standby: number
  standbyIdleMinutes: number
  stabilizationDelayMs: number
}

export type DashboardSnapshot = {
  outlets: Outlet[]
  events: EventLog[]
  thresholds: ThresholdSet
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
      // Standby has no client-side fallback constant, so read it directly; the
      // other three keep their offline defaults for the pre-login render.
      standby: state.thresholds.standbyThresholdWatts || 80,
      standbyIdleMinutes: state.thresholds.standbyIdleMinutes ?? 30,
      stabilizationDelayMs: state.thresholds.stabilizationDelayMs ?? 500,
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

// ---------------------------------------------------------------------------
// Administration (PUT /api/Dashboard/thresholds, PUT .../outlets/{id}/policy)
// Both commands are partial: only the fields present are applied server-side,
// so the admin forms can send one value at a time.
// ---------------------------------------------------------------------------

export async function updateThresholds(input: {
  maxCapacityWatts?: number
  warningThresholdWatts?: number
  criticalThresholdWatts?: number
  standbyThresholdWatts?: number
  standbyIdleMinutes?: number
  stabilizationDelayMs?: number
}): Promise<void> {
  await request('/Dashboard/thresholds', { method: 'PUT', body: JSON.stringify(input) })
}

export async function updateOutletPolicy(
  id: number,
  input: {
    priority?: Priority
    allowanceWatts?: number
    schedule?: string
    idleLimitMinutes?: number
    clearIdleLimit?: boolean
  },
): Promise<void> {
  await request(`/Dashboard/outlets/${id}/policy`, {
    method: 'PUT',
    body: JSON.stringify({
      ...input,
      // Numeric, not the display string. See priorityValues above.
      ...(input.priority !== undefined ? { priority: priorityValues[input.priority] } : {}),
    }),
  })
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

// ---------------------------------------------------------------------------
// Device telemetry ingest (POST /api/Device/telemetry)
//
// Used by the defense scenario controls so a demonstration writes REAL rows
// into TelemetryReadings instead of only mutating React state. That is what
// makes the Telemetry charts move in step with the control action.
// ---------------------------------------------------------------------------

/**
 * Backend MeteringMode enum values, for reference when reading API payloads.
 * NOTE: these are integers on the wire -- there is no JsonStringEnumConverter
 * registered, so System.Text.Json binds enums from numbers. The scenario
 * endpoint forces Simulated server-side and the client does not send it.
 */
export const METERING_MODE = {
  /** Device has not reported a mode (pre-provenance firmware, or no config row). */
  Unknown: 0,
  /** SIMULATE_METERS = 1: the ESP32 synthesises every reading on-device. */
  Simulated: 1,
  /** SIMULATE_METERS = 0: a real PZEM-004T is on the common mains feed. */
  Metered: 2,
} as const

export type MeteringMode = (typeof METERING_MODE)[keyof typeof METERING_MODE]

export type TelemetrySampleInput = {
  outletId: number
  voltage: number
  currentAmps: number
  powerWatts: number
  energyKwh: number
}

export type RelayStateInput = {
  outletId: number
  relayClosed: boolean
}

export type IngestResult = {
  totalWatts: number
  /** SystemState enum: Normal=0, Warning=1, Critical=2. */
  state: number
  readingsStored: number
  eventsRaised: string[]
}

/**
 * Posts a batch of readings for the defense-demo scenario controls.
 *
 * Targets /Dashboard/scenarios/ingest, NOT /Device/telemetry. The device route
 * is gated on the X-Device-Key shared secret; the SPA must never hold that key,
 * since anyone able to read the bundled JavaScript could then inject readings.
 * The dashboard route uses the normal cookie auth and forces meteringMode to
 * Simulated server-side, so a demo batch cannot relabel itself as measured.
 *
 * The backend persists the rows, refreshes live outlet state, and evaluates
 * threshold crossings and fault lockout -- so any event this produces is a
 * genuine consequence of the policy engine, not a string invented in the
 * browser.
 */
export async function ingestScenario(input: {
  deviceId?: string
  faultFlag?: boolean
  readings: TelemetrySampleInput[]
  relayStates: RelayStateInput[]
}): Promise<IngestResult> {
  return request<IngestResult>('/Dashboard/scenarios/ingest', {
    method: 'POST',
    body: JSON.stringify(input),
  })
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

// ---------------------------------------------------------------------------
// Telemetry series (GET /api/Dashboard/telemetry)
// ---------------------------------------------------------------------------

export type TelemetryWindow = '15m' | '1h' | '6h' | '24h' | '7d'

export type TelemetryProvenance =
  | 'Measured'
  | 'DerivedNominal'
  | 'DerivedLoadShare'
  | 'Simulated'
  | 'Unknown'

export type TelemetryChannel = {
  outletId: number
  name: string
  relayChannel: string
  ratedVoltageVolts: number
  provenance: TelemetryProvenance
  provenanceNote: string
  sampleCount: number
  volts: Array<number | null>
  amps: Array<number | null>
  watts: Array<number | null>
  peakWatts: Array<number | null>
}

export type TelemetrySeries = {
  from: string
  to: string
  window: TelemetryWindow
  bucketSeconds: number
  resolution: string
  windowLabel: string
  bucketCount: number
  rawSampleCount: number
  truncated: boolean
  meteringMode: string
  generatedAt: string
  latestSampleAt: string | null
  timestamps: string[]
  channels: TelemetryChannel[]
  totals: { watts: Array<number | null>; energyKwhDelta: number | null }
}

const ALL_CHANNELS = 13

// `channels` is omitted when nothing is filtered, so the server returns all 13.
// Any other subset is sent as a sorted, comma-joined id list.
function telemetryQuery(window: TelemetryWindow, channels?: number[]): string {
  const base = `?window=${encodeURIComponent(window)}`
  if (!channels || channels.length === 0 || channels.length === ALL_CHANNELS) return base
  return `${base}&channels=${[...channels].sort((a, b) => a - b).join(',')}`
}

export async function fetchTelemetrySeries(
  window: TelemetryWindow,
  channels?: number[],
  signal?: AbortSignal,
): Promise<TelemetrySeries> {
  return request<TelemetrySeries>(`/Dashboard/telemetry${telemetryQuery(window, channels)}`, { signal })
}
