import type { EventLog, Outlet, Priority } from '../types/dashboard'

// Testing rig values (MUST_READ.md, valid until 31 Oct 2026):
// 2x220V outlets, P_limit capped at 600 W.
//
// FUTURE 4+USB: uncomment the extra baseOutlets entries below, set
// RIG_CHANNEL_COUNT 5 and thresholds to 1200/960/1200 (max/warning/critical).
// The seeded rig values live in ApplicationDbContextInitialiser.cs — change
// them together or the live dashboard will disagree with this mock.
export const MAX_CAPACITY = 600
export const WARNING_THRESHOLD = 480
export const CRITICAL_THRESHOLD = 600

/** Channel count on the test bench; only CH1-CH2 are physically wired. */
export const RIG_CHANNEL_COUNT = 2

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
  // FUTURE 4+USB: uncomment the three entries below to restore the full bench,
  // then set RIG_CHANNEL_COUNT 5 and thresholds 1200/960/1200 above.
  // {
  //   id: 3,
  //   name: 'Outlet 3',
  //   role: 'Lab instrument',
  //   meter: 'PZEM-01 - mains bus',
  //   relay: 'Relay CH3',
  //   priority: 'High',
  //   allowance: 300,
  //   volts: 220,
  //   watts: 120,
  //   status: 'Active',
  //   schedule: '08:00-18:00',
  //   idleLimit: '20 min',
  // },
  // {
  //   id: 4,
  //   name: 'Outlet 4',
  //   role: 'Student workstation',
  //   meter: 'PZEM-01 - mains bus',
  //   relay: 'Relay CH4',
  //   priority: 'Medium',
  //   allowance: 300,
  //   volts: 220,
  //   watts: 0,
  //   status: 'Disconnected',
  //   schedule: 'Class hours',
  //   idleLimit: '15 min',
  // },
  // {
  //   id: 5,
  //   name: 'USB 1',
  //   role: 'USB charging 5V',
  //   // Unmetered branch: the single mains PZEM covers CH1-CH4 only, so the USB
  //   // rail reports its nominal rating and counts toward P_total.
  //   meter: 'Not metered - nominal only',
  //   relay: 'Relay CH5',
  //   priority: 'Low',
  //   allowance: 10,
  //   volts: 5,
  //   watts: 0,
  //   status: 'Standby',
  //   schedule: 'Class hours',
  //   idleLimit: 'Exempt',
  // },
]

export const initialEvents: EventLog[] = [
  {
    id: 1,
    time: '09:00',
    title: 'Dashboard synchronized',
    detail:
      'Framework rules FR-01..FR-12 loaded for the testing rig: 2x220V outlets (CH1-CH2) on a single mains feed, P_limit capped at 600 W.',
    severity: 'info',
  },
  {
    id: 2,
    time: '09:01',
    title: 'Normal operating state',
    detail: 'Total load is below the 480 W warning threshold.',
    severity: 'success',
  },
]

export const priorityRank: Record<Priority, number> = {
  Critical: 4,
  High: 3,
  Medium: 2,
  Low: 1,
}

// ---------------------------------------------------------------------------
// Relay GPIOs
// ---------------------------------------------------------------------------

/**
 * The ESP32 pin each relay driver sits on.
 *
 * This is a table and NOT arithmetic on the channel id, because the bench is
 * not wired in order: CH1 lands on GPIO2 and CH2 on GPIO1. GPIO1 was claimed
 * by the debug UART first, so the numbering runs backwards from the ids, and
 * an id-derived rule would swap the two and misreport which branch is live.
 *
 * "Closed" means the relay is passing current to the branch; "open" means the
 * branch is isolated. The API carries that as an OutletStatus, not as a pin
 * level, so the pin here names the wire and never claims to be a live reading.
 *
 * FUTURE 4+USB: add each branch's pin as it is wired. Do not derive it from the
 * channel id — the existing two entries are the proof that the order is not
 * sequential.
 */
export const RELAY_GPIO: Record<number, string> = {
  1: 'GPIO2',
  2: 'GPIO1',
}

export function relayGpio(outletId: number): string {
  return RELAY_GPIO[outletId] ?? '—'
}

