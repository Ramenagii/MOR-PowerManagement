import type { EventLog, Outlet, Priority } from '../types/dashboard'

// Testing rig values (MUST_READ.md, valid until 31 Oct 2026):
// 2x220V outlets, P_limit capped at 600 W.
//
// FUTURE 4+USB: uncomment the extra baseOutlets entries below and set
// RIG_CHANNEL_COUNT 5. The thresholds are NOT constants here any more: they are
// configuration read from GET /Dashboard/state and edited through the Framework
// admin, so the 2-outlet rig reads 600/480/600 and the full bench reads whatever
// the operator saved (1200/960/1200). A copy of those numbers kept in the client
// was a measurement the server never made.
//
// The seeded rig values themselves live in ApplicationDbContextInitialiser.cs —
// change them together or the live dashboard will disagree with this roster.
export const RIG_CHANNEL_COUNT = 2

/**
 * Pre-first-response roster SHAPE. Not a measurement, not a simulation.
 *
 * This exists so the dashboard has something to lay out on the very first frame
 * and so the channel types stay exercised. Every field that could be read as a
 * reading is therefore zero and every relay is `Disconnected`:
 *
 *   - watts 0    — nothing has been metered. 260/180 W used to sit here, which
 *                  the hero summed into a confident 440 W before the backend had
 *                  answered a single request.
 *   - volts 0    — an UNRATED channel, not a 220 V rail that happens to read
 *                  zero. A rail is configuration; inventing one is not allowed.
 *   - Disconnected — no relay state has been reported, so none is claimed.
 *
 * GET /Dashboard/state replaces this array wholesale on the first successful
 * poll, so nothing here survives into a live frame.
 */
export const baseOutlets: Outlet[] = [
  {
    id: 1,
    name: 'Outlet 1',
    role: 'Instructor workstation',
    meter: 'PZEM-01 - mains bus',
    relay: 'Relay CH1',
    priority: 'Critical',
    allowance: 300,
    volts: 0,
    watts: 0,
    status: 'Disconnected',
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
    volts: 0,
    watts: 0,
    status: 'Disconnected',
    schedule: '08:00-18:00',
    idleLimit: '20 min',
  },
  // FUTURE 4+USB: uncomment the three entries below to restore the full bench,
  // then set RIG_CHANNEL_COUNT 5 above. They stay zeroed and Disconnected for the
  // same reason the wired entries are: shape, not measurement.
  // {
  //   id: 3,
  //   name: 'Outlet 3',
  //   role: 'Lab instrument',
  //   meter: 'PZEM-01 - mains bus',
  //   relay: 'Relay CH3',
  //   priority: 'High',
  //   allowance: 300,
  //   volts: 0,
  //   watts: 0,
  //   status: 'Disconnected',
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
  //   volts: 0,
  //   watts: 0,
  //   status: 'Disconnected',
  //   schedule: 'Class hours',
  //   idleLimit: '15 min',
  // },
  // {
  //   id: 5,
  //   name: 'USB 1',
  //   role: 'USB charging 5V',
  //   // Unmetered branch: the single mains INA226 covers CH1-CH4 only, so the USB
  //   // rail reports its nominal rating and counts toward P_total.
  //   meter: 'Not metered - nominal only',
  //   relay: 'Relay CH5',
  //   priority: 'Low',
  //   allowance: 10,
  //   volts: 5,
  //   watts: 0,
  //   status: 'Disconnected',
  //   schedule: 'Class hours',
  //   idleLimit: 'Exempt',
  // },
]

/**
 * No pre-seeded events.
 *
 * The two rows this used to hold ("Dashboard synchronized", "Normal operating
 * state — total load is below the 480 W warning threshold") were sentences the
 * browser wrote about numbers it had made up, and the second one was a health
 * verdict derived from static data. A policy log that starts with invented
 * entries cannot be distinguished from a real one at a glance, which is the one
 * job an event log has. The dashboard and the event panel both render an
 * explicit "no events yet" state instead.
 */
export const initialEvents: EventLog[] = []

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

// ---------------------------------------------------------------------------
// Framework tier defaults
// ---------------------------------------------------------------------------

