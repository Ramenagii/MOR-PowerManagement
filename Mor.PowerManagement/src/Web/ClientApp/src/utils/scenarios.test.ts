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

const rig: Outlet[] = [
  outlet(1, 520, 'Active', 'Low'),
  outlet(2, 500, 'Active', 'Low'),
  outlet(3, 420, 'Active', 'Medium'),
  outlet(4, 330, 'Active', 'Medium'),
  outlet(5, 150, 'Standby', 'High'),
  outlet(6, 0, 'Disconnected', 'Critical'),
  outlet(10, 8, 'Active', 'Low', 5),
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
    const profile = selectiveProfile(rig, 2)
    const { readings, relayStates } = buildScenarioPayload(rig, profile)

    // selectiveProfile picks the two lowest-priority energized channels.
    expect(profile.shed).toEqual([1, 2])
    for (const id of profile.shed) {
      expect(readings.find((r) => r.outletId === id)?.powerWatts).toBe(0)
      expect(relayStates.find((r) => r.outletId === id)?.relayClosed).toBe(false)
    }
  })

  it('sheds the lowest priority first, never a High or Critical channel', () => {
    const profile = selectiveProfile(rig, 2)
    expect(profile.shed).not.toContain(5) // High
    expect(profile.shed).not.toContain(6) // Critical
  })

  it('leaves an already-disconnected channel de-energized under normal operation', () => {
    const { readings, relayStates } = buildScenarioPayload(rig, normalProfile(rig))
    expect(readings.find((r) => r.outletId === 6)?.powerWatts).toBe(0)
    expect(relayStates.find((r) => r.outletId === 6)?.relayClosed).toBe(false)
  })

  it('derives current from the channel rail, so the same draw needs more amps on a low rail', () => {
    // Equal power on two different rails. Comparing the rig's own channels would
    // prove nothing: CH1 draws 520 W and CH10 draws 8 W, so their currents are
    // not comparable. The claim under test is I = P / V for a fixed P.
    const equalDraw = [outlet(1, 100, 'Active', 'Low', 220), outlet(10, 100, 'Active', 'Low', 5)]
    const { readings } = buildScenarioPayload(equalDraw, {
      loadFactor: 1,
      energize: [1, 10],
      shed: [],
      overloadWatts: 0,
      overloadChannel: 6,
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