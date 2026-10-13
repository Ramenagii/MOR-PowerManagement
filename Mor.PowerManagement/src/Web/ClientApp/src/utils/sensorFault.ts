import type { EventLog } from '../types/dashboard'

/**
 * Sensor-fault detection.
 *
 * WHY THIS FILE EXISTS
 *
 * The rig is flashed and posting, and both metering sensors are currently
 * absent from the I2C bus. The device latches `S_fault`, the backend writes a
 * `POL-01 Hardware fault isolation` event, and every channel reports exactly
 * 0 W on every bucket. `GET /Dashboard/state` then returns `state: 0` —
 * *Normal* — because a total of 0 W is below the warning threshold.
 *
 * So the three facts the console can actually prove are in direct conflict:
 *
 *     the device is online, the device is in fault, and the load is 0 W.
 *
 * "Load is 0 W" is the only one of the three that is a measurement, and it is
 * exactly the one that is not trustworthy while the fault is latched. Rendered
 * naively — five cards reading `0.0 W · Measured` under a green "System
 * Normal" pill — the console tells an operator the rig is idle when in fact it
 * is blind. That is the single most damaging failure this interface can have,
 * and it is why the fault is detected here, once, from the backend's own
 * record, rather than inferred per card.
 *
 * WHAT THIS FILE WILL AND WILL NOT CLAIM
 *
 * It claims only what the API proves:
 *   - a critical hardware-fault isolation event exists, and when            (event log)
 *   - the device is still posting                                          (deviceOnline)
 *   - how many channels are on the rig                                     (roster)
 *
 * It does NOT claim which sensor is missing. "ADS1015 and INA226 are absent
 * from the bus" is true of the bench right now, but nothing in the API says
 * so, and a console that asserts it would be inventing a diagnosis from a
 * symptom. The fault rail therefore states the fault and points at the check
 * rather than performing it.
 */

/** The three states a channel's figures can be in, rig-wide. */
export type SensorFaultState = 'ok' | 'faulted' | 'stale'

export type SensorFault = {
  state: SensorFaultState
  /** The backend's own event title. Rendered verbatim, never paraphrased. */
  title: string
  /** The backend's own event detail, verbatim. */
  detail: string
  /** ISO stamp of the fault event, or null if the record carried none. */
  at: string | null
  /** Age of the fault event in whole minutes; null when unparseable. */
  minutesAgo: number | null
  /** The device is still posting on the bus. */
  devicePosting: boolean
  /** Channels on the roster — the blast radius, counted not guessed. */
  channelsAffected: number
  /**
   * True when the newest such event is old enough that the console should stop
   * speaking in the present tense about it. A latch is only cleared by an
   * event this API does not write, so an old fault with no newer record is
   * reported as "not cleared in the record", not as "just happened".
   */
  historical: boolean
}

/** Older than this and the wording shifts from "is faulted" to "was faulted". */
const HISTORICAL_AFTER_MINUTES = 60

/**
 * Matches the fault event by its own wording. Deliberately loose: the event is
 * written by the policy engine, not by this UI, so the title and the detail
 * are both scanned and POL-01 is named explicitly. Over-matching here would
 * be a real risk if other critical events existed, so the severity requirement
 * does the narrowing.
 */
const FAULT_PATTERN = /hardware fault|s[_ -]?fault|\bPOL-01\b/i

type DetectInput = {
  events: EventLog[]
  deviceOnline: boolean
  channelCount: number
  now: number
}

/**
 * The rig-wide sensor fault, or `null` when the record shows none.
 *
 * Null means "the event log contains no hardware-fault isolation", which is a
 * weaker statement than "the sensors are healthy" and is not upgraded to one.
 */
export function detectSensorFault({
  events,
  deviceOnline,
  channelCount,
  now,
}: DetectInput): SensorFault | null {
  const faultEvent = events.find(
    (event) => event.severity === 'critical' && FAULT_PATTERN.test(`${event.title} ${event.detail}`),
  )
  if (!faultEvent) return null

  const parsed = faultEvent.at ? Date.parse(faultEvent.at) : Number.NaN
  const minutesAgo = Number.isFinite(parsed) ? Math.max(0, Math.round((now - parsed) / 60_000)) : null

  return {
    state: minutesAgo !== null && minutesAgo > HISTORICAL_AFTER_MINUTES ? 'stale' : 'faulted',
    title: faultEvent.title,
    detail: faultEvent.detail,
    at: Number.isFinite(parsed) ? faultEvent.at ?? null : null,
    minutesAgo,
    devicePosting: deviceOnline,
    channelsAffected: channelCount,
    historical: minutesAgo !== null && minutesAgo > HISTORICAL_AFTER_MINUTES,
  }
}

/**
 * Whether a channel's figures can be attributed, given the rig-wide state.
 *
 * This is the override, and it is deliberately narrow. A channel the API
 * reports as `Measured` is only downgraded when the device has latched a
 * hardware fault — the one condition under which a sensed channel can post a
 * confident-looking zero. Nothing else in the provenance vocabulary is
 * touched, so a fault never becomes a licence to relabel everything.
 */
export function isReadingSuppressed(fault: SensorFault | null): boolean {
  return fault !== null
}

/**
 * What the figure should be CALLED, in the user's own terms.
 *
 * "No reading" and "0.0 W" are different claims and the difference is the whole
 * point of this file: one is an absence, the other is a measurement.
 */
export function suppressedReadoutLabel(): string {
  return 'No reading'
}

/**
 * One sentence naming the consequence, used wherever a number has been
 * suppressed. Kept here so the dashboard, the inventory and the telemetry view
 * cannot drift into three different excuses for the same missing data.
 */
export function faultConsequence(fault: SensorFault): string {
  const channels = fault.channelsAffected
  const plural = channels === 1 ? 'channel' : 'channels'
  return `Zero watts on every ${channels} ${plural} is not an idle rig. While the fault is latched the device is not reading the metering sensors, so these figures are shown as no reading rather than as a measured zero.`
}