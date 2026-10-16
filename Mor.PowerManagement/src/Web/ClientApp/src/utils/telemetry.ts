/**
 * Pure helpers for the telemetry view. No DOM, no React — these are the parts
 * that carry the correctness guarantees (gap-vs-zero, bucket alignment, tick
 * density, staleness banding) and so they are unit-tested directly.
 */

export type Unit = 'V' | 'A' | 'W'

/**
 * Round a numeric domain outward to "nice" tick values (1 / 2 / 5 x 10^k).
 * Pads 8% on each side first so a trace never touches the plot edge.
 */
export function niceDomain(
  min: number,
  max: number,
  tickCount = 4,
): { min: number; max: number; step: number } {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: 1, step: 0.5 }
  }

  if (min === max) {
    // A flat line (e.g. a nominal 5 V rail) still needs a readable band.
    const pad = Math.abs(min) * 0.05 || 1
    min -= pad
    max += pad
  }

  const pad = (max - min) * 0.08
  min -= pad
  max += pad

  const rawStep = (max - min) / Math.max(1, tickCount)
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)))
  const normalized = rawStep / magnitude

  const niceNormalized = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  const step = niceNormalized * magnitude

  const niceMin = Math.floor(min / step) * step
  const niceMax = Math.ceil(max / step) * step

  return { min: niceMin, max: niceMax, step }
}

/** Round the tick values to the step's own precision so labels read "220" not "219.99999". */
export function roundToStep(value: number, step: number): number {
  if (step === 0) return value
  const decimals = Math.max(0, -Math.floor(Math.log10(step)))
  return Number(value.toFixed(decimals))
}

/** Evenly spread at most `target` indices across `count` slots, always including first and last. */
export function pickTickIndices(count: number, target: number): number[] {
  if (count <= 0) return []
  if (count === 1) return [0]
  if (target <= 2) return [0, count - 1]

  const wanted = Math.min(target, count)
  const indices = new Set<number>()

  for (let i = 0; i < wanted; i += 1) {
    indices.add(Math.round((i * (count - 1)) / (wanted - 1)))
  }

  return [...indices].sort((a, b) => a - b)
}

/** Axis label for a tick value, precision driven by the unit. */
export function formatTick(value: number, unit: Unit): string {
  const decimals = unit === 'V' ? 0 : unit === 'A' ? 2 : 0
  const rounded = value.toFixed(decimals)
  return unit === 'W' ? `${rounded} W` : unit === 'A' ? `${rounded} A` : `${rounded} V`
}

/** Compact tooltip/label value: no unit suffix, no trailing zeros beyond the unit's precision. */
export function formatValue(value: number, unit: Unit): string {
  const decimals = unit === 'V' ? 1 : unit === 'A' ? 2 : 1
  return value.toFixed(decimals)
}

