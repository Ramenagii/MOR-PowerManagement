import type { RelayStateInput, TelemetrySampleInput } from '../api'
import type { Outlet, Priority } from '../types/dashboard'

/**
 * Scenario payload builders for the defense demo.
 *
 * Why this module exists: the scenario buttons used to mutate React state and
 * hand-write an event string. The screen then looked like the system had shed
 * load when nothing had been stored, and the Telemetry charts did not move
 * because they read Postgres. Every builder here instead returns a payload for
 * POST /api/Device/telemetry, so the server persists real rows and the policy
 * engine raises the event itself.
 *
 * Pure functions on purpose: they are unit-tested directly, which is the only
 * way to assert the arithmetic without a running device.
 */

/** Outlets at or above this are treated as candidates for shedding. */
const HIGH_PRIORITY: Priority[] = ['High', 'Critical']

export type ScenarioProfile = {
  /** Multiplier applied to each outlet's current draw. */
  loadFactor: number
  /** Outlet ids to energize that are currently disconnected. */
  energize: number[]
  /** Outlet ids to de-energize. */
  shed: number[]
  /** Extra watts to inject on the nominated channel. */
  overloadWatts: number
  /** Channel that carries the injected overload. */
  overloadChannel: number
}

/**
 * Per-channel electrical model.
 *
 * The rig has ONE PZEM on the common mains feed, so volts and amps are derived,
 * never independently metered. For a channel we know the draw (P) and the rail
 * (V), so I = P / V. For a 5 V USB rail that yields a large current, which is
 * the honest consequence of the derivation rather than a plausible-looking
 * number picked to look right.
 */
function electrical(watts: number, ratedVolts: number): Pick<TelemetrySampleInput, 'voltage' | 'currentAmps'> {
  const voltage = ratedVolts > 0 ? ratedVolts : 220
  return {
    voltage,
    // Guard the divide: a zero-rail channel would otherwise produce NaN, which
    // fails the server's InclusiveBetween(0, 100) validation.
    currentAmps: voltage > 0 ? Math.min(watts / voltage, 100) : 0,
  }
}

/** Energy is a monotonic counter on the device; advance it with the draw. */
function energyKwhFor(watts: number, stepHours: number): number {
  return Number(((watts / 1000) * stepHours).toFixed(6))
}

/**
 * Build the readings and relay reports for one profile.
 *
 * `stepHours` is how much simulated time the batch represents. It only feeds
 * the energy counter, which is cumulative on the device and not used for the
 * wattage the policy engine evaluates.
 */
export function buildScenarioPayload(
  outlets: Outlet[],
  profile: ScenarioProfile,
  stepHours = 0.000_277_778, // one second, the device's normal post interval
): { readings: TelemetrySampleInput[]; relayStates: RelayStateInput[] } {
  const readings: TelemetrySampleInput[] = []
  const relayStates: RelayStateInput[] = []

  outlets.forEach((outlet, index) => {
    const energized = !profile.shed.includes(outlet.id)

    // Stagger activation so each new channel is not switched on at the exact
    // same instant; this keeps the trace readable without faking the totals.
    const isEnergized = energized && (index < 5 || profile.energize.includes(outlet.id))

    let watts = 0
    if (isEnergized) {
      watts = outlet.watts * profile.loadFactor
      if (outlet.id === profile.overloadChannel) watts += profile.overloadWatts
    }

    // Clamp to the server's accepted range (InclusiveBetween(0, 5000)) so an
    // aggressive profile is rejected by our own bound rather than by a 400.
    const powerWatts = Math.max(0, Math.min(Math.round(watts), 5000))

    readings.push({
      outletId: outlet.id,
      ...electrical(powerWatts, outlet.volts),
      powerWatts,
      energyKwh: energyKwhFor(powerWatts, stepHours),
    })

    relayStates.push({ outletId: outlet.id, relayClosed: isEnergized })
  })

  return { readings, relayStates }
}

/** Normal operation: a steady baseline with every channel at its rated draw. */
export function normalProfile(outlets: Outlet[]): ScenarioProfile {
  return {
    loadFactor: 1,
    energize: outlets.filter((o) => o.status === 'Active' || o.status === 'Standby').map((o) => o.id),
    shed: [],
    overloadWatts: 0,
    overloadChannel: 6,
  }
}

/**
 * Pre-activation restriction (POL-03): drive the rig to the warning band and
 * add one more channel, so the next activation request is genuinely denied.
 */
export function capacityBlockProfile(outlets: Outlet[]): ScenarioProfile {
  return {
    loadFactor: 0.82,
    energize: outlets.filter((o) => o.status !== 'Disconnected').map((o) => o.id),
    shed: [],
    overloadWatts: 0,
    overloadChannel: 6,
  }
}

/**
 * Post-activation overload (POL-04): push the measured total past the critical
 * threshold on one channel. The server sees P_total > P_limit and sheds for
 * real; nothing here decides the outcome.
 */
export function overloadProfile(outlets: Outlet[]): ScenarioProfile {
  const overloadChannel = 6
  return {
    loadFactor: 1.05,
    // The overload channel MUST be energized or the injected watts are silently
    // dropped: buildScenarioPayload zeroes any channel outside this list, so a
    // Disconnected overload channel would leave the rig exactly where it was.
    energize: [
      ...outlets.filter((o) => o.status !== 'Disconnected').map((o) => o.id),
      overloadChannel,
    ],
    shed: [],
    overloadWatts: 900,
    overloadChannel,
  }
}

/**
 * Selective response (POL-05): shed the lowest-priority energized channels.
 * Ordering uses the same Low -> Critical rank the policies use.
 */
export function selectiveProfile(outlets: Outlet[], count = 2): ScenarioProfile {
  const candidates = outlets
    .filter((outlet) => outlet.status === 'Active' || outlet.status === 'Standby')
    .sort((a, b) => priorityRankFor(a.priority) - priorityRankFor(b.priority))
    .slice(0, count)
    .map((outlet) => outlet.id)

  return {
    loadFactor: 1,
    energize: [],
    shed: candidates,
    overloadWatts: 0,
    overloadChannel: 6,
  }
}

/**
 * Standby/idle shutdown (POL-08): report the idle channels at near-zero draw
 * so the server's idle timer sees a genuine low-load period. The timer still
 * runs on the server's own clock; this only supplies the readings it reads.
 */
export function idleProfile(outlets: Outlet[]): ScenarioProfile {
  return {
    loadFactor: 0.05,
    energize: [],
    shed: outlets
      .filter((outlet) => outlet.status === 'Standby' || outlet.watts <= 80)
      .map((outlet) => outlet.id),
    overloadWatts: 0,
    overloadChannel: 6,
  }
}

function priorityRankFor(priority: Priority): number {
  if (HIGH_PRIORITY.includes(priority)) return 10
  return { Low: 1, Medium: 2, High: 3, Critical: 4 }[priority] ?? 0
}