export type Priority = 'Critical' | 'High' | 'Medium' | 'Low'

export type OutletStatus = 'Active' | 'Standby' | 'Restricted' | 'Disconnected'

export type Severity = 'info' | 'success' | 'warning' | 'critical'

export type AppView = 'dashboard' | 'policies' | 'hardware' | 'telemetry' | 'channels' | 'admin'

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
  schedule: string
  idleLimit: string
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
}
