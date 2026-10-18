export type Priority = 'Critical' | 'High' | 'Medium' | 'Low'

/**
 * The relay state, as the server actually sends it.
 *
 * `Domain/Enums/OutletStatus.cs` is `{ Active, Standby, Restricted, Disconnected }`
 * and is serialized as its ordinal, so this union is a transcription of that
 * file, not a set of states the console wishes the rig had. Do not add a
 * member here without adding it to the enum — `toStatus` in api.ts indexes this
 * array by the wire value, so an extra member here would silently renumber the
 * ones after it.
 *
 * What each one means on the bench, since the names do not say it:
 *
 *   Active        relay closed, branch above the standby threshold
 *   Standby       relay closed, branch below it — still energized
 *   Disconnected  relay open. ALSO what a firmware trip and a policy shed look
 *                 like: `DisconnectOutlet` and every shed path write this one
 *                 value, and nothing on the wire separates them.
 *   Restricted    a LATCH. POL-01 fault isolation, or a denied activation. The
 *                 server ignores relay reports for a restricted outlet, so it
 *                 does not clear on the switch.
 *
 * The reference sketch's own three words — TRIPPED / ACTIVE / STANDBY — do NOT
 * map one-to-one onto these four, and the gap is the interesting part. See
 * `relayChip` in utils/dashboard for the mapping and for why there is no TRIPPED
 * chip on the row.
 */
export type OutletStatus = 'Active' | 'Standby' | 'Restricted' | 'Disconnected'

export type Severity = 'info' | 'success' | 'warning' | 'critical'

export type AppView = 'dashboard' | 'policies' | 'hardware' | 'telemetry' | 'admin'

export type Outlet = {
  id: number
  name: string
  role: string
  meter: string
  relay: string
  priority: Priority
  allowance: number
  volts: number
  watts: number
  status: OutletStatus
  /** Time of the outlet's last device telemetry report. Null means never reported. */
  lastSeen?: string | null
  schedule: string
  idleLimit: string
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

export type EventLog = {
  id: number
  /** Display clock, already localised for reading. */
  time: string
  /**
   * The event's own ISO stamp, kept alongside the display clock.
   *
   * `time` alone cannot answer "how old is this?", and the sensor-fault rail
   * has to: a latched fault and a fault from four hours ago are the same
   * record and two different sentences. Optional because locally raised events
   * (the offline fallback path) have no server timestamp to carry.
   */
  at?: string
  title: string
  detail: string
  severity: Severity
  actor?: string | null
}
