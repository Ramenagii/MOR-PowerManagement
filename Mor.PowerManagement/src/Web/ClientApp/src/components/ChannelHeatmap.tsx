import { useMemo } from 'react'
import type { TelemetryChannel } from '../api'
import { buildHeatmap, describeSlot, heatFill, type HeatCell } from '../utils/heatmap'

type ChannelHeatmapProps = {
  channels: TelemetryChannel[]
  timestamps: string[]
  bucketSeconds: number
  /**
   * The device has latched a hardware fault. The grid is still drawn — it is
   * the record of what was posted, and hiding it would destroy information —
   * but the zeros stop being printed as figures and the panel stops calling
   * them readings.
   */
  faulted?: boolean
}

/**
 * Channel × time load grid.
 *
 * This is the one panel on the console where the shape of the RECORD is the
 * subject, rather than the shape of the load. A time series chart draws the
 * gaps honestly by breaking the line, but you still have to notice them; here
 * the absence is the picture. On a rig whose device was only powered up part
 * an hour ago, most of a 24-hour window is genuinely empty, and that emptiness
 * is the correct thing to show rather than a wash of near-zero blue that would
 * imply the rig sat idle all day.
 *
 * Three states per cell, never two:
 *   filled   — a reading exists; depth of blue is its mean watts
 *   outlined — a reading exists and was 0 W; drawn as a hairline box so a
 *              measured zero cannot be mistaken for the same blue as a small load
 *   empty    — no sample was posted; nothing at all is drawn
 *
 * A nominal channel (CH5) carries a 135° hatch across its whole row, reusing the
 * one hatch grammar the inventory cards use for "inferred, not measured". The
 * hatch and the emptiness are independent: a hatched cell with no fill is still
 * a gap, because no sensor exists to report one.
 */
export function ChannelHeatmap({
  channels,
  timestamps,
  bucketSeconds,
  faulted = false,
}: ChannelHeatmapProps) {
  const heatmap = useMemo(
    () => buildHeatmap({ channels, timestamps }),
    [channels, timestamps],
  )

  if (!heatmap) {
    return (
      <p className="font-body-sm text-body-sm text-on-surface-variant">
        No time axis to lay this out on — the window returned no bucket timestamps.
      </p>
    )
  }

  const { rows, columns, scaleMax, slotMs } = heatmap
  const slotLabel = describeSlot(slotMs)
  const rampTicks = [0, 0.25, 0.5, 0.75, 1]

  // Column labels: every column that fits in the width, so a 28-column 7-day
  // grid does not print 28 overlapping clock times.
  const labelStride = Math.max(1, Math.ceil(columns.length / 12))

  return (
    <div className="flex flex-col gap-space-sm">
      {faulted && (
        <div className="prov-rail prov-rail--faulted">
          <p className="font-body-sm text-body-sm text-on-surface">
            These cells show what was posted, not what was measured
          </p>
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            The device latched a hardware fault and kept posting zeros. Every cell below therefore
            marks the absence of a reading, and the numeral 0 is withheld from each one — a printed
            zero is a claim, and this console has no claim to make.
          </p>
        </div>
      )}
      <div className="w-full overflow-x-auto">
        <div
          className="min-w-[620px]"
          style={{ display: 'grid', gridTemplateColumns: `112px repeat(${columns.length}, minmax(0, 1fr))`, gap: 3 }}
          role="img"
          aria-label={`Load heatmap: ${rows.length} channels by ${columns.length} ${slotLabel} slots. ${heatmap.reportedCells} of ${heatmap.totalCells} slots carry a reading; the rest were never reported.`}
        >
          {/* Column axis. The top-left cell is the rail label, not data. */}
          <div className="pb-1" aria-hidden="true" />
          {columns.map((column, index) => (
            <div
              key={column.startMs}
              className="pb-1 text-center font-metric-value text-code text-outline"
              aria-hidden="true"
            >
              {index % labelStride === 0 ? formatSlotLabel(column.startMs, slotMs) : ''}
            </div>
          ))}

          {rows.map((row) => (
            <HeatRowCells
              key={row.outletId}
              outletId={row.outletId}
              name={row.name}
              provenance={row.provenance}
              derived={row.derived}
              cells={row.cells}
              columnStarts={columns.map((column) => column.startMs)}
              scaleMax={scaleMax}
              slotMs={slotMs}
              bucketSeconds={bucketSeconds}
              faulted={faulted}
            />
          ))}
        </div>
      </div>

      {/* Legend. The swatches come from the same heatFill the cells use, so the
          key cannot describe a scale the grid is not painting. */}
      <div className="flex flex-wrap items-center gap-x-space-lg gap-y-2 font-body-sm text-body-sm text-on-surface-variant">
        <span className="flex items-center gap-2">
          <span className="text-on-surface">Mean load</span>
          <span className="flex items-center gap-px" aria-hidden="true">
            {rampTicks.map((tick) => (
              <span
                key={tick}
                className="h-3 w-6 first:rounded-l-sm last:rounded-r-sm"
                style={{ background: heatFill(tick) }}
              />
            ))}
          </span>
          <span className="font-metric-value text-metric-value text-on-surface">
            {scaleMax > 0 ? `0 – ${scaleMax.toFixed(0)} W` : 'no load reported'}
          </span>
        </span>

        <span className="flex items-center gap-1.5">
          <span
            className="h-3 w-6 rounded-sm border border-dashed border-outline-variant"
            aria-hidden="true"
          />
          No sample posted
        </span>
        {/*
          Under a fault the "reported 0 W" swatch would be describing cells that
          are no longer reported zeroes. The key has to change with the grid, or
          it becomes a legend for a reading the page has just withdrawn.
        */}
        {faulted ? (
          <span className="flex items-center gap-1.5">
            <span
              className="h-3 w-6 rounded-sm border border-error-fixed"
              style={{ background: 'rgba(194, 65, 54, 0.10)', backgroundImage: DERIVED_HATCH }}
              aria-hidden="true"
            />
            Posted zero, not attributable
          </span>
        ) : (
          <span className="flex items-center gap-1.5">
            <span
              className="h-3 w-6 rounded-sm border border-solid border-outline-variant"
              style={{ background: heatFill(0) }}
              aria-hidden="true"
            />
            Reported 0 W
          </span>
        )}
        <span className="flex items-center gap-1.5">
          <span
            className="h-3 w-6 rounded-sm"
            style={{
              background: DERIVED_HATCH_BACKGROUND,
              backgroundImage: DERIVED_HATCH,
            }}
            aria-hidden="true"
          />
          Nominal, not sensed
        </span>
      </div>

      <p className="font-metric-value text-metric-value text-outline">
        {`${columns.length} ${slotLabel} slots · ${heatmap.reportedCells}/${heatmap.totalCells} carry a reading · ${bucketSeconds} s source buckets`}
      </p>
    </div>
  )
}

