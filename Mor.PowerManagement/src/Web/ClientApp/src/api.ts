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
  isProtected: boolean
  manualHold: boolean
  faultHold: boolean
  recoveryLockout: boolean
  automaticRecoveryAttempts: number
  nextRecoveryAtUtc: string | null
  commandNeedsReview: boolean
  commandPending: boolean
  recoveryTrialPending: boolean
}

type BackendEvent = {
  id: number
  timestamp: string
  title: string
  detail: string
  severity: number
  actor?: string | null
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
  framework: {
    deviceProtocolReady?: boolean
    automaticPrioritisationEnabled?: boolean
    faultLatched?: boolean
    consecutiveOverLimitBatches?: number
    overLimitConfirmationSeconds?: number
    recoveryLimitWatts?: number
    shedOutletIds?: number[]
  }
  deviceOnline: boolean
  deviceLastSeen: string | null
  // Legacy field: current firmware reports fixed mains voltage separately.
  // Null when no mains reference is available.
  mainsVolts: number | null
  // Raw INA226 DC bus/shunt reading polled by the ESP32 over I2C. Optional AND nullable: the
  // payload predates this field entirely until web-api-client.ts is regenerated,
  // and an absent object must read exactly like one full of nulls.
  ina226?: {
    busVolts?: number | null
    shuntMillivolts?: number | null
    currentAmps?: number | null
    powerWatts?: number | null
    sampledAt?: string | null
  }
}

/**
 * One INA226 DC bus/shunt sample, polled by the ESP32 over I2C.
 *
 * Every field is nullable and none of them is ever filled in from a default.
 * The whole point of this type is that "the device did not report that" stays
 * distinguishable from "the device reported zero" — collapsing the two is how a
 * dead sensor gets reported as an idle rig.
 */
export type Ina226Reading = {
  busVolts: number | null
  /** Millivolts across the shunt. This is what the current reading is made of. */
  shuntMillivolts: number | null
  currentAmps: number | null
  powerWatts: number | null
  /** ISO stamp of the sample these four numbers belong to. */
  sampledAt: string | null
}

/** The all-unmeasured reading. Never partially filled. */
export const UNMEASURED_INA226: Ina226Reading = {
  busVolts: null,
  shuntMillivolts: null,
  currentAmps: null,
  powerWatts: null,
  sampledAt: null,
}

/**
 * Numeric read that refuses to invent.
 *
 * Absent, null, NaN and Infinity all collapse to null, because a converter that
 * returns garbage has not measured anything either. A real 0 survives, which is
 * the distinction the whole card is built on.
 */
function toMeasurement(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function mapIna226(raw: BackendState['ina226']): Ina226Reading {
  if (!raw) return { ...UNMEASURED_INA226 }
  return {
    busVolts: toMeasurement(raw.busVolts),
    shuntMillivolts: toMeasurement(raw.shuntMillivolts),
    currentAmps: toMeasurement(raw.currentAmps),
    powerWatts: toMeasurement(raw.powerWatts),
    sampledAt: typeof raw.sampledAt === 'string' && raw.sampledAt.length > 0 ? raw.sampledAt : null,
  }
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
  totalWatts: number
  events: EventLog[]
  thresholds: ThresholdSet
  deviceOnline: boolean
  deviceLastSeen: string | null
  mainsVolts: number | null
  ina226: Ina226Reading
  deviceProtocolReady: boolean
  framework: {
    automaticPrioritisationEnabled: boolean
    faultLatched: boolean
    consecutiveOverLimitBatches: number
    overLimitConfirmationSeconds: number
    recoveryLimitWatts: number
    shedOutletIds: number[]
  }
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
    // Rated rail is CONFIGURATION, not a reading — but a missing rating is still
    // a missing fact. The old `?? 220` invented a 220 V rail for any channel the
    // server had not rated, which then reached the UI labelled "Rail". 0 says
    // "unrated"; the views that show it print a dash instead of a number.
    volts: toMeasurement(outlet.ratedVoltageVolts) ?? 0,
    watts: outlet.watts,
    status: toStatus(outlet.status),
    lastSeen: outlet.lastSeen ?? null,
    schedule: outlet.schedule,
    idleLimit: outlet.idleLimitMinutes === null ? 'Exempt' : `${outlet.idleLimitMinutes} min`,
    isProtected: outlet.isProtected,
    manualHold: outlet.manualHold,
    faultHold: outlet.faultHold,
    recoveryLockout: outlet.recoveryLockout,
    automaticRecoveryAttempts: outlet.automaticRecoveryAttempts,
    nextRecoveryAtUtc: outlet.nextRecoveryAtUtc,
    commandNeedsReview: outlet.commandNeedsReview,
    commandPending: outlet.commandPending,
    recoveryTrialPending: outlet.recoveryTrialPending,
  }
}

function mapEvent(event: BackendEvent): EventLog {
  return {
    id: event.id,
    time: formatEventTime(event.timestamp),
    // Carried through unlocalised so anything that needs the event's AGE — the
    // sensor-fault rail, for one — can compute it. `time` is a display string
    // and cannot be parsed back into a moment.
    at: event.timestamp,
    title: event.title,
    detail: event.detail,
    severity: toSeverity(event.severity),
    actor: event.actor ?? null,
  }
}

export async function fetchDashboardState(): Promise<DashboardSnapshot> {
  const state = await request<BackendState>('/Dashboard/state')
  // Thresholds are the framework's CONFIGURATION and are read from the server
  // only. The previous `|| 600 / || 480 / || 600` fallbacks meant an absent or
  // zero value silently became a 600 W ceiling, and a 600 W ceiling with a 0 W
  // load renders as "0 % of 600 W limit, full headroom" — a dashboard that looks
  // healthy precisely because it knows nothing. 0 instead makes the limit
  // unusable, which is the truth, and the views print a dash for it.
  return {
    outlets: (state.outlets ?? []).map(mapOutlet),
    totalWatts: toMeasurement(state.totalWatts) ?? 0,
    events: (state.recentEvents ?? []).map(mapEvent),
    thresholds: {
      max: toMeasurement(state.thresholds?.maxCapacityWatts) ?? 0,
      warning: toMeasurement(state.thresholds?.warningThresholdWatts) ?? 0,
      critical: toMeasurement(state.thresholds?.criticalThresholdWatts) ?? 0,
      // `||` was wrong for standby even before: the server validates it as >= 0,
      // so 0 is a legal stored value and `|| 80` would rewrite it on load.
      standby: toMeasurement(state.thresholds?.standbyThresholdWatts) ?? 0,
      standbyIdleMinutes: toMeasurement(state.thresholds?.standbyIdleMinutes) ?? 0,
      stabilizationDelayMs: toMeasurement(state.thresholds?.stabilizationDelayMs) ?? 0,
    },
    deviceOnline: state.deviceOnline ?? false,
    deviceLastSeen: state.deviceLastSeen ?? null,
    mainsVolts: toMeasurement(state.mainsVolts),
    ina226: mapIna226(state.ina226),
    deviceProtocolReady: Boolean(state.framework?.deviceProtocolReady),
    framework: {
      automaticPrioritisationEnabled: state.framework?.automaticPrioritisationEnabled ?? true,
      faultLatched: state.framework?.faultLatched ?? false,
      consecutiveOverLimitBatches: state.framework?.consecutiveOverLimitBatches ?? 0,
      overLimitConfirmationSeconds: state.framework?.overLimitConfirmationSeconds ?? 3,
      recoveryLimitWatts: toMeasurement(state.framework?.recoveryLimitWatts) ?? 0,
      shedOutletIds: state.framework?.shedOutletIds ?? [],
    },
  }
}

export async function setAutomaticPrioritisationEnabled(enabled: boolean): Promise<{ enabled: boolean }> {
  return request<{ enabled: boolean }>('/Dashboard/shedding/override', {
    method: 'POST',
    body: JSON.stringify({ enabled, reason: 'Changed from Threshold settings' }),
  })
}

export type PolicyItem = {
  id: string
  name: string
  condition: string
  action: string
  /** Superseded POL-xx code, when the rule has one. */
  legacyCode: string | null
  ruleFamily: string
  precedence: number
  enabled: boolean
}

type BackendPolicy = {
  id: number
  code: string
  name: string
  condition: string
  action: string
  legacyCode: string | null
  ruleFamily: string
  precedence: number
  enabled: boolean
}

export async function fetchPolicies(): Promise<PolicyItem[]> {
  const policies = await request<BackendPolicy[]>('/Dashboard/policies')
  return policies.map((policy) => ({
    id: policy.code,
    name: policy.name,
    condition: policy.condition,
    action: policy.action,
    legacyCode: policy.legacyCode,
    ruleFamily: policy.ruleFamily,
    precedence: policy.precedence,
    enabled: policy.enabled,
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
    name?: string
    priority?: Priority
    allowanceWatts?: number
    isProtected?: boolean
    schedule?: string
    idleLimitMinutes?: number
    clearIdleLimit?: boolean
  },
): Promise<void> {
  await request(`/Dashboard/outlets/${id}/policy`, {
    method: 'PUT',
    body: JSON.stringify({
      ...input,
      // outletId MUST be in the body as well as the URL. The endpoint rejects
      // the request with 400 when the two disagree
      // (Dashboard.cs: `if (id != command.OutletId)`), and OutletId is a
      // non-nullable int, so an absent field binds to 0 and EVERY save fails.
      outletId: id,
      // Numeric, not the display string. See priorityValues above.
      ...(input.priority !== undefined ? { priority: priorityValues[input.priority] } : {}),
    }),
  })
}

export async function activateOutlet(id: number): Promise<void> {
  await request(`/Dashboard/outlets/${id}/activation`, { method: 'POST' })
}

export async function clearOutletRecovery(id: number): Promise<void> {
  await request(`/Dashboard/outlets/${id}/clear-recovery`, { method: 'POST' })
}

export async function acknowledgeOutletFault(id: number): Promise<void> {
  await request(`/Dashboard/outlets/${id}/acknowledge-fault`, { method: 'POST' })
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

// Testing rig: four 220V CT outlets plus one USB/DC row measured by INA226.
const ALL_CHANNELS = 4

// `channels` is omitted when nothing is filtered, so the server returns all.
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
