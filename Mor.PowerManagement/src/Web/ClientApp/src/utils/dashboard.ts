import type { Outlet, OutletStatus } from '../types/dashboard'

export function getTimeStamp() {
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date())
}

export function formatWatts(value: number) {
  return `${Math.round(value).toLocaleString()} W`
}

export function totalLoad(outlets: Outlet[]) {
  return outlets.reduce((sum, outlet) => sum + outlet.watts, 0)
}

export function isEnergizedOutlet(status: OutletStatus) {
  return status === 'Active' || status === 'Standby'
}

/**
 * The one status the server keeps until a POLICY ACTION clears it.
 *
 * `Restricted` is not a phase an outlet passes through, it is a latch:
 * `IngestTelemetry` skips every relay report for a restricted outlet ("Backend
 * restriction sticks until cleared by policy action"), so no amount of relay
 * traffic brings it back. The server sets it from two places, both real faults:
 * `FaultFlag` → POL-01 hardware fault isolation, which restricts every outlet on
 * the rig, and an activation the engine denied.
 *
 * This is the ONLY latch in the enum, and it is the reason the row has a
 * latched visual at all. See `relayChip` for what is deliberately NOT one.
 */
export function isLatchedOutlet(status: OutletStatus) {
  return status === 'Restricted'
}

/** Tone vocabulary for the relay-state chip. Kept small on purpose. */
export type RelayTone = 'live' | 'idle' | 'open' | 'latched'

export type RelayChip = {
  /** The word printed on the chip. One word, upper case, read across a room. */
  word: string
  tone: RelayTone
  /** Prose. Tooltip only — the row is scanned, not read. */
  detail: string
}

/**
 * Map an `OutletStatus` onto the relay-state chip the row shows.
 *
 * WHY THERE IS NO "TRIPPED" CHIP:
 *
 * The reference sketch prints three words per channel —
 * `tripped_N ? "TRIPPED" : (relayState_N ? "ACTIVE" : "STANDBY")` — and TRIPPED
 * is the obvious thing to add. The server cannot send it. `OutletStatus` is
 * `{ Active, Standby, Restricted, Disconnected }` and there is no fifth member,
 * so a chip reading TRIPPED would be asserting a distinction the wire does not
 * carry.
 *
 * Worse, it would be a distinction that does not exist on the bench either. Both
 * things that open a relay write the same value:
 *   - `DisconnectOutlet` (an operator pressing the switch) → `Disconnected`
 *   - `ApplySelectiveResponse` / the IngestTelemetry shed tick → `Disconnected`
 * and the firmware's own trip drives the same relay LOW that a disconnect does,
 * so its TRIPPED state arrives here looking exactly like an operator's
 * disconnect. `Disconnected` is therefore labelled OPEN — the one word that is
 * true of both — and its tooltip says so out loud.
 *
 * What IS distinct, and what the chip separates, is that the server has one
 * state an operator cannot reach by pressing a switch: `Restricted`. That is the
 * latch, and it gets the only alarming treatment on the row.
 */
export function relayChip(status: OutletStatus): RelayChip {
  switch (status) {
    case 'Active':
      return {
        word: 'ACTIVE',
        tone: 'live',
        detail: 'Relay closed and the branch is above the standby threshold.',
      }
    case 'Standby':
      return {
        word: 'STANDBY',
        tone: 'idle',
        detail: 'Relay closed, draw below the standby threshold. Still energized.',
      }
    case 'Restricted':
      return {
        word: 'LATCHED',
        tone: 'latched',
        detail:
          'Restricted by the policy engine — POL-01 hardware fault isolation, or an activation it denied. The server ignores relay reports for a restricted outlet, so this does not clear by pressing the switch.',
      }
    case 'Disconnected':
    default:
      return {
        word: 'OPEN',
        tone: 'open',
        detail:
          'Relay open. This is also what a firmware trip and a policy shed look like — DisconnectOutlet and the shed paths both write Disconnected, and the wire carries no way to tell them apart.',
      }
  }
}

/**
 * System band for a load, against thresholds the caller read from the server.
 *
 * The trip points are arguments rather than module constants on purpose. This
 * used to compare against a copy of the rig's 600/480 W held in data/dashboard,
 * so the top bar's "System Normal" was a statement about a number the console
 * had invented — and with an offline rig at 0 W it cheerfully reported Normal
 * against a limit that did not exist.
 *
 * A critical of 0 means "no limit has been reported". 0 load is then not a band,
 * it is an absence of information, so the answer is Normal only because there is
 * nothing to be warning about — and the dashboard's own banner is what tells the
 * operator that the threshold behind that verdict is missing.
 */
export function systemState(load: number, warning: number, critical: number) {
  if (critical > 0 && load >= critical) return 'Critical'
  if (warning > 0 && load >= warning) return 'Warning'
  return 'Normal'
}

export function statusClass(status: OutletStatus) {
  return status.toLowerCase()
}
