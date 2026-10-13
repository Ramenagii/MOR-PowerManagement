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

/** Testing rig: 5 wired channels (MUST_READ.md, until 31 Oct 2026). */
export const ALL_CHANNEL_IDS: number[] = Array.from({ length: 5 }, (_, i) => i + 1)

/**
 * Grouped by rail so the chart reads structurally rather than as arbitrary
 * hues: a blue/sage ramp for the 220 V outlets (CH1-CH4, each with its own
 * ZMCT103C into its own ADS1015 input) and a violet outside that family for
 * the 5 V USB rail (CH5), which has no sensor at all. Colors for CH6-CH13 are
 * retained so the full rig restores without touching this table.
 *
 * Every value is >= 3:1 against the card surface #F5F5F3 (graphics contrast),
 * and CH5 is deliberately outside the measured family: a hue that read as one
 * of the sensed mains traces would overstate a rail that has nothing behind it.
 */
export const CHANNEL_COLORS: string[] = [
  '#2B5A8F', // CH1  mains, ZMCT103C on AIN0 — the info accent
  '#2A7E68', // CH2  mains, ZMCT103C on AIN1 — the nominal accent
  '#4A7FB5', // CH3  mains, ZMCT103C on AIN2 — lighter step of the info ramp
  '#3F6E63', // CH4  mains, ZMCT103C on AIN3 — deeper step of the sage ramp
  '#6B5CA5', // CH5  5 V USB — nominal only, not sensed, outside the family
  '#1F2429', // CH6  mains
  '#5C7FA3', // CH7  mains
  '#356F8C', // CH8  mains
  '#8A5A2B', // CH9  110 V
  '#7A4E8C', // CH10 USB 5 V
  '#4F4F8A', // CH11 USB 5 V
  '#8C5A3C', // CH12 USB 5 V
  '#1F2429', // CH13 USB 5 V
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
 * Rig-wide framing only. The PER-CHANNEL wording is not written here — it comes
 * from `TelemetryChannel.provenanceNote`, which the backend owns and which the
 * views render verbatim. Inventing a parallel set of sentences is how the last
 * revision came to be wrong: these captions described a PZEM-004T that is no
 * longer fitted, and claimed that branch current was "distributed from the
 * mains total by allowance" when each mains branch in fact has its own ZMCT103C
 * on its own ADS1015 input.
 */
export const PROVENANCE_COPY: Record<string, { tone: string; banner: string }> = {
  Simulated: {
    tone: 'simulated',
    banner:
      'Simulated — not measured. No INA226, ADS1015 or branch current sensor is being read; ' +
      'the ESP32 synthesises every reading on-device (SIMULATE_METERS = 1). Nothing on this ' +
      'screen came off a sensor.',
  },
  Metered: {
    tone: 'measured',
    banner:
      'Per-channel provenance is decided by the hardware on that branch. Each channel\'s own ' +
      'explanation is shown on its card and in the channel filter; this page only states the rig ' +
      'shape: one shared voltage reading repeated across the mains branches, and one branch ' +
      'current sensor per mains outlet.',
  },
  Unknown: {
    tone: 'unknown',
    banner: 'The device has not reported a metering mode, so no reading on this screen can be attributed.',
  },
}

/**
 * The one sentence that is true on every mains branch, and is the thing most
 * often got wrong: CH1–CH4 do NOT have four voltage sensors. There is one
 * shared voltage reading, and the API repeats it per channel, so four identical
 * volts figures are one measurement shown four times — not four measurements.
 */
export const SHARED_VOLTS_NOTE =
  'CH1–CH4 show the same volts figure because there is one shared voltage reading, repeated per channel. It is not four separate per-branch voltage measurements.'

export const VOLTS_CAPTION_METERED = SHARED_VOLTS_NOTE

export const VOLTS_CAPTION =
  'CH5 shows a flat 5 V because the USB rail has no sensor behind it. That figure is its ' +
  'nominal rating, not a measurement, and the row is hatched everywhere it appears.'

export const AMPS_CAPTION =
  'On CH1–CH4 this is read directly from the ZMCT103C on that branch through its own ADS1015 ' +
  'analogue input — not apportioned from a mains total. CH5 has no CT at all, so its current is ' +
  'not measured and never appears as a live zero.'

export const WATTS_CAPTION =
  'On CH1–CH4 this is volts × current on that branch, so it inherits the branch current ' +
  'measurement rather than being estimated from an allowance share. CH5 is nominal only.'

export const WATTS_CAPTION_SIMULATED =
  'Per-channel watts here are a share of a synthesised mains total. Nothing on this screen was measured.'

/**
 * What this build does NOT measure, stated once so no view has to guess.
 *
 * Every entry below used to be invented somewhere in the console: a THD
 * percentage, a 0.95 lagging power factor, a 60.0 Hz line frequency, a kWh
 * energy total, and a 1,500 W per-outlet rating. None of them has a sensor,
 * an accumulator or a config field behind it — the firmware posts
 * `energyKwh = 0.0` on every reading, so an energy total computed from it would
 * be a precise-looking zero. They are listed as absent rather than silently
 * dropped, because "not shown" and "not measured" are different claims and a
 * reader deserves to know which one applies.
 */
export const NOT_MEASURED: ReadonlyArray<{ label: string; why: string }> = [
  { label: 'Power factor', why: 'No phase measurement exists on this rig.' },
  { label: 'Frequency', why: 'Nothing samples line frequency.' },
  { label: 'THD', why: 'Harmonic distortion is not measured anywhere in the build.' },
  {
    label: 'Energy (kWh)',
    why: 'No accumulator runs on the device. Readings post energyKwh = 0.0, so a total would be a precise-looking zero.',
  },
  {
    label: 'Relay contact state',
    why: 'RELAY_OUTPUT_ENABLED is 0 — relays are not driven in this phase, so a contact reading would be a constant, not a measurement.',
  },
]

/** Matches Telemetry:RetentionDays on the backend. */
export const TELEMETRY_RETENTION_DAYS = 3
