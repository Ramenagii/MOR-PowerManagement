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
 * Poll cadence per window. Independent of App.tsx's 5 s dashboard loop (D10) —
 * two loops in one component tree would double the load on a host that sleeps.
 * The 7-day window is manual-only: it never changes on its own.
 */
export const POLL_INTERVAL_MS: Record<TelemetryWindow, number | null> = {
  '15m': 10_000,
  '1h': 10_000,
  '6h': 30_000,
  '24h': 30_000,
  '7d': null,
}

export const ALL_CHANNEL_IDS: number[] = Array.from({ length: 13 }, (_, i) => i + 1)

/**
 * Grouped by rail so the chart reads structurally rather than as 13 arbitrary
 * hues: blue/teal ramp for the 220 V mains bus (CH1-8), amber for the 110 V
 * step-down (CH9), violets/plums for the 5 V USB rails (CH10-13). All are >= 3:1
 * against --surface #ffffff, and none reads as --accent #0677ad when used as a fill.
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
 */
export const PROVENANCE_COPY: Record<string, { tone: string; banner: string }> = {
  Simulated: {
    tone: 'simulated',
    banner:
      'Simulated — not measured. No PZEM-004T is wired; the ESP32 synthesises these readings ' +
      '(SIMULATE_METERS = 1). Per-channel volts are nominal ratings (CH1–CH8 220 V, CH9 110 V, ' +
      'CH10–CH13 5 V). Current is derived as P/V; per-channel watts are the mains total distributed ' +
      'across energized channels by allowance.',
  },
  Metered: {
    tone: 'measured',
    banner:
      'One meter, thirteen channels. CH1–CH8 volts are read from the single mains PZEM-004T v3.0 on ' +
      'the common feed. CH9 (110 V) and CH10–CH13 (5 V USB) report their nominal rating — they are not ' +
      'individually metered. Per-channel current and watts are derived by distributing the measured mains ' +
      'total across energized channels, weighted by each channel’s allowance. This is an estimation ' +
      'method for DSM research, not revenue-grade metering.',
  },
  Unknown: {
    tone: 'unknown',
    banner: 'Metering mode has not been reported by the device yet.',
  },
}

export const VOLTS_CAPTION_METERED =
  'CH1–CH8 carry the single mains PZEM-004T v3.0 reading; the mains total is distributed across energized channels by allowance.'

export const VOLTS_CAPTION =
  'CH9 (110 V) and CH10–CH13 (5 V USB) appear as flat lines because those channels report their nominal rating. They are not individually metered.'

export const AMPS_CAPTION =
  'Current is not sampled. It is derived per channel as P_branch / V_branch, so it is only as trustworthy as the derived power.'

export const WATTS_CAPTION =
  'Per-channel watts are an allowance-weighted share of the single measured mains total — an estimation method suitable for DSM policy research, not revenue-grade metering.'

export const WATTS_CAPTION_SIMULATED =
  'Per-channel watts are an allowance-weighted share of a synthesised mains total. Nothing here is measured.'

/** Matches Telemetry:RetentionDays on the backend. */
export const TELEMETRY_RETENTION_DAYS = 3