const DERIVED_HATCH =
  'repeating-linear-gradient(135deg, rgba(255,255,255,0.72) 0 2px, rgba(255,255,255,0) 2px 6px)'

const DERIVED_HATCH_BACKGROUND = 'rgba(43, 90, 143, 0.14)'

type RowProps = {
  outletId: number
  name: string
  provenance: string
  derived: boolean
  cells: Array<HeatCell | null>
  columnStarts: number[]
  scaleMax: number
  slotMs: number
  bucketSeconds: number
  faulted: boolean
}

function HeatRowCells({
  outletId,
  name,
  provenance,
  derived,
  cells,
  columnStarts,
  scaleMax,
  slotMs,
  bucketSeconds,
  faulted,
}: RowProps) {
  return (
    <>
      {/* Row label: the channel, then its provenance as a dot beside neutral
          text. The dot is amber for a nominal channel, which is the only place
          amber appears on this grid. */}
      <div className="flex min-w-0 items-center gap-1.5 pr-1">
        <span
          className={`shrink-0 rounded-sm ${derived ? 'ant-dot ant-dot-warning' : 'ant-dot bg-outline-variant'}`}
          aria-hidden="true"
        />
        <span className="min-w-0">
          <span className="block truncate font-metric-value text-metric-value font-medium text-on-surface">
            {`CH${String(outletId).padStart(2, '0')}`}
          </span>
          <span className="block truncate font-code text-code text-outline" title={`${name} · ${provenance}`}>
            {derived ? 'nominal' : 'sensed'}
          </span>
        </span>
      </div>

      {cells.map((cell, index) => {
        const slotStart = columnStarts[index]
        const slotClock =
          slotStart === undefined ? 'window start' : formatSlotLabelTime(slotStart, slotMs)

        if (cell === null) {
          return (
            <div
              key={index}
              className="h-6 rounded-sm border border-dashed border-outline-variant/60"
              title={`CH${String(outletId).padStart(2, '0')} · ${name} · ${slotClock}: no sample posted in this ${describeSlot(slotMs)}`}
            />
          )
        }

        const ratio = scaleMax > 0 ? cell.mean / scaleMax : 0
        const isZero = cell.mean === 0
        // Under a fault a reported zero is not a measurement, so it wears the
        // critical accent rather than the neutral "reported 0 W" box and
        // prints no numeral.
        const untrusted = faulted

        return (
          <div
            key={index}
            className="grid h-6 place-items-center rounded-sm"
            style={{
              background: untrusted ? 'rgba(194, 65, 54, 0.10)' : isZero ? heatFill(0) : heatFill(ratio),
              backgroundImage: derived || untrusted ? DERIVED_HATCH : undefined,
              border: isZero ? '1px solid var(--border-medium)' : '1px solid transparent',
            }}
            title={
              `${untrusted ? 'NOT ATTRIBUTABLE · ' : ''}` +
              `CH${String(outletId).padStart(2, '0')} · ${name} · ${derived ? 'nominal' : 'sensed'}\n` +
              `${slotClock} · ${describeSlot(slotMs)} slot\n` +
              `${untrusted ? 'device latched a fault; this zero is not a measurement' : `mean ${cell.mean.toFixed(1)} W · peak ${cell.peak.toFixed(1)} W`}\n` +
              `${cell.reported} of ${cell.slots} ${bucketSeconds} s buckets posted`
            }
          >
            {isZero && !untrusted && (
              <span className="font-metric-value text-metric-value text-[9px] leading-none text-on-surface-variant">
                0
              </span>
            )}
            {isZero && untrusted && (
              <span className="font-metric-value text-metric-value text-[9px] leading-none text-error">
                —
              </span>
            )}
          </div>
        )
      })}
    </>
  )
}

/** Wall-clock label for a column start. Minutes only when the slot is < 1 h. */
function formatSlotLabel(startMs: number, slotMs: number): string {
  const date = new Date(startMs)
  if (Number.isNaN(date.getTime())) return ''
  return slotMs < 3_600_000
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleTimeString(undefined, { hour: '2-digit' })
}

/** Full wall-clock stamp for a cell title — hour and minute. */
function formatSlotLabelTime(startMs: number, slotMs: number): string {
  const date = new Date(startMs)
  if (Number.isNaN(date.getTime())) return 'window start'
  return slotMs < 3_600_000
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
}