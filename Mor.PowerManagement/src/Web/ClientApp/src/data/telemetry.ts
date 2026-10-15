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
 * Poll cadence per window. Independent of App.tsx's 1 s dashboard loop (D10) —
 * two loops in one component tree would double the load on a host that sleeps.
 *
 * Kept in step with the device: the ESP32 posts a batch every 1 s, so a 10 s
 * poll discarded nine of every ten readings and made a live chart look static.
 * The short windows now poll at 2 s; longer windows stay slower because there
 * is no new data arriving for them at a useful rate.
 */
export const POLL_INTERVAL_MS: Record<TelemetryWindow, number | null> = {
  '15m': 1_000,
  '1h': 1_000,
  '6h': 5_000,
  '24h': 15_000,
  '7d': null,
}

/** Testing rig: 2 wired channels (MUST_READ.md, until 31 Oct 2026). */
export const ALL_CHANNEL_IDS: number[] = Array.from({ length: 2 }, (_, i) => i + 1)

// FUTURE 4+USB: change the length above to 5 to restore the full bench. CHANNEL_COLORS
// already carries CH1-CH5 (mains ramp + the violet USB rail), so nothing else changes.

/**
 * Width of the dashboard's history strip, in seconds.
 *
 * The bucket grid belongs to the server, so this is a *span* and not a bucket
 * count: the number of columns that cover it is derived per response as
 * `ceil(HISTORY_SPAN_SECONDS / bucketSeconds)`. A 15 m window served at 60 s
 * buckets yields five columns; served at 5 s buckets it yields sixty. Either way
 * the strip shows the same five minutes rather than a varying stretch of time
 * that would silently change what two charts side by side are comparing.
 */
export const HISTORY_SPAN_SECONDS = 300

/**
 * Grouped by rail so the chart reads structurally rather than as arbitrary
 * hues: blue/teal ramp for the 220 V outlets, violet for the 5 V USB rail.
 * The bench currently wires CH1-CH2 only; the rest are retained so the full rig
 * restores without touching this table. All are >= 3:1 against
 * --surface-container-lowest #ffffff, and none reads as --primary #0059c2 when
 * used as a fill.
 */
export const CHANNEL_COLORS: string[] = [
  '#0677ad', // CH1  mains
  '#0a8f6a', // CH2  mains
  '#3f7fbf', // CH3  mains
  '#0f9bb5', // CH4  mains
  '#4a6fa5', // CH5  mains
  '#1f7a4d', // CH6  mains
  '#5c8ac4', // CH7  mains
  '#2aa198', // CH8  mains
  '#b26a00', // CH9  110 V
  '#7a4fb5', // CH10 USB 5 V
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
      'Per-channel volts are nominal ratings (CH1–CH2 220 V). Current is derived as P/V; per-channel ' +
      'watts are the mains total distributed across energized channels by allowance.',
  },
  Metered: {
    tone: 'measured',
    banner:
      'One INA226 on the common mains feed reads volts and the total; each branch CT behind an ADS1015 ' +
      'reads its own current. CH1–CH2 volts are the rated 220 V rail. Per-channel current and watts are ' +
      'derived by distributing the measured mains total across energized channels, weighted by allowance. ' +
      'An estimation method for DSM research, not revenue-grade metering.',
  },
  Unknown: {
    tone: 'unknown',
    banner: 'Metering mode has not been reported by the device yet.',
  },
}

export const VOLTS_CAPTION_METERED =
  'CH1–CH2 carry the rated 220 V mains rail; the INA226 total on the common feed is what the branch current is referenced against.'

export const VOLTS_CAPTION =
  'The channel reports its rated rail, not a live sample, so the line is flat. It still counts toward P_total.'

export const AMPS_CAPTION =
  'Current is derived per channel as P_branch / V_branch, so it is only as trustworthy as the derived power.'

export const WATTS_CAPTION =
  'Per-channel watts are an allowance-weighted share of the measured mains total — an estimation method suitable for DSM policy research, not revenue-grade metering.'

export const WATTS_CAPTION_SIMULATED =
  'Per-channel watts are an allowance-weighted share of a synthesised mains total. Nothing here is measured.'

/** Matches Telemetry:RetentionDays on the backend. */
export const TELEMETRY_RETENTION_DAYS = 3
