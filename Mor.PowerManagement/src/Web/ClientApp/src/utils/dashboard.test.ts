import { describe, expect, it } from 'vitest'
import { baseOutlets } from '../data/dashboard'
import {
  formatWatts,
  isEnergizedOutlet,
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

  it('formats watt values as rounded display text', () => {
    expect(formatWatts(1999.6)).toBe('2,000 W')
    expect(formatWatts(72.2)).toBe('72 W')
  })

  it('classifies load at the thresholds the caller read from the server', () => {
    expect(systemState(479, 480, 600)).toBe('Normal')
    expect(systemState(480, 480, 600)).toBe('Warning')
    expect(systemState(600, 480, 600)).toBe('Critical')
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