/*
 * The system ceiling and its trip points are NOT duplicated here any more.
 *
 * SYSTEM_LIMIT_WATTS / SYSTEM_WARNING_WATTS / SYSTEM_CRITICAL_WATTS /
 * CH2_ALLOCATION_WATTS used to sit in this file as a client-side copy of the
 * framework configuration, and they were worse than unused: when
 * GET /Dashboard/state omitted a threshold, api.ts substituted them, so the
 * console rendered a 600 W ceiling and a 480 W warning that the server had
 * never confirmed — and drew warning and trip lines at wattages the engine was
 * not actually enforcing.
 *
 * Thresholds are configuration and configuration is read from the server:
 * `state.thresholds` drives the hero, the meter and the Framework admin editor,
 * and the admin is the only thing that writes them back. A rig whose server
 * answers has real thresholds here; a rig whose server does not answer has none,
 * and the console says so instead of guessing 600.
 */

/**
 * Tier each branch carries on the current bench, by outlet id.
 *
 * CH1 is Critical because it runs the instructor workstation: if it drops, the
 * class stops. CH2 is Important — demo equipment can be interrupted without
 * ending the session, but it should not be the first thing shed.
 *
 * FUTURE 4+USB: CH3 and CH4 appear here as planned assignments only. They are
 * listed so the Framework admin can show what the full bench is being built
 * toward, and they are rendered as DISABLED rows because the 2-outlet rig does
 * not wire them. When CH3-CH5 are added to the backend roster they arrive from
 * GET /Dashboard/state with their own stored priority and this table stops being
 * the source of truth for them — at which point delete the entries below.
 */
export const TIER_PLAN: Record<number, 'Critical' | 'Important' | 'Deferrable' | 'Nonessential'> = {
  1: 'Critical',
  2: 'Important',
  3: 'Deferrable',
  4: 'Nonessential',
}

/**
 * Branches the full bench is being built toward but the current rig does not
 * wire. Shown as disabled placeholders only — never as editable rows, because a
 * control that cannot write must not look writable.
 *
 * FUTURE 4+USB: delete this list once those ids appear in the live roster.
 */
export const UNWIRED_TIER_CHANNELS: Array<{ id: number; tier: 'Deferrable' | 'Nonessential'; volts: number }> = [
  { id: 3, tier: 'Deferrable', volts: 220 },
  { id: 4, tier: 'Nonessential', volts: 220 },
]

/**
 * Every explanation the dashboard used to print as a paragraph now lives here
 * and reaches the operator through a title attribute instead. The rule: a panel
 * is read from across a room, so it may state numbers, but prose has to be
 * asked for.
 *
 * Note what no string in here names any more: a wattage. `pLimit` and `bands`
 * used to quote 600 W and 480 W as if the console knew the rig's trip points. It
 * does not — it reads them from GET /Dashboard/state, and a rig whose server has
 * not answered has none. Tooltips that assert a threshold the client is guessing
 * are how a default becomes a specification in someone's head.
 */
export const DASHBOARD_TIPS = {
  total: 'Sum of every channel the policy engine currently reports as energized. Polled from GET /api/Dashboard/state.',
  headroom: 'Margin between the live total and the critical threshold the server reports. Read as a dash until that threshold has been read.',
  energized: 'Relays the policy engine currently reports as closed, over the wired channel count on this bench.',
  pLimit: 'Configured master capacity as returned by GET /api/Dashboard/state. It is a setting, not a reading, and it is never assumed.',
  rail:
    'The rail keeps a fixed 0-P_limit domain so the load looks the same size every minute and movement stays comparable. Columns are recorded buckets from the 15 min window; the bright marker is the live state reading, which is fresher than the newest column.',
  bands:
    'The warning and critical trip points the server returns. FR-05 warns at the former and FR-06 sheds at the latter; amber and red are reserved for those two bands and nothing else.',
  live:
    'Live state, polled from GET /api/Dashboard/state. Outlets post telemetry at 1 Hz; the freshness shown is the age of the newest stored sample.',
  ina226:
    'Bus volts, current and power read straight off the INA226 on the common mains feed. The shunt figure is the millivolts across its 100 mV shunt, which is what the current reading is actually made of. Past 30 s the sample is treated as unmeasured.',
  outlet:
    'Branch current comes from an ADS1220 SPI front end on a CT clamped to this branch. The volts shown is the live INA226 mains reading and the amps are derived from it; with no fresh bus volts the pair reads 0 rather than falling back to the rated rail.',
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
      'Drives every live channel to 82% of its draw, so the rig approaches the warning band the server has configured before the next activation attempt.',
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