import type { TelemetryWindow } from '../api'

/** The five bounded windows. Order is the render order in the segmented control. */
export const TELEMETRY_WINDOWS: Array<{ id: TelemetryWindow; label: string }> = [
  { id: '15m', label: '15 min' },
  { id: '1h', label: '1 hour' },
  { id: '6h', label: '6 hours' },
  { id: '24h', label: '24 hours' },
  { id: '7d', label: '7 days' },
]

/**
 * Poll cadence per window. Independent of App.tsx's dashboard loop —
 * two loops in one component tree would double the load on a host that sleeps.
 *
 * These are display refreshes only. The backend still evaluates every device
 * batch for automatic shedding; a chart does not need to re-query Neon for
 * every new sample.
 */
export const POLL_INTERVAL_MS: Record<TelemetryWindow, number | null> = {
  '15m': 30_000,
  '1h': 60_000,
  '6h': 60_000,
  '24h': 300_000,
  '7d': null,
}

/** Testing rig: 4 wired mains channels + the monitored-only USB rail (MUST_READ.md, until 31 Oct 2026). */
export const ALL_CHANNEL_IDS: number[] = Array.from({ length: 4 }, (_, i) => i + 1)

/**
 * Width of the dashboard's history strip, in seconds.
 *
 * The bucket grid belongs to the server, so this is a *span* and not a bucket
 * count: the number of columns that cover it is derived per response as
 * `ceil(HISTORY_SPAN_SECONDS / bucketSeconds)`. A 15 m window served at 60 s
 * buckets yields five columns; served at 10 s buckets it yields thirty. Either way
 * the strip shows the same five minutes rather than a varying stretch of time
 * that would silently change what two charts side by side are comparing.
 */
export const HISTORY_SPAN_SECONDS = 300

/**
 * Mapped by channel id, so the same channel keeps its colour between the chart,
 * the legend and the policy view. Hues follow the RAIL: a blue/teal ramp for
 * the 220 V mains outlets, amber for the 110 V outlet, violet for the 5 V USB
 * rails. Index order and rail order are not the same thing on this bench —
 * CH5 is the USB rail and sits in the middle of the mains ramp because it is the
 * fifth channel — so read the label, not the position, when telling them apart.
 *
 * CH5 is violet on purpose. It was mains blue while it was a paper channel, and
 * when the bench grew to five that would have drawn the one branch that cannot
 * be shed in the same ink as the four that can. All are >= 3:1 against
 * --surface-container-lowest #ffffff, and none reads as --primary #0059c2 when
 * used as a fill.
 */
export const CHANNEL_COLORS: string[] = [
  '#0677ad', // CH1  mains
  '#0a8f6a', // CH2  mains
  '#3f7fbf', // CH3  mains
  '#0f9bb5', // CH4  mains
  '#7a4fb5', // CH5  USB 5 V
  '#4a6fa5', // CH6  mains
  '#1f7a4d', // CH7  mains
  '#5c8ac4', // CH8  mains
  '#2aa198', // CH9  mains
  '#b26a00', // CH10 110 V
  '#9a4f9e', // CH11 USB 5 V
  '#5f5fb5', // CH12 USB 5 V
  '#8c5a3c', // CH13 USB 5 V
]

/** Cycled by index % 3 — a second encoding so the chart survives CVD and a bad projector. */
export const CHANNEL_DASHES: string[] = ['', '6 3', '2 3']

export function channelColor(outletId: number): string {
  return CHANNEL_COLORS[(outletId - 1) % CHANNEL_COLORS.length]
}

export function channelDash(outletId: number): string {
  return CHANNEL_DASHES[(outletId - 1) % CHANNEL_DASHES.length]
}

/** Provenance glyphs. Filled = measured, half = derived, hollow = simulated. */
export const PROVENANCE_GLYPH: Record<string, string> = {
  Measured: '●',
  DerivedNominal: '◐',
  DerivedLoadShare: '◐',
  Simulated: '○',
  Unknown: '○',
}

/** Human label for the rig-wide mode, shown as a pill next to the page heading. */
export const METERING_MODE_LABEL: Record<string, string> = {
  Simulated: 'Simulated',
  Metered: 'Metered',
  Unknown: 'Unknown',
}

/**
 * All honesty copy lives here so the telemetry view, the hardware view and the
 * architecture doc cannot drift apart. Never say "measured" for anything derived.
 *
 * These strings are tooltip bodies, not banners: the views that used to print
 * them as paragraphs now carry them on a single ⓘ chip, so the provenance stays
 * available without a block of prose sitting above the chart.
 */
export const PROVENANCE_COPY: Record<string, { tone: string; banner: string }> = {
  Simulated: {
    tone: 'simulated',
    banner:
      'Simulated — not measured. The ESP32 synthesises these readings (SIMULATE_METERS = 1). ' +
      'Per-channel volts use the 220 V mains rating. Current is derived as P/V; ' +
      'per-channel watts are the mains total distributed across energized channels by allowance.',
  },
  Metered: {
    tone: 'measured',
    banner:
      'The ESP32 polls the INA226 over I2C for its DC bus and shunt current. Branch CTs are read separately ' +
      'through the ADS1220 on CH1–CH4. Per-channel current and watts are derived from ' +
      'reported channel loads and rated voltage in this demo mode.',
  },
  Unknown: {
    tone: 'unknown',
    banner: 'Metering mode has not been reported by the device yet.',
  },
}

export const VOLTS_CAPTION_METERED =
  'CH1–CH4 carry their branch CT readings. The INA226 DC bus reading is separate and is not used as a mains voltage reference.'

export const VOLTS_CAPTION =
  'The channel reports its rated rail, not a live sample, so the line is flat. It still counts toward P_total.'

export const AMPS_CAPTION =
  'Current is derived per channel as P_branch / V_branch, so it is only as trustworthy as the derived power.'

export const WATTS_CAPTION =
  'Per-channel watts are an allowance-weighted share of the measured mains total — an estimation method suitable for DSM policy research, not revenue-grade metering.'

export const WATTS_CAPTION_SIMULATED =
  'Per-channel watts are an allowance-weighted share of a synthesised mains total. Nothing here is measured.'

