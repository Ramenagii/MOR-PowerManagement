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
