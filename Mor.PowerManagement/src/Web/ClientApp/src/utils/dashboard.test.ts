import { describe, expect, it } from 'vitest'
import { baseOutlets, CRITICAL_THRESHOLD, WARNING_THRESHOLD } from '../data/dashboard'
import {
  formatWatts,
  isEnergizedOutlet,
  statusClass,
  systemState,
  totalLoad,
} from './dashboard'

describe('dashboard utilities', () => {
  it('sums outlet load from the configured baseline outlets', () => {
    expect(totalLoad(baseOutlets)).toBe(1350)
  })

  it('formats watt values as rounded display text', () => {
    expect(formatWatts(1999.6)).toBe('2,000 W')
    expect(formatWatts(72.2)).toBe('72 W')
  })

  it('classifies load at normal, warning, and critical thresholds', () => {
    expect(systemState(WARNING_THRESHOLD - 1)).toBe('Normal')
    expect(systemState(WARNING_THRESHOLD)).toBe('Warning')
    expect(systemState(CRITICAL_THRESHOLD)).toBe('Critical')
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