// ---------------------------------------------------------------------------
// Load bands
// ---------------------------------------------------------------------------

/**
 * The three bands the console reserves colour for. Everything below the warning
 * threshold is a measurement, not a health verdict, so `normal` wears the
 * measurement blue rather than a green "all good" chip — green is not a state
 * colour in this rig.
 */
export type LoadBand = 'normal' | 'warning' | 'critical'

export function loadBand(watts: number, warning: number, critical: number): LoadBand {
  if (watts >= critical) return 'critical'
  if (watts >= warning) return 'warning'
  return 'normal'
}

/** Tailwind fill on the rail and on each history column. */
export const BAND_FILL: Record<LoadBand, string> = {
  normal: 'bg-primary',
  warning: 'bg-tertiary-container',
  critical: 'bg-error',
}

/** Ink for the hero figure and the numeric readouts when the rig sits in a band. */
export const BAND_INK: Record<LoadBand, string> = {
  normal: 'text-on-surface',
  warning: 'text-tertiary-container',
  critical: 'text-error',
}

/**
 * Status dot per band. `normal` is the neutral outline dot on purpose: an
 * energized rig is the ordinary case, and colouring it would make the default
 * state the loudest thing on screen.
 */
export const BAND_DOT: Record<LoadBand, string> = {
  normal: 'bg-outline-variant',
  warning: 'ant-dot-warning',
  critical: 'ant-dot-critical',
}

/** SVG stroke. Pinned to the same hexes the token layer uses. */
export const BAND_HEX: Record<LoadBand, string> = {
  normal: '#0059c2',
  warning: '#7d5400',
  critical: '#ba1a1a',
}

export const BAND_LABEL: Record<LoadBand, string> = {
  normal: 'NORMAL',
  warning: 'WARNING',
  critical: 'CRITICAL',
}

/** Framework rule that owns each trip point — FR-05 warns, FR-06 sheds. */
export const BAND_RULE: Record<Exclude<LoadBand, 'normal'>, string> = {
  warning: 'FR-05',
  critical: 'FR-06',
}

// ---------------------------------------------------------------------------
// Dashboard copy — moved out of the layout and into tooltips
// ---------------------------------------------------------------------------

/**
 * The single placeholder for "the backend has not told us this yet".
 *
 * An em dash, never a zero. `0 W` is a claim — it says the device measured the
 * branch and found nothing there — so it may only ever be rendered when the
 * firmware actually reported 0. While the dashboard is offline or pre-first-
 * response, every figure is this glyph instead.
 */
export const UNAVAILABLE = '—'

/**
 * Every explanation the dashboard used to print as a paragraph now lives here
 * and reaches the operator through a title attribute instead. The rule: a panel
 * is read from across a room, so it may state numbers, but prose has to be
 * asked for.
 */
export const DASHBOARD_TIPS = {
  total: 'Sum of every channel the policy engine currently reports as energized. Polled from GET /api/Dashboard/state.',
  headroom: 'Margin between the live total and the critical threshold. At 0 W the rig trips; the gap is the distance to that trip.',
  energized: 'Relays the policy engine currently reports as closed, over the wired channel count on this bench.',
  pLimit: 'Configured master capacity. The 600 W ceiling this rig is calibrated against; it is a setting, not a reading.',
  rail:
    'The rail keeps a fixed 0-P_limit domain so the load looks the same size every minute and movement stays comparable. Columns are recorded buckets from the 15 min window; the bright marker is the live state reading, which is fresher than the newest column.',
  bands:
    'Warning at 480 W (FR-05) raises an event; critical at 600 W (FR-06) sheds. Amber and red are reserved for these two bands and nothing else.',
  live:
    'Live state, polled from GET /api/Dashboard/state. Outlets post telemetry at 1 Hz; the freshness shown is the age of the newest stored sample.',
  outlet:
    'Branch current comes from an ADS1220 SPI front end on a CT clamped to this branch. Volts is the rated rail, not a live sample.',
  relay:
    'Closed passes current to the branch; open isolates it. The API reports this as an outlet status, not as a pin level.',
  amps:
    'Derived as P / V from the branch sample, assuming a power factor of 1. Not a direct CT current reading.',
  events: 'Policy-engine events, newest first.',
  offline:
    'GET /api/Dashboard/state did not answer. Nothing below is a live reading and the vector buttons write nothing until the session is restored.',
} as const

