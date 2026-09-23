export type Priority = 'Critical' | 'High' | 'Medium' | 'Low'

export type OutletStatus = 'Active' | 'Standby' | 'Restricted' | 'Disconnected'

export type Severity = 'info' | 'success' | 'warning' | 'critical'

export type AppView = 'dashboard' | 'policies' | 'hardware'

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
  time: string
  title: string
  detail: string
  severity: Severity
}
