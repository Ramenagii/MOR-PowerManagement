import { describe, expect, it } from 'vitest'
import type { Outlet, OutletStatus, Priority } from '../types/dashboard'
import {
  buildScenarioPayload,
  capacityBlockProfile,
  idleProfile,
  normalProfile,
  overloadProfile,
  selectiveProfile,
} from './scenarios'

/** Minimal outlet fixture. `volts` drives the derived current, so it matters. */
function outlet(id: number, watts: number, status: OutletStatus, priority: Priority, volts = 220): Outlet {
  return {
    id,
    name: `Outlet ${id}`,
    role: 'fixture',
    meter: 'PZEM-004T v3.0',
    relay: `GPIO${id}`,
    priority,
    allowance: 500,
    volts,
    watts,
    status,
    schedule: 'Always on',
    idleLimit: '30 min',
  }
}

/**
 * The trimmed testing rig: two 220 V mains channels (CH1 260 W, CH2 180 W).
 * Priorities differ so the selective-response ordering still has something to
 * rank: CH1 is the Critical channel that must survive, CH2 the Medium one.
 */
const rig: Outlet[] = [
  outlet(1, 260, 'Active', 'Critical'),
  outlet(2, 180, 'Active', 'Medium'),
]

const sum = (readings: Array<{ powerWatts: number }>) => readings.reduce((t, r) => t + r.powerWatts, 0)

describe('buildScenarioPayload', () => {
  it('emits one reading and one relay report per outlet', () => {
    const { readings, relayStates } = buildScenarioPayload(rig, normalProfile(rig))
    expect(readings).toHaveLength(rig.length)
    expect(relayStates).toHaveLength(rig.length)
    expect(readings.map((r) => r.outletId)).toEqual(relayStates.map((r) => r.outletId))
  })

  it('keeps every value inside the range the server validates', () => {
    // The server rejects voltage outside 0-300, current outside 0-100 and
    // power outside 0-5000. A scenario that trips its own 400 looks broken.
    const { readings } = buildScenarioPayload(rig, overloadProfile(rig))
    for (const sample of readings) {
      expect(sample.voltage).toBeGreaterThanOrEqual(0)
      expect(sample.voltage).toBeLessThanOrEqual(300)
      expect(sample.currentAmps).toBeGreaterThanOrEqual(0)
      expect(sample.currentAmps).toBeLessThanOrEqual(100)
      expect(sample.powerWatts).toBeGreaterThanOrEqual(0)
      expect(sample.powerWatts).toBeLessThanOrEqual(5000)
      expect(sample.energyKwh).toBeGreaterThanOrEqual(0)
    }
  })

  it('injects the overload only on its nominated channel', () => {
    const profile = overloadProfile(rig)
    const { readings } = buildScenarioPayload(rig, profile)
    const onChannel = readings.find((r) => r.outletId === profile.overloadChannel)
    const others = readings.filter((r) => r.outletId !== profile.overloadChannel)

    // The overload channel carries the extra watts; no other channel does.
    expect(onChannel?.powerWatts).toBeGreaterThan(others[0].powerWatts)
    for (const other of others) {
      const source = rig.find((o) => o.id === other.outletId)
      expect(other.powerWatts).toBe(Math.round((source?.watts ?? 0) * profile.loadFactor))
    }
  })

  it('drives a shed channel to zero watts with its relay open', () => {
    const profile = selectiveProfile(rig)
    const { readings, relayStates } = buildScenarioPayload(rig, profile)

    // selectiveProfile picks the lowest-priority energized channel of the pair.
    expect(profile.shed).toEqual([2])
    for (const id of profile.shed) {
      expect(readings.find((r) => r.outletId === id)?.powerWatts).toBe(0)
      expect(relayStates.find((r) => r.outletId === id)?.relayClosed).toBe(false)
    }
    // The channel that was not shed stays energized at its rated draw.
    expect(readings.find((r) => r.outletId === 1)?.powerWatts).toBe(260)
    expect(relayStates.find((r) => r.outletId === 1)?.relayClosed).toBe(true)
  })

  it('sheds the lowest priority first, never a High or Critical channel', () => {
    const profile = selectiveProfile(rig)
    expect(profile.shed).not.toContain(1) // Critical
  })

  it('keeps every energized channel live at its rated draw under normal operation', () => {
    const { readings, relayStates } = buildScenarioPayload(rig, normalProfile(rig))
    expect(readings.find((r) => r.outletId === 1)?.powerWatts).toBe(260)
    expect(readings.find((r) => r.outletId === 2)?.powerWatts).toBe(180)
    expect(relayStates.every((r) => r.relayClosed)).toBe(true)
  })

  it('derives current from the channel rail, so the same draw needs more amps on a low rail', () => {
    // Equal power on two different rails. Comparing the rig's own channels would
    // prove nothing: both rig channels sit on the same 220 V rail, so their
    // currents are not comparable. The claim under test is I = P / V for a
    // fixed P, checked against a synthetic 5 V USB branch.
    const equalDraw = [outlet(1, 100, 'Active', 'Low', 220), outlet(10, 100, 'Active', 'Low', 5)]
    const { readings } = buildScenarioPayload(equalDraw, {
      loadFactor: 1,
      energize: [1, 10],
      shed: [],
      overloadWatts: 0,
      overloadChannel: 1,
    })
    const mains = readings.find((r) => r.outletId === 1)
    const usb = readings.find((r) => r.outletId === 10)

    expect(mains?.powerWatts).toBe(usb?.powerWatts)
    expect(usb?.currentAmps).toBeGreaterThan(mains?.currentAmps ?? 0)
    expect(usb?.currentAmps).toBeCloseTo((usb?.powerWatts ?? 0) / 5, 5)
    expect(mains?.currentAmps).toBeCloseTo((mains?.powerWatts ?? 0) / 220, 5)
  })

  it('never divides by a zero rail and produce NaN', () => {
    const broken = [outlet(1, 100, 'Active', 'Low', 0)]
    const { readings } = buildScenarioPayload(broken, normalProfile(broken))
    expect(Number.isFinite(readings[0].currentAmps)).toBe(true)
    expect(Number.isFinite(readings[0].voltage)).toBe(true)
  })

  it('raises the total above the pre-activation baseline on overload', () => {
    const base = sum(buildScenarioPayload(rig, normalProfile(rig)).readings)
    const over = sum(buildScenarioPayload(rig, overloadProfile(rig)).readings)
    expect(over).toBeGreaterThan(base)
  })

  it('drops the total on idle shutdown rather than raising it', () => {
    const base = sum(buildScenarioPayload(rig, normalProfile(rig)).readings)
    const idle = sum(buildScenarioPayload(rig, idleProfile(rig)).readings)
    expect(idle).toBeLessThan(base)
  })

  it('rests the capacity-block profile below the overload profile', () => {
    const blocked = sum(buildScenarioPayload(rig, capacityBlockProfile(rig)).readings)
    const over = sum(buildScenarioPayload(rig, overloadProfile(rig)).readings)
    expect(blocked).toBeLessThan(over)
  })
})