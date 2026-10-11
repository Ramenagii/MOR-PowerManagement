import type { EventLog, Outlet, Priority } from '../types/dashboard'

// Testing rig values (MUST_READ.md, valid until 31 Oct 2026):
// 4x220V outlets + 1xUSB 5V, P_limit capped at 1200 W.
export const MAX_CAPACITY = 1200
export const WARNING_THRESHOLD = 960
export const CRITICAL_THRESHOLD = 1200

/** Channel count on the test bench; only CH1-CH5 are physically wired. */
export const RIG_CHANNEL_COUNT = 5

export const baseOutlets: Outlet[] = [
  {
    id: 1,
    name: 'Outlet 1',
    role: 'Instructor workstation',
    meter: 'PZEM-01 - mains bus',
    relay: 'Relay CH1',
    priority: 'Critical',
    allowance: 300,
    volts: 220,
    watts: 260,
    status: 'Active',
    schedule: 'Class hours + override',
    idleLimit: 'Exempt',
  },
  {
    id: 2,
    name: 'Outlet 2',
    role: 'Demo equipment',
    meter: 'PZEM-01 - mains bus',
    relay: 'Relay CH2',
    priority: 'High',
    allowance: 300,
    volts: 220,
    watts: 180,
    status: 'Active',
    schedule: '08:00-18:00',
    idleLimit: '20 min',
  },
  {
    id: 3,
    name: 'Outlet 3',
    role: 'Lab instrument',
    meter: 'PZEM-01 - mains bus',
    relay: 'Relay CH3',
    priority: 'High',
    allowance: 300,
    volts: 220,
    watts: 120,
    status: 'Active',
    schedule: '08:00-18:00',
    idleLimit: '20 min',
  },
  {
    id: 4,
    name: 'Outlet 4',
    role: 'Student workstation',
    meter: 'PZEM-01 - mains bus',
    relay: 'Relay CH4',
    priority: 'Medium',
    allowance: 300,
    volts: 220,
    watts: 0,
    status: 'Disconnected',
    schedule: 'Class hours',
    idleLimit: '15 min',
  },
  {
    id: 5,
    name: 'USB 1',
    role: 'USB charging 5V',
    meter: 'PZEM-01 - mains bus',
    relay: 'Relay CH5',
    priority: 'Low',
    allowance: 10,
    volts: 5,
    watts: 7,
    status: 'Standby',
    schedule: 'Class hours',
    idleLimit: 'Exempt',
  },
]

export const initialEvents: EventLog[] = [
  {
    id: 1,
    time: '09:00',
    title: 'Dashboard synchronized',
    detail:
      'Framework rules FR-01..FR-12 loaded for the testing rig: 4x220V outlets plus 1xUSB 5V on a single mains feed. USB counts toward P_total.',
    severity: 'info',
  },
  {
    id: 2,
    time: '09:01',
    title: 'Normal operating state',
    detail: 'Total load is below the 960 W warning threshold.',
    severity: 'success',
  },
]

export const priorityRank: Record<Priority, number> = {
  Critical: 4,
  High: 3,
  Medium: 2,
  Low: 1,
}
