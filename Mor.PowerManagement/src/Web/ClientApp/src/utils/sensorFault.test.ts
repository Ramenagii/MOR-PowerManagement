import { describe, expect, it } from 'vitest'
import {
  detectSensorFault,
  faultConsequence,
  isReadingSuppressed,
  type SensorFault,
} from './sensorFault'
import type { EventLog } from '../types/dashboard'

/**
 * These tests exist because this is the one piece of logic in the console where
 * a wrong answer looks exactly like a right one. The rig posts 0 W on every
 * channel; a faulted rig and an idle rig produce the same telemetry. The only
 * thing separating "the bench is idle" from "the bench is blind" is the event
 * record, so the record has to be read correctly — including its failure
 * modes.
 */

const NOW = Date.parse('2026-10-13T03:30:00Z')

function event(over: Partial<EventLog> & Pick<EventLog, 'title' | 'severity'>): EventLog {
  return {
    id: 1,
    time: '03:02',
    detail: '',
    ...over,
  } as EventLog
}

/** Verbatim shape the backend currently returns for POL-01. */
const POL01: EventLog = event({
  id: 9,
  title: 'Hardware fault isolation',
  detail: 'S_fault is TRUE: all relays restricted and the prototype isolated (POL-01).',
  severity: 'critical',
  at: '2026-10-13T03:02:32.913461+00:00',
})

describe('detectSensorFault', () => {
  it('finds the latched fault from the backend event and its own ISO stamp', () => {
    const fault = detectSensorFault({
      events: [POL01],
      deviceOnline: true,
      channelCount: 5,
      now: NOW,
    })

    expect(fault).not.toBeNull()
    expect(fault?.state).toBe('faulted')
    expect(fault?.historical).toBe(false)
    expect(fault?.devicePosting).toBe(true)
    expect(fault?.channelsAffected).toBe(5)
    // 03:02:32 -> 03:30:00 is 27 whole minutes.
    expect(fault?.minutesAgo).toBe(27)
  })

  it('renders the backend sentence verbatim rather than paraphrasing it', () => {
    const fault = detectSensorFault({
      events: [POL01],
      deviceOnline: true,
      channelCount: 5,
      now: NOW,
    })
    expect(fault?.detail).toBe(POL01.detail)
    expect(fault?.title).toBe('Hardware fault isolation')
  })

  it('matches the fault on the detail as well as the title', () => {
    // A future backend that rewords the title but keeps POL-01 in the body must
    // not silently stop the console from seeing its own fault.
    const worded: EventLog = event({
      title: 'Rig isolated',
      detail: 'Prototype isolated under POL-01.',
      severity: 'critical',
      at: '2026-10-13T03:29:00Z',
    })
    expect(
      detectSensorFault({ events: [worded], deviceOnline: true, channelCount: 5, now: NOW }),
    ).not.toBeNull()
  })

  it('ignores fault wording at a non-critical severity', () => {
    // Over-matching is the failure that would cry wolf on every ordinary event.
    expect(
      detectSensorFault({
        events: [event({ title: 'Hardware fault isolation', severity: 'info' })],
        deviceOnline: true,
        channelCount: 5,
        now: NOW,
      }),
    ).toBeNull()
  })

  it('returns null when the record holds no fault at all', () => {
    expect(
      detectSensorFault({
        events: [event({ title: 'Outlet activation allowed', severity: 'success' })],
        deviceOnline: true,
        channelCount: 5,
        now: NOW,
      }),
    ).toBeNull()
  })

  it('shifts to the historical wording rather than claiming a fresh fault', () => {
    const fault = detectSensorFault({
      events: [POL01],
      deviceOnline: false,
      channelCount: 5,
      // Four hours later.
      now: NOW + 4 * 60 * 60 * 1000,
    })
    expect(fault?.historical).toBe(true)
    expect(fault?.state).toBe('stale')
    expect(fault?.devicePosting).toBe(false)
  })

  it('survives an unparseable stamp instead of claiming a bogus age', () => {
    const fault = detectSensorFault({
      events: [event({ ...POL01, at: 'not-a-date' })],
      deviceOnline: true,
      channelCount: 5,
      now: NOW,
    })
    expect(fault).not.toBeNull()
    expect(fault?.minutesAgo).toBeNull()
    expect(fault?.at).toBeNull()
  })

  it('never reports a negative age when the event clock runs ahead of the browser', () => {
    const fault = detectSensorFault({
      events: [POL01],
      deviceOnline: true,
      channelCount: 5,
      now: Date.parse('2026-10-13T03:00:00Z'),
    })
    expect(fault?.minutesAgo).toBe(0)
  })
})

describe('isReadingSuppressed', () => {
  it('suppresses exactly when a fault is in the record', () => {
    expect(isReadingSuppressed(null)).toBe(false)
    const fault = detectSensorFault({
      events: [POL01],
      deviceOnline: true,
      channelCount: 5,
      now: NOW,
    }) as SensorFault
    expect(isReadingSuppressed(fault)).toBe(true)
  })
})

describe('faultConsequence', () => {
  it('names the count and says the zeros are not an idle rig', () => {
    const fault = detectSensorFault({
      events: [POL01],
      deviceOnline: true,
      channelCount: 5,
      now: NOW,
    }) as SensorFault
    const text = faultConsequence(fault)
    expect(text).toContain('5 channels')
    expect(text).toContain('not an idle rig')
    expect(text).toContain('no reading')
  })

  it('agrees with itself on a single-channel rig', () => {
    const fault = detectSensorFault({
      events: [POL01],
      deviceOnline: true,
      channelCount: 1,
      now: NOW,
    }) as SensorFault
    expect(faultConsequence(fault)).toContain('1 channel')
  })
})