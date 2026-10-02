import { describe, expect, it } from 'vitest'
import {
  backoffMs,
  describeSeries,
  formatRelative,
  formatTick,
  formatValue,
  histogram,
  niceDomain,
  pickTickIndices,
  roundToStep,
  seriesStats,
  stalenessState,
  toAreaPath,
  toPaths,
} from './telemetry'

const identityX = (i: number) => i * 10
const identityY = (v: number) => v

describe('niceDomain', () => {
  it('rounds outward to a 1/2/5 step and never clips the data', () => {
    const domain = niceDomain(219.4, 221.1)
    expect(domain.min).toBeLessThanOrEqual(219.4)
    expect(domain.max).toBeGreaterThanOrEqual(221.1)
    expect([1, 2, 5, 10].includes(domain.step / Math.pow(10, Math.floor(Math.log10(domain.step))))).toBe(true)
  })

  it('gives a flat nominal rail a readable band instead of a zero-width one', () => {
    const domain = niceDomain(5, 5)
    expect(domain.max).toBeGreaterThan(domain.min)
    expect(domain.step).toBeGreaterThan(0)
  })

  it('expands around zero', () => {
    const domain = niceDomain(-0.4, 0.4)
    expect(domain.min).toBeLessThanOrEqual(-0.4)
    expect(domain.max).toBeGreaterThanOrEqual(0.4)
  })

  it('falls back to a unit band on non-finite input', () => {
    expect(niceDomain(Number.NaN, Number.POSITIVE_INFINITY)).toEqual({ min: 0, max: 1, step: 0.5 })
  })
})

describe('roundToStep', () => {
  it('removes floating-point noise at the step precision', () => {
    expect(roundToStep(0.30000000000000004, 0.1)).toBe(0.3)
    expect(roundToStep(220.00000001, 10)).toBe(220)
  })
})

describe('pickTickIndices', () => {
  it('always includes the first and last index', () => {
    const indices = pickTickIndices(360, 4)
    expect(indices[0]).toBe(0)
    expect(indices[indices.length - 1]).toBe(359)
  })

  it('never exceeds the requested count and never duplicates', () => {
    const indices = pickTickIndices(360, 5)
    expect(indices.length).toBeLessThanOrEqual(5)
    expect(new Set(indices).size).toBe(indices.length)
  })

  it('handles degenerate inputs', () => {
    expect(pickTickIndices(0, 4)).toEqual([])
    expect(pickTickIndices(1, 4)).toEqual([0])
    expect(pickTickIndices(3, 1)).toEqual([0, 2])
    expect(pickTickIndices(2, 4)).toEqual([0, 1])
  })
})

describe('formatTick / formatValue', () => {
  it('scales precision to the unit', () => {
    expect(formatTick(220, 'V')).toBe('220 V')
    expect(formatTick(2.5, 'A')).toBe('2.50 A')
    expect(formatTick(3600, 'W')).toBe('3600 W')
  })

  it('formats values without a unit suffix', () => {
    expect(formatValue(219.44, 'V')).toBe('219.4')
    expect(formatValue(2.456, 'A')).toBe('2.46')
    expect(formatValue(360.04, 'W')).toBe('360.0')
  })
})

describe('toPaths', () => {
  it('returns one continuous path when there are no gaps', () => {
    const paths = toPaths([10, 11, 12], identityX, identityY)
    expect(paths).toEqual(['M0.00,10.00L10.00,11.00L20.00,12.00'])
  })

  it('splits into 3 runs for an interior-null series — the gap-vs-zero guarantee', () => {
    const paths = toPaths([10, null, 12, null, null, 14], identityX, identityY)
    expect(paths).toHaveLength(3)
    expect(paths[0]).toBe('M0.00,10.00')
    expect(paths[1]).toBe('M20.00,12.00')
    expect(paths[2]).toBe('M50.00,14.00')
  })

  it('never emits an L to a null', () => {
    const paths = toPaths([1, null, 3], identityX, identityY)
    for (const path of paths) {
      expect(path).not.toMatch(/null/)
    }
  })

  it('drops leading and trailing nulls rather than emitting empty paths', () => {
    const paths = toPaths([null, null, 5, 6, null], identityX, identityY)
    expect(paths).toEqual(['M20.00,5.00L30.00,6.00'])
  })

  it('returns nothing for an all-null or empty series', () => {
    expect(toPaths([null, null], identityX, identityY)).toEqual([])
    expect(toPaths([], identityX, identityY)).toEqual([])
  })

  it('treats a single point as a run', () => {
    expect(toPaths([null, 7, null], identityX, identityY)).toEqual(['M10.00,7.00'])
  })
})

describe('toAreaPath', () => {
  it('closes each run back down to the baseline', () => {
    const areas = toAreaPath([10, 20], identityX, identityY, 0)
    expect(areas).toHaveLength(1)
    expect(areas[0].endsWith('Z')).toBe(true)
    expect(areas[0]).toContain('M0.00,10.00')
    expect(areas[0]).toBe('M0.00,10.00L10.00,20.00L10.00,0.00L0.00,0.00Z')
  })
})

describe('seriesStats', () => {
  it('summarises a dense series', () => {
    expect(seriesStats([3, 1, 4, 1, 5])).toEqual({ min: 1, max: 5, last: 5, sum: 14 })
  })

  it('skips nulls instead of treating them as zero', () => {
    expect(seriesStats([2, null, 6, null])).toEqual({ min: 2, max: 6, last: 6, sum: 8 })
  })

  it('reports nulls for an empty or all-null series', () => {
    expect(seriesStats([])).toEqual({ min: null, max: null, last: null, sum: null })
    expect(seriesStats([null, null])).toEqual({ min: null, max: null, last: null, sum: null })
  })

  it('reports last as the final non-null value, not a trailing zero', () => {
    expect(seriesStats([7, 8, null]).last).toBe(8)
  })
})

describe('stalenessState', () => {
  const now = Date.parse('2026-10-02T12:00:00Z')
  const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000).toISOString()

  it('is fresh below 20 s', () => {
    expect(stalenessState(at(19.9), now, true).tone).toBe('fresh')
    expect(stalenessState(at(0), now, true).tone).toBe('fresh')
  })

  it('flips to delayed exactly at the 20 s boundary', () => {
    expect(stalenessState(at(20), now, true).tone).toBe('delayed')
  })

  it('stays delayed up to the 120 s boundary', () => {
    expect(stalenessState(at(119.9), now, true).tone).toBe('delayed')
  })

  it('flips to stale exactly at 120 s', () => {
    expect(stalenessState(at(120), now, true).tone).toBe('stale')
  })

  it('escalates a quiet device to stale even inside the delayed band', () => {
    expect(stalenessState(at(45), now, false).tone).toBe('stale')
  })

  it('reports stale when the device has never sent a sample', () => {
    expect(stalenessState(null, now, false).tone).toBe('stale')
    expect(stalenessState(null, now, false).label).toContain('No telemetry')
  })

  it('reports stale for an unparseable timestamp', () => {
    expect(stalenessState('not-a-date', now, true).tone).toBe('stale')
  })

  it('labels fresh data with its age', () => {
    expect(stalenessState(at(5), now, true).label).toBe('Live · 5 s ago')
  })
})

describe('formatRelative', () => {
  const now = Date.parse('2026-10-02T12:00:00Z')
  const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000).toISOString()

  it('formats seconds, minutes, hours and days', () => {
    expect(formatRelative(at(12), now)).toBe('12 s ago')
    expect(formatRelative(at(240), now)).toBe('4 min ago')
    expect(formatRelative(at(7200), now)).toBe('2 h ago')
    expect(formatRelative(at(172_800), now)).toBe('2 d ago')
  })

  it('returns an em dash for missing or invalid input', () => {
    expect(formatRelative(null, now)).toBe('—')
    expect(formatRelative('nonsense', now)).toBe('—')
  })
})

describe('backoffMs', () => {
  it('grows exponentially from 2 s and caps at 60 s', () => {
    expect(backoffMs(0)).toBe(2000)
    expect(backoffMs(1)).toBe(4000)
    expect(backoffMs(2)).toBe(8000)
    expect(backoffMs(10)).toBe(60_000)
  })
})

describe('describeSeries', () => {
  it('reports min, mean, max and sample sigma over present samples', () => {
    const stats = describeSeries([2, 4, 4, 4, 5, 5, 7, 9])
    expect(stats.count).toBe(8)
    expect(stats.min).toBe(2)
    expect(stats.max).toBe(9)
    expect(stats.mean).toBe(5)
    // Sample (n-1) sigma of this set is 2.13809...
    expect(stats.stddev).toBeCloseTo(2.13809, 5)
  })

  it('skips null gaps instead of treating them as zero load', () => {
    // The two nulls are relay-open gaps. Coercing them to 0 would drag the mean
    // from 10 down to 5.71 and understate the real draw.
    const stats = describeSeries([10, null, 10, null, 10])
    expect(stats.count).toBe(3)
    expect(stats.mean).toBe(10)
    expect(stats.stddev).toBe(0)
    expect(stats.min).toBe(10)
  })

  it('distinguishes a single sample from a perfectly steady series', () => {
    // sigma is null (not 0) at n=1: "no data" must not read as "perfectly steady".
    expect(describeSeries([7]).stddev).toBeNull()
    expect(describeSeries([7, 7, 7]).stddev).toBe(0)
  })

  it('returns nulls for an entirely empty series', () => {
    expect(describeSeries([null, null])).toEqual({
      count: 0,
      min: null,
      max: null,
      mean: null,
      stddev: null,
    })
  })
})

describe('histogram', () => {
  it('buckets samples and excludes nulls from every bin', () => {
    const result = histogram([0, 1, 2, 3, null, null], 3)
    expect(result).not.toBeNull()
    // Range 0..3 over 3 bins of width 1: {0,1} {2} {3}
    expect(result?.counts.reduce((a, b) => a + b, 0)).toBe(4)
    expect(result?.min).toBe(0)
    expect(result?.max).toBe(3)
  })

  it('returns null when the channel reported nothing at all', () => {
    expect(histogram([null, null], 12)).toBeNull()
  })

  it('collapses a flat nominal rail into one bin instead of dividing by zero', () => {
    // A 5 V USB rail reports a constant rating; edges must stay finite.
    const result = histogram([5, 5, 5], 12)
    expect(result?.counts).toEqual([3])
    expect(Number.isFinite(result?.min)).toBe(true)
    expect(Number.isFinite(result?.max)).toBe(true)
  })

  it('never drops a value sitting exactly at the maximum', () => {
    const result = histogram([0, 5, 10], 2)
    expect(result?.counts.reduce((a, b) => a + b, 0)).toBe(3)
  })
})
