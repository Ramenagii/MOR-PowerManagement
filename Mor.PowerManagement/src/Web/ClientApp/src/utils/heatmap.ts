/**
 * Channel × time heatmap — pure geometry, no React.
 *
 * The rule that governs this whole file: a slot with no samples is `null`, and
 * a slot with samples that sum to zero is `{ mean: 0 }`. Those are different
 * facts and the grid must be able to draw them differently. A device that was
 * asleep for two hours did not report a light load, it reported nothing, and a
 * grid that paints "no data" the same colour as "measured zero" is lying about
 * the one thing a heatmap is for.
 */

/** Slot widths, smallest first. The first one that covers the target is used. */
const SLOT_WIDTHS_MS = [
  60_000, // 1 min
  300_000, // 5 min
  900_000, // 15 min
  1_800_000, // 30 min
  3_600_000, // 1 h
  10_800_000, // 3 h
  21_600_000, // 6 h
] as const

/** Columns are aimed at this count; the slot width snaps to a human duration. */
const TARGET_COLUMNS = 24

export function slotWidthMs(spanMs: number): number {
  if (!(spanMs > 0)) return SLOT_WIDTHS_MS[0]
  const target = spanMs / TARGET_COLUMNS
  return SLOT_WIDTHS_MS.find((width) => width >= target) ?? SLOT_WIDTHS_MS[SLOT_WIDTHS_MS.length - 1]
}

export type HeatCell = {
  /** Mean watts across the reported buckets in this slot. */
  mean: number
  /** Highest single bucket in this slot — a spiky slot averages into calm. */
  peak: number
  /** Buckets that actually carried a reading. */
  reported: number
  /** Buckets inside the slot, reported or not. */
  slots: number
}

export type HeatRow = {
  outletId: number
  name: string
  provenance: string
  /** True when the channel's figures are nominal rather than sensed. */
  derived: boolean
  /** One entry per column; null means no sample was posted in that slot. */
  cells: Array<HeatCell | null>
}

export type HeatColumn = {
  startMs: number
  reported: number
  slots: number
}

export type Heatmap = {
  rows: HeatRow[]
  columns: HeatColumn[]
  slotMs: number
  /** Largest cell mean in the grid — the top of the colour ramp. */
  scaleMax: number
  /** Cells that actually carry a reading, across every row. */
  reportedCells: number
  totalCells: number
}

export type HeatmapInput = {
  channels: Array<{
    outletId: number
    name: string
    provenance: string
    watts: Array<number | null>
  }>
  timestamps: string[]
}

/**
 * Fold per-channel bucket series into a fixed time grid.
 *
 * Slots are aligned to a wall-clock grid (floor of the epoch-relative
 * timestamp), not to the first bucket in the window. A window that starts at
 * 04:53 therefore still produces columns labelled on the hour, which is what
 * makes two columns comparable and lets an operator say "06:00" instead of
 * "bucket 29".
 */
export function buildHeatmap(input: HeatmapInput): Heatmap | null {
  const stamps = input.timestamps
  if (stamps.length === 0 || input.channels.length === 0) return null

  const times = stamps.map((stamp) => Date.parse(stamp))
  if (times.some((time) => Number.isNaN(time))) return null

  const first = Math.min(...times)
  const last = Math.max(...times)
  const slotMs = slotWidthMs(last - first)
  if (!(slotMs > 0)) return null

  const firstSlot = Math.floor(first / slotMs)
  const lastSlot = Math.floor(last / slotMs)
  const columnCount = lastSlot - firstSlot + 1
  if (columnCount <= 0) return null

  const columns: HeatColumn[] = []
  for (let slot = firstSlot; slot <= lastSlot; slot += 1) {
    columns.push({ startMs: slot * slotMs, reported: 0, slots: 0 })
  }

  const rows: HeatRow[] = input.channels.map((channel) => {
    const cells: Array<HeatCell | null> = new Array<HeatCell | null>(columnCount).fill(null)
    const buckets = new Map<number, { sum: number; peak: number; reported: number; slots: number }>()

    channel.watts.forEach((value, index) => {
      const time = times[index]
      const columnIndex = Math.floor(time / slotMs) - firstSlot
      if (columnIndex < 0 || columnIndex >= columnCount) return

      const bucket = buckets.get(columnIndex) ?? { sum: 0, peak: Number.NEGATIVE_INFINITY, reported: 0, slots: 0 }
      bucket.slots += 1
      if (value !== null && value !== undefined && Number.isFinite(value)) {
        bucket.sum += value
        if (value > bucket.peak) bucket.peak = value
        bucket.reported += 1
      }
      buckets.set(columnIndex, bucket)
    })

    let reportedCells = 0
    buckets.forEach((bucket, columnIndex) => {
      columns[columnIndex].slots += bucket.slots
      columns[columnIndex].reported += bucket.reported
      if (bucket.reported === 0) return
      cells[columnIndex] = {
        mean: bucket.sum / bucket.reported,
        peak: bucket.peak,
        reported: bucket.reported,
        slots: bucket.slots,
      }
      reportedCells += 1
    })

    return {
      outletId: channel.outletId,
      name: channel.name,
      provenance: channel.provenance,
      derived: channel.provenance !== 'Measured',
      cells,
    }
  })

  let scaleMax = 0
  let reportedCells = 0
  for (const row of rows) {
    for (const cell of row.cells) {
      if (cell === null) continue
      reportedCells += 1
      if (cell.mean > scaleMax) scaleMax = cell.mean
    }
  }

  return {
    rows,
    columns,
    slotMs,
    scaleMax,
    reportedCells,
    totalCells: rows.length * columnCount,
  }
}

/**
 * Continuous colour ramp over the brand primary, 0 → 1.
 *
 * One function feeds both the cells and the legend swatches, so the legend
 * cannot drift out of step with what it is describing — a two-implementation
 * legend is how a colour key ends up lying.
 *
 * Alpha rather than a stepped palette because a heatmap is read by scanning for
 * the hot spots; quantised bands hide the difference between 80 W and 110 W,
 * which on this rig is the difference between a kettle and a heater.
 *
 * The default is DESIGN.md's info accent (#2B5A8F) — the same value the
 * `primary` token carries — so the grid and the rest of the console cannot end
 * up on two different blues.
 */
export function heatFill(ratio: number, primary: [number, number, number] = [43, 90, 143]): string {
  const clamped = Math.min(Math.max(Number.isFinite(ratio) ? ratio : 0, 0), 1)
  const alpha = 0.06 + clamped * 0.88
  return `rgba(${primary[0]}, ${primary[1]}, ${primary[2]}, ${alpha.toFixed(3)})`
}

/** Ink that stays legible on a filled cell at this ratio. */
export function heatInk(ratio: number): string {
  return ratio > 0.62 ? '#ffffff' : 'rgba(31, 36, 41, 0.92)'
}

/** Human slot width, e.g. "5 min", "1 h", "6 h". */
export function describeSlot(slotMs: number): string {
  if (slotMs >= 3_600_000) {
    const hours = slotMs / 3_600_000
    return `${hours} h`
  }
  return `${slotMs / 60_000} min`
}