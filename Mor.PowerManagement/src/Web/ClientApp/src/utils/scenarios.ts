import type { RelayStateInput, TelemetrySampleInput } from '../api'
import { isMonitoredOnlyChannel } from '../data/dashboard'
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

/**
 * Channels that carry a relay, in roster order. This is what the activation
 * stagger counts: CH5 is not one of them, so it is neither staggered in as a
 * newly activated branch nor ever named as a switchable one.
 */
const SWITCHABLE_CHANNEL_COUNT = 4

/**
 * Channel that carries the POL-04 overload injection. CH1 exists on this rig
 * and on every rig it grew into, so one value covers the whole demo.
 *
 * Retarget if CH1 becomes critical infra — pick a branch the engine is allowed
 * to shed, and keep the value 1 otherwise. `buildScenarioPayload` drops the
 * injection if this is ever pointed at a monitored-only channel rather than
 * posting 900 W into a socket that cannot be shed.
 */
const OVERLOAD_CHANNEL = 1

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
 * The rig has ONE INA226 on the common mains feed, so volts and amps are derived,
 * never independently metered. For a channel we know the draw (P) and the rail
 * (V), so I = P / V. For a 5 V USB rail that yields a large current, which is
 * the honest consequence of the derivation rather than a plausible-looking
 * number picked to look right.
 *
 * An unrated channel (rated 0 — the pre-first-response roster, or a server row
 * that never carried a rating) sends 0 V and 0 A. The old fallback substituted
 * 220 V for it, which would have posted a mains rail for a channel the console
 * had just admitted it knows nothing about — and the server stores whatever is
 * posted, so the fiction would outlive the request that carried it.
 */
function electrical(watts: number, ratedVolts: number): Pick<TelemetrySampleInput, 'voltage' | 'currentAmps'> {
  const voltage = ratedVolts > 0 ? ratedVolts : 0
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

  // A monitored-only channel has no relay to open, so it can never be the target
  // of an injection. Resolved once here rather than trusted from the profile, so
  // a retargeted OVERLOAD_CHANNEL fails by posting nothing instead of posting
  // 900 W onto a 5 V socket. Outlet ids are 1-based, so -1 cannot collide.
  const overloadChannel = isMonitoredOnlyChannel(profile.overloadChannel) ? -1 : profile.overloadChannel

  outlets.forEach((outlet, index) => {
    // CH5 is monitored, not switched. Its relay report is pinned closed whatever
    // a profile asks for, because the firmware pins it too: a batch that claimed
    // the USB socket open would teach the server that a branch with no relay can
    // be cut, and the next shed decision would be made on that fiction.
    const monitorOnly = isMonitoredOnlyChannel(outlet.id)
    const energizeable = !monitorOnly && !profile.shed.includes(outlet.id)

    // Stagger activation so each new channel is not switched on at the exact
    // same instant; this keeps the trace readable without faking the totals.
    // Counts the four mains branches, so the stagger widens with the bench
    // instead of staying a two-channel courtesy on a five-channel rig. A branch
    // inside the window is replayed as live whatever the roster last reported —
    // that is what a baseline batch means — and it posts its own draw, so one the
    // roster had open comes back closed at 0 W rather than pretending to load.
    const isEnergized =
      monitorOnly ||
      (energizeable && (index < SWITCHABLE_CHANNEL_COUNT || profile.energize.includes(outlet.id)))

    let watts = 0
    if (isEnergized) {
      watts = outlet.watts * profile.loadFactor
      if (outlet.id === overloadChannel) watts += profile.overloadWatts
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
    overloadChannel: OVERLOAD_CHANNEL,
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
    overloadChannel: OVERLOAD_CHANNEL,
  }
}

/**
 * Post-activation overload (POL-04): push the measured total past the critical
 * threshold on one channel. The server sees P_total > P_limit and sheds for
 * real; nothing here decides the outcome.
 */
export function overloadProfile(outlets: Outlet[]): ScenarioProfile {
  const overloadChannel = OVERLOAD_CHANNEL
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
 *
 * Monitored-only channels are filtered out first. CH5 is Low — the lowest rank
 * on the bench — so without that filter it would be picked every time and the
 * "shed" it received would be a relay report the hardware cannot make, leaving
 * the mains branches drawing exactly what they drew before.
 *
 * `count` stays 1 on purpose: it is safe on this bench and on the wider one, and
 * shedding one branch at a time is what the framework's stagger expects.
 */
export function selectiveProfile(outlets: Outlet[], count = 1): ScenarioProfile {
  const candidates = outlets
    .filter(
      (outlet) =>
        !isMonitoredOnlyChannel(outlet.id) &&
        (outlet.status === 'Active' || outlet.status === 'Standby'),
    )
    .sort((a, b) => priorityRankFor(a.priority) - priorityRankFor(b.priority))
    .slice(0, count)
    .map((outlet) => outlet.id)

  return {
    loadFactor: 1,
    energize: [],
    shed: candidates,
    overloadWatts: 0,
    overloadChannel: OVERLOAD_CHANNEL,
  }
}

/**
 * Standby/idle shutdown (POL-08): report the idle channels at near-zero draw
 * so the server's idle timer sees a genuine low-load period. The timer still
 * runs on the server's own clock; this only supplies the readings it reads.
 *
 * CH5 is excluded from the shed list for the same reason as in the selective
 * profile, and it still reports its own reduced draw: the socket has no switch,
 * so the honest simulation of an idle period is a rail that draws a little, not
 * one that has been cut.
 */
export function idleProfile(outlets: Outlet[]): ScenarioProfile {
  return {
    loadFactor: 0.05,
    energize: [],
    shed: outlets
      .filter(
        (outlet) =>
          !isMonitoredOnlyChannel(outlet.id) &&
          (outlet.status === 'Standby' || outlet.watts <= 80),
      )
      .map((outlet) => outlet.id),
    overloadWatts: 0,
    overloadChannel: OVERLOAD_CHANNEL,
  }
}

function priorityRankFor(priority: Priority): number {
  if (HIGH_PRIORITY.includes(priority)) return 10
  return { Low: 1, Medium: 2, High: 3, Critical: 4 }[priority] ?? 0
}