/** Idle copy for the vector rail, quoted verbatim in the reference console. */
export const VECTOR_IDLE =
  "No vector has been run. The result quotes the server's response verbatim: rows stored, total watts, and the rules the engine raised."

// ---------------------------------------------------------------------------
// SIM-01..06
// ---------------------------------------------------------------------------

/** Icon key, resolved to a Lucide component in DashboardSimRail.tsx. */
export type SimIconKey = 'nominal' | 'gate' | 'warn' | 'critical' | 'priority' | 'standby'

export type SimVector = {
  id: string
  icon: SimIconKey
  name: string
  /** What this vector physically does to the rig. Tooltip body. */
  intent: string
  /** The honest expectation — a claim about the engine, never a promised number. */
  expectation: string
  /** The endpoint this vector really hits. */
  endpoint: string
  /**
   * Only the vectors that actually drive the rig into a band the palette
   * reserves colour for carry a dot. Describing a mechanism is not a severity.
   */
  tone?: LoadBand
}

/**
 * The six prescribed defense-demo vectors. The intent/expectation prose is kept
 * verbatim from the original scenario panel; it now reaches the operator
 * through a tooltip on an icon-only button rather than as a card per vector.
 */
export const SIM_VECTORS: readonly SimVector[] = [
  {
    id: 'SIM-01',
    icon: 'nominal',
    name: 'Normal operation baseline',
    intent:
      'Replays every energized channel at the draw it is already reporting, with no injected watts and no shed channels.',
    expectation: 'The engine should store the batch and raise nothing, because no threshold is crossed.',
    endpoint: 'POST /api/Dashboard/scenarios/ingest',
  },
  {
    id: 'SIM-02',
    icon: 'gate',
    name: 'Activation request',
    intent:
      'Sends a real activation request for CH1 through the outlet activation route, with no telemetry batch.',
    expectation:
      'The backend admits or denies it from its own projected-load check. If it is denied, the reason comes back in the event log.',
    endpoint: 'POST /api/Dashboard/outlets/{id}/activation',
    tone: 'normal',
  },
  {
    id: 'SIM-03',
    icon: 'warn',
    name: 'Capacity block rehearsal',
    intent:
      'Drives every live channel to 82% of its draw, so the rig sits inside the 480 W warning band before the next activation attempt.',
    expectation:
      'A following activation request should be genuinely refused, because the load really is near the threshold.',
    endpoint: 'POST /api/Dashboard/scenarios/ingest',
    tone: 'warning',
  },
  {
    id: 'SIM-04',
    icon: 'critical',
    name: 'Post-activation overload',
    intent:
      'Takes every live channel to 105% of its draw and adds a 900 W injection on CH1, forcing the measured total past the critical threshold.',
    expectation:
      "The server sheds on its own terms. Which channels it drops, and what it reports as total watts, is the engine's answer — not this screen's.",
    endpoint: 'POST /api/Dashboard/scenarios/ingest',
    tone: 'critical',
  },
  {
    id: 'SIM-05',
    icon: 'priority',
    name: 'Selective response',
    intent:
      'Sheds the lowest-priority energized channel, ordered by the same Low → Critical rank the policy engine uses.',
    expectation: "Load drops by exactly the shed channel's contribution. The remainder stays energized.",
    endpoint: 'POST /api/Dashboard/scenarios/ingest',
  },
  {
    id: 'SIM-06',
    icon: 'standby',
    name: 'Idle timeout cutoff',
    intent:
      'Reports the low-draw channels at 5% of their draw and closes their relays, so the server\'s idle timer sees a genuine low-load period.',
    expectation:
      "The idle timer runs on the server's own clock. This vector supplies the readings it reads; it cannot shorten the wait.",
    endpoint: 'POST /api/Dashboard/scenarios/ingest',
  },
]