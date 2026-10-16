import { describe, expect, it } from 'vitest'
import { baseOutlets } from '../data/dashboard'
import {
  formatWatts,
  isEnergizedOutlet,
  isLatchedOutlet,
  relayChip,
  statusClass,
  systemState,
  totalLoad,
} from './dashboard'

describe('dashboard utilities', () => {
  it('sums the pre-first-response roster to zero, because nothing has been measured', () => {
    // baseOutlets is a SHAPE, not a simulation. It used to seed 260 + 180 W,
    // which the hero summed into a confident "440 W" before the backend had
    // answered a single request. Zero here is the assertion that the client
    // holds no measurements of its own.
    expect(totalLoad(baseOutlets)).toBe(0)
  })

  it('holds no threshold of its own — the roster carries configuration, not limits', () => {
    // 1100 W per mains branch on the reference rig. It is here because it is a
    // SETTING the server owns and this roster is only the shape drawn before the
    // first poll, and it is replaced wholesale on that poll. It is deliberately
    // not exported as a constant any view could fall back to.
    expect(baseOutlets.filter((o) => o.id <= 4).every((o) => o.allowance === 1100)).toBe(true)
    // 0 W on every channel: a reading the client has never received.
    expect(baseOutlets.every((o) => o.watts === 0)).toBe(true)
    // 238 V on the two rated mains rails, and nothing on the other two.
    expect(baseOutlets.find((o) => o.id === 3)?.volts).toBe(238)
    expect(baseOutlets.find((o) => o.id === 1)?.volts).toBe(0)
  })

  it('formats watt values as rounded display text', () => {
    expect(formatWatts(1999.6)).toBe('2,000 W')
    expect(formatWatts(72.2)).toBe('72 W')
  })

  it('classifies load at the thresholds the caller read from the server', () => {
    // The reference rig's own numbers: 4400 W ceiling, warning at 3520 W.
    expect(systemState(3519, 3520, 4400)).toBe('Normal')
    expect(systemState(3520, 3520, 4400)).toBe('Warning')
    expect(systemState(4400, 3520, 4400)).toBe('Critical')
  })

  it('cannot warn or trip against a threshold that was never reported', () => {
    // thresholds.critical is 0 until GET /Dashboard/state supplies one. With no
    // band to be in, nothing is being reported — the dash in the UI is what
    // tells the operator the verdict has nothing behind it.
    expect(systemState(0, 0, 0)).toBe('Normal')
    expect(systemState(0, 0, 0)).not.toBe('Critical')
  })

  it('treats active and standby outlets as energized', () => {
    expect(isEnergizedOutlet('Active')).toBe(true)
    expect(isEnergizedOutlet('Standby')).toBe(true)
    expect(isEnergizedOutlet('Disconnected')).toBe(false)
    expect(isEnergizedOutlet('Restricted')).toBe(false)
  })

  it('normalizes outlet status for CSS class names', () => {
    expect(statusClass('Disconnected')).toBe('disconnected')
  })
})

describe('relayChip', () => {
  it('maps every enum member the server can send, and no others', () => {
    // `outletStatuses` in api.ts is indexed by the wire ordinal, so this list has
    // to stay in step with Domain/Enums/OutletStatus.cs. A fifth word here would
    // be the console inventing a state the server cannot report.
    expect(relayChip('Active').word).toBe('ACTIVE')
    expect(relayChip('Standby').word).toBe('STANDBY')
    expect(relayChip('Disconnected').word).toBe('OPEN')
    expect(relayChip('Restricted').word).toBe('LATCHED')
  })

  it('does not print TRIPPED, because the wire carries no trip', () => {
    // The reference sketch prints TRIPPED, but DisconnectOutlet and every shed
    // path write Disconnected, so a firmware trip is indistinguishable from an
    // operator's disconnect once it reaches the server. OPEN is the one word that
    // is true of both.
    const words = (['Active', 'Standby', 'Restricted', 'Disconnected'] as const).map(
      (status) => relayChip(status).word,
    )
    expect(words).not.toContain('TRIPPED')
  })

  it('gives latched a tone of its own, distinct from open', () => {
    // This is the whole point of the chip: the operator has to be able to see, at
    // a glance across a room, that one branch is isolated by the engine and
    // cannot be brought back with the switch.
    expect(relayChip('Restricted').tone).toBe('latched')
    expect(relayChip('Disconnected').tone).toBe('open')
    expect(relayChip('Restricted').tone).not.toBe(relayChip('Disconnected').tone)
  })

  it('keeps the ordinary case quiet, because it is the ordinary case', () => {
    expect(relayChip('Active').tone).toBe('live')
    expect(relayChip('Active').detail).not.toContain('TRIPPED')
  })

  it('agrees with isEnergizedOutlet about what is powered', () => {
    const statuses = ['Active', 'Standby', 'Restricted', 'Disconnected'] as const
    for (const status of statuses) {
      // A latched branch is de-energized, so the two must never disagree — the
      // switch and the chip describe the same contact.
      if (isLatchedOutlet(status)) expect(isEnergizedOutlet(status)).toBe(false)
    }
    expect(isLatchedOutlet('Restricted')).toBe(true)
    expect(isLatchedOutlet('Disconnected')).toBe(false)
    expect(isLatchedOutlet('Active')).toBe(false)
  })
})