/** "12 s ago" / "4 min ago" / "—" — drives the staleness label, which re-renders every second. */
export function formatRelative(fromIso: string | null, now: number): string {
  if (!fromIso) return '—'
  const then = Date.parse(fromIso)
  if (Number.isNaN(then)) return '—'

  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 60) return `${seconds} s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

/**
 * Three conditions the UI must keep distinguishable (§4.2): a live device, a
 * device that has gone quiet, and a device that has never reported at all.
 * `deviceOnline` folds in the "every channel has zero samples" case.
 */
export function stalenessState(
  latestSampleAt: string | null,
  now: number,
  deviceOnline: boolean,
): { tone: 'fresh' | 'delayed' | 'stale'; label: string } {
  if (!latestSampleAt) {
    return { tone: 'stale', label: 'No telemetry received yet' }
  }

  const parsed = Date.parse(latestSampleAt)
  if (Number.isNaN(parsed)) {
    return { tone: 'stale', label: 'No telemetry received yet' }
  }

  const ageSeconds = Math.max(0, (now - parsed) / 1000)

  if (ageSeconds < 20) {
    return { tone: 'fresh', label: `Live · ${formatRelative(latestSampleAt, now)}` }
  }

  // The dashboard's own ESP32-liveness signal (LastSeen within 30 s) is the
  // stronger claim: if it says the device is down, "delayed" is too generous.
  if (ageSeconds < 120 && deviceOnline) {
    return { tone: 'delayed', label: `Device delayed · ${formatRelative(latestSampleAt, now)}` }
  }

  return { tone: 'stale', label: `No telemetry since ${formatRelative(latestSampleAt, now)}` }
}

/**
 * How old an INA226 sample is allowed to be before the card stops calling it a
 * measurement.
 *
 * 30 s, and not 20 s like the telemetry stream: the INA226 sample rides on
 * GET /Dashboard/state, which is polled every 500 ms but is not what the device
 * samples on — the device writes its converter output on its own cadence, and a
 * 30 s window is where "this rig is answering" stops being true and starts being
 * "this rig answered, a while ago". `stalenessState` splits into three bands
 * because a trend chart can honestly draw a slow line; a single headline figure
 * cannot, so it gets a binary gate and a reason.
 */
export const INA226_STALE_SECONDS = 30

/**
 * Full-scale input of the INA226 shunt input, in millivolts.
 *
 * A DEVICE CONSTANT, not a reading — the same category as a rated rail, and for
 * the same reason it is allowed to be a constant: it is a property of how the
 * converter was CONFIGURED, not of the load on it. It is here so the shunt drop
 * can be drawn against the range the converter can actually resolve, which turns
 * a bare "3.21 mV" into a position on a scale.
 *
 * 75 mV: the firmware configures a 100 mOhm shunt for 0.75 A, staying within
 * the INA226's +/-81.9 mV shunt input range. The earlier 2 A setting requested
 * 200 mV and was rejected by the driver, which left current and power at zero.
 * This scale must match INA226_MAX_CURRENT_AMPS * INA226_SHUNT_OHM in firmware.
 */
export const INA226_SHUNT_FULL_SCALE_MV = 75

export type Ina226Freshness = 'live' | 'stale' | 'unmeasured'

export type Ina226Age = {
  freshness: Ina226Freshness
  ageSeconds: number | null
}

/**
 * Is the newest INA226 sample still a measurement?
 *
 * `unmeasured` and `stale` are separate answers because they demand different
 * operator action. No sample at all means the converter is not being read —
 * wiring, I2C, or the firmware never wrote a row. A stale sample means the rig
 * was answering and has stopped. Collapsing them into one "not live" flag would
 * make a loose bus lead and a stopped poller look identical.
 */
export function ina226Freshness(sampledAt: string | null | undefined, now: number): Ina226Age {
  if (!sampledAt) return { freshness: 'unmeasured', ageSeconds: null }

  const parsed = Date.parse(sampledAt)
  if (Number.isNaN(parsed)) return { freshness: 'unmeasured', ageSeconds: null }

  const ageSeconds = Math.max(0, (now - parsed) / 1000)
  return {
    freshness: ageSeconds < INA226_STALE_SECONDS ? 'live' : 'stale',
    ageSeconds,
  }
}

/** Clamped fill for the shunt rail. A reading above full scale is a fault, not a bar. */
export function shuntFillPercent(millivolts: number): number {
  if (!Number.isFinite(millivolts)) return 0
  return Math.min(Math.max((millivolts / INA226_SHUNT_FULL_SCALE_MV) * 100, 0), 100)
}

export type PowerReconciliation = {
  /** Bus volts x current: what the two primary figures imply. */
  computedWatts: number
  /** Computed minus reported. */
  deltaWatts: number
  /** |delta| as a percentage of the reported figure; 0 when both are zero. */
  deltaPercent: number
}

/**
 * Cross-check the INA226 against itself.
 *
 * The converter measures volts and shunt millivolts as separate conversions and
 * then multiplies them for its power channel, so V x I and the reported watts
 * are two answers to the same question and they are allowed to differ slightly.
 * Showing the gap is more useful than showing either number alone: a healthy
 * device sits within a fraction of a percent, and a reading that has drifted
 * away from its own product is a failing converter, which no single figure on
 * this card would reveal.
 */
export function reconcilePower(
  busVolts: number,
  currentAmps: number,
  powerWatts: number,
): PowerReconciliation {
  const computedWatts = busVolts * currentAmps
  const deltaWatts = computedWatts - powerWatts
  const deltaPercent = powerWatts !== 0 ? Math.abs((deltaWatts / powerWatts) * 100) : 0
  return { computedWatts, deltaWatts, deltaPercent }
}

/** Min / max / last / sum over a nullable series. Nulls are skipped, never coerced to 0. */
export function seriesStats(values: Array<number | null>): {
  min: number | null
  max: number | null
  last: number | null
  sum: number | null
} {
  let min: number | null = null
  let max: number | null = null
  let last: number | null = null
  let sum = 0
  let seen = false

  for (const value of values) {
    if (value === null || !Number.isFinite(value)) continue
    if (min === null || value < min) min = value
    if (max === null || value > max) max = value
    sum += value
    seen = true
    last = value
  }

  return { min, max, last, sum: seen ? sum : null }
}

/**
 * Full descriptive statistics over a nullable series, for the inventory stat strips
 * (min / mean / max / sigma). Same null discipline as seriesStats: a gap is skipped,
 * never coerced to 0, so an open relay does not drag the mean down.
 *
 * stddev is the sample standard deviation (n-1). With a single sample there is no
 * spread to report, so sigma is null rather than 0 — 0 would read as "perfectly
 * steady", which is a different claim from "not enough data".
 */
export function describeSeries(values: Array<number | null>): {
  count: number
  min: number | null
  max: number | null
  mean: number | null
  stddev: number | null
} {
  let min: number | null = null
  let max: number | null = null
  let sum = 0
  let count = 0

  for (const value of values) {
    if (value === null || !Number.isFinite(value)) continue
    if (min === null || value < min) min = value
    if (max === null || value > max) max = value
    sum += value
    count += 1
  }

  if (count === 0) return { count: 0, min: null, max: null, mean: null, stddev: null }

  const mean = sum / count
  if (count === 1) return { count, min, max, mean, stddev: null }

  // Two-pass variance (mean already known) rather than sum-of-squares, which loses
  // precision when the values sit far from zero — volts are the case that bites.
  let acc = 0
  for (const value of values) {
    if (value === null || !Number.isFinite(value)) continue
    const delta = value - mean
    acc += delta * delta
  }

  return { count, min, max, mean, stddev: Math.sqrt(acc / (count - 1)) }
}

/**
 * Bucket a nullable series into `binCount` equal-width bins for the load histogram.
 * Nulls are ignored (they are gaps, not zero-load samples). Returns bin lower edges
 * plus counts, so the caller can label an axis without re-deriving the scale.
 */
export function histogram(
  values: Array<number | null>,
  binCount = 12,
): { min: number; max: number; counts: number[] } | null {
  const present = values.filter((v): v is number => v !== null && Number.isFinite(v))
  if (present.length === 0) return null

  const min = Math.min(...present)
  const max = Math.max(...present)
  const bins = Math.max(1, Math.floor(binCount))

  // A flat series (a nominal 5 V rail) has no width to divide; everything lands in
  // the single bin rather than producing NaN edges.
  if (max === min) return { min, max, counts: [present.length] }

  const width = (max - min) / bins
  const counts = new Array<number>(bins).fill(0)

  for (const value of present) {
    // Clamp the last bin so a value exactly at max does not fall outside the array.
    const index = Math.min(bins - 1, Math.floor((value - min) / width))
    counts[index] += 1
  }

  return { min, max, counts }
}

/**
 * Split a nullable series into one path string per contiguous run of non-null
 * values. This is the correctness-critical helper: a skipped null terminates the
 * current run, so a relay-open period renders as a break in the line rather than
 * a straight line to zero. Never emits an L to a null.
 */
export function toPaths(
  values: Array<number | null>,
  x: (i: number) => number,
  y: (v: number) => number,
): Array<string> {
  const paths: string[] = []
  let current: string | null = null

  values.forEach((value, i) => {
    if (value === null || !Number.isFinite(value)) {
      if (current !== null) {
        paths.push(current)
        current = null
      }
      return
    }

    const point = `${x(i).toFixed(2)},${y(value).toFixed(2)}`
    current = current === null ? `M${point}` : `${current}L${point}`
  })

  if (current !== null) paths.push(current)

  return paths
}

/** Closed area polygon for the same runs — used only for the single-series total chart. */
export function toAreaPath(
  values: Array<number | null>,
  x: (i: number) => number,
  y: (v: number) => number,
  baseline: number,
): Array<string> {
  return toPaths(values, x, y).map((line) => {
    const points = line.slice(1).split('L')
    const first = points[0]
    const last = points[points.length - 1]
    return `${line}L${last.split(',')[0]},${baseline.toFixed(2)}L${first.split(',')[0]},${baseline.toFixed(2)}Z`
  })
}

/** Exponentially growing backoff for a cold-starting backend, capped at 60 s. */
export function backoffMs(attempts: number): number {
  return Math.min(Math.pow(2, Math.max(0, attempts)) * 2000, 60_000)
}

/**
 * The current below which a ZMCT103C branch reading is treated as "no load"
 * rather than as a live figure.
 *
 * This matters because the console formats amps to three decimals so the USB
 * rail's milliamp draw stays visible — which means a genuinely idle branch
 * prints `0.002`, and rounding that for a human reader lands on `0.00`. A
 * `0.00 A` sitting next to a load figure is the exact shape of a false claim:
 * it reads as "measured, and the answer is zero" when the truth is "measured,
 * and the answer is indistinguishable from nothing". So the number keeps its
 * real digits, and the VERDICT beside it says which of the two it is.
 *
 * 5 mA is below the transformer's practical resolution for the small
 * conductors on this rig, so a reading under it carries no usable information.
 */
export const NOISE_FLOOR_AMPS = 0.005

/** What a branch reading means, said in words rather than left to the digits. */
export type LoadVerdict =
  | { kind: 'no-reading'; label: string; detail: string }
  | { kind: 'no-load'; label: string; detail: string }
  | { kind: 'load'; label: string; detail: string }

/**
 * Decide how a channel's current figure must be presented.
 *
 * The ordering matters more than it looks: a GAP is checked before a small
 * number, because a channel that reported nothing at all in the window and a
 * channel that reported nothing measurable are different findings and the UI
 * must not collapse them.
 */
export function loadVerdict(
  amps: number | null,
  opts: { sensed: boolean; channelId: number },
): LoadVerdict {
  const id = `CH${String(opts.channelId).padStart(2, '0')}`
  if (amps === null || !Number.isFinite(amps)) {
    return {
      kind: 'no-reading',
      label: 'No reading',
      detail: `${id} posted no sample in this window. That is a gap in the record, not a measured zero.`,
    }
  }
  if (!opts.sensed) {
    return {
      kind: 'no-load',
      label: 'Not fitted',
      detail: `${id} has no current sensor on its branch, so no current reading is taken for it at all. The figure shown is this channel's nominal rating.`,
    }
  }
  if (Math.abs(amps) < NOISE_FLOOR_AMPS) {
    return {
      kind: 'no-load',
      label: 'No load',
      detail: `${id} reports ${amps.toFixed(3)} A, which is below the ${NOISE_FLOOR_AMPS} A floor of the branch sensor — indistinguishable from no load. The branch is not fitted or not drawing.`,
    }
  }
  return { kind: 'load', label: 'Measuring', detail: '' }
}

/**
 * Aggregate current on the mains feed, as the SUM of the branch readings.
 *
 * Summed rather than computed as P / V on purpose. Each mains branch reports
 * its own current through its own CT, so the total of those readings is a real
 * measurement — whereas total watts divided by one shared voltage reading
 * would be arithmetic on a derived number, and would silently absorb the error
 * of every branch at once.
 *
 * Only SENSED channels contribute. A nominal channel has no current reading to
 * add, and folding in its nominal volts would fabricate a contribution.
 */
export function aggregatedCurrent(
  channels: Array<{ amps: Array<number | null>; provenance: string }>,
): number | null {
  let sum = 0
  let counted = 0
  for (const channel of channels) {
    if (channel.provenance !== 'Measured') continue
    const last = lastPresent(channel.amps)
    if (last === null) continue
    sum += last
    counted += 1
  }
  return counted > 0 ? sum : null
}

/** Last non-null value in a series, or null if it never reported. */
export function lastPresent(values: Array<number | null>): number | null {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const value = values[i]
    if (value !== null && value !== undefined && Number.isFinite(value)) return value
  }
  return null
}
