import type { Ina226Reading } from '../api'
import { DASHBOARD_TIPS } from '../data/dashboard'
import {
  INA226_SHUNT_FULL_SCALE_MV,
  ina226Freshness,
  reconcilePower,
  shuntFillPercent,
} from '../utils/telemetry'

type Ina226CardProps = {
  reading: Ina226Reading
  /**
   * The dashboard's single honesty switch — false when GET /Dashboard/state has
   * not answered. Reused rather than re-derived: the OFFLINE banner in
   * DashboardHero already states that condition, and a second, differently-
   * worded version of it would be a second thing for the operator to reconcile.
   */
  live: boolean
  /** Ticking clock from the dashboard, so the freshness pill moves every second. */
  now: number
}

/** Below 10 A the third decimal is the reading; above it, the third is noise. */
function formatAmps(amps: number): string {
  return amps < 10 ? amps.toFixed(3) : amps.toFixed(1)
}

/** Which of the three headline figures the sample did not carry. */
function missingFigures(reading: Ina226Reading): string[] {
  const gaps: string[] = []
  if (reading.busVolts === null) gaps.push('bus volts')
  if (reading.currentAmps === null) gaps.push('current')
  if (reading.powerWatts === null) gaps.push('power')
  return gaps
}

/**
 * The INA226 on the common mains feed.
 *
 * This is the only current sensor on the rig that is not a branch CT, and it is
 * the only card whose headline numbers are all direct conversions rather than
 * share-of-a-total arithmetic. So it is also the only place where the three
 * figures can be checked against each other — which is what the shunt rail and
 * the reconciliation line at the foot exist to do.
 *
 * The single rule, enforced once in `measured` below: outside a fresh, complete
 * sample every figure reads 0. Not the rated rail, not the last value seen, not
 * a dash that parses as a number. A 0 here is explicitly labelled as
 * "unmeasured", because 0 V on the bus and "nobody answered" are opposite
 * findings and the console has to be able to tell them apart.
 */
export function Ina226Card({ reading, live, now }: Ina226CardProps) {
  const { freshness, ageSeconds } = ina226Freshness(reading.sampledAt, now)
  const gaps = missingFigures(reading)

  // "Measured" needs all four: a reachable backend, a sample inside the 30 s
  // window, and all three headline figures actually present. A 2 s old sample
  // that omits bus volts is a partial read, and printing 0.0 V beside it would
  // claim the bus is dead.
  const measured = live && freshness === 'live' && gaps.length === 0

  const bus = measured && reading.busVolts !== null ? reading.busVolts : 0
  const amps = measured && reading.currentAmps !== null ? reading.currentAmps : 0
  const watts = measured && reading.powerWatts !== null ? reading.powerWatts : 0
  const shunt = measured && reading.shuntMillivolts !== null ? reading.shuntMillivolts : 0

  // The three states the title can name. "· live" is the reference label; the
  // other two exist so the word beside the device name is never a reassurance
  // the reading does not support.
  const state = !live
    ? 'offline'
    : freshness === 'unmeasured'
      ? 'unmeasured'
      : freshness === 'stale'
        ? 'stale'
        : gaps.length > 0
          ? 'partial'
          : 'live'

  const dotClass = state === 'live' ? 'live' : state === 'stale' ? 'warn' : 'off'

  // The pill names the same state as the heading. It used to be a single
  // `Live · {age}` string regardless, so a 4-minute-old sample would have been
  // announced as live — the label contradicting the figure three inches below it.
  const ageText = ageSeconds === null ? '' : ` · ${Math.round(ageSeconds)} s`
  const pillText =
    state === 'live' ? `Live${ageText}` : state === 'stale' ? `Stale${ageText}` : null
  const pillFallback =
    state === 'offline' ? 'Offline' : state === 'partial' ? `Partial${ageText}` : 'No sample'

  const reconcile = measured ? reconcilePower(bus, amps, watts) : null

  return (
    <section
      className={`mp-card ina${measured ? '' : ' is-off'}`}
      aria-label="INA226 mains sensor"
    >
      <div className="ina-h">
        <b title={DASHBOARD_TIPS.ina226}>{`INA226 · ${state}`}</b>
        <span className="mp-pill num" style={{ padding: '2px 9px' }}>
          <span className={`dot ${dotClass}`} />
          {pillText ?? pillFallback}
        </span>
      </div>

      {/* The three headline figures. One decimal place on volts and power, three
          on current: the shunt makes small currents legible and rounding them
          away is the same mistake as printing the rated rail. */}
      <div className="ina-figs">
        <div className="ina-fig">
          <div className="v">
            {bus.toFixed(1)}
            <small>V</small>
          </div>
          <div className="k">Bus volts</div>
        </div>
        <div className="ina-fig">
          <div className="v">
            {formatAmps(amps)}
            <small>A</small>
          </div>
          <div className="k">Current</div>
        </div>
        <div className="ina-fig">
          <div className="v">
            {watts.toFixed(1)}
            <small>W</small>
          </div>
          <div className="k">Power</div>
        </div>
      </div>

      {/*
        The shunt rail. Current on this rig is measured the way the INA226
        measures it — as millivolts across a 100 mV shunt — so the honest way to
        present the number is as a position inside the converter's own input
        range rather than as a bare "3.21 mV" that tells the reader nothing about
        whether it is plausible.
      */}
      <div className="shunt">
        <div
          className="shunt-track"
          role="meter"
          aria-valuenow={Number(shunt.toFixed(2))}
          aria-valuemin={0}
          aria-valuemax={INA226_SHUNT_FULL_SCALE_MV}
          aria-label={`Shunt drop ${shunt.toFixed(2)} millivolts of ${INA226_SHUNT_FULL_SCALE_MV} millivolt full scale`}
        >
          <i style={{ width: `${measured ? shuntFillPercent(shunt) : 0}%` }} />
        </div>
        <div className="shunt-cap num">
          <span>{`${shunt.toFixed(2)} mV shunt drop`}</span>
          <span>{`${INA226_SHUNT_FULL_SCALE_MV} mV full scale`}</span>
        </div>
      </div>

      {/*
        The reason the figures above are what they are. One line, always present
        when the card is not measuring, because a 0 with no stated cause is
        indistinguishable from a real 0 at a glance and completely
        indistinguishable from a distance.
      */}
      <p className="ina-note">
        {!live ? (
          <>
            <b>Offline.</b> GET /api/Dashboard/state did not answer, so no INA226 reading is being
            displayed. The figures above are 0 because nothing was measured — not because the bus is
            dead.
          </>
        ) : freshness === 'unmeasured' ? (
          <>
            <b>Unmeasured.</b> The device has not posted an INA226 sample. The figures above are 0
            because nothing was measured. Check the converter on SDA GPIO 8 / SCL GPIO 9.
          </>
        ) : freshness === 'stale' ? (
          <>
            <b>Stale.</b> Newest sample is {`${Math.round(ageSeconds ?? 0)} s`} old and anything past 30
            s is treated as unmeasured, so the figures above are 0. The rig was answering and has
            stopped.
          </>
        ) : gaps.length > 0 ? (
          <>
            <b>Partial.</b> The {`${Math.round(ageSeconds ?? 0)} s`} old sample left {gaps.join(', ')}{' '}
            empty, and an absent field is not a reading — so the whole card drops to 0 rather than
            mixing a real figure with a placeholder that would look like one.
          </>
        ) : (
          <>
            Bus volts x current = {`${reconcile?.computedWatts.toFixed(1)} W`} against the{' '}
            {`${watts.toFixed(1)} W`} the converter reported ({`${reconcile?.deltaPercent.toFixed(2)}`}%{' '}
            apart). The two are separate conversions on the same chip, so a small gap is expected — a
            large one is a failing converter.
          </>
        )}
      </p>

      {/*
        What this card feeds, stated once and always — including when the card is
        unmeasured, because "these are 0 because nothing was measured" and "these
        0 are what the USB row is currently showing" are the same failure twice.
        CH5 has no CT and no converter of its own, so the volts/amps pair on that
        row comes from here and from nowhere else; CH1-CH4 derive their branch
        amps against this bus reference. The card sits directly above the roster
        and used to say nothing about the branches that depend on it, which left
        four rows and one USB row reading as if they were independent of it.
      */}
      <p className="ina-note num">
        Feeds outlet 5 (USB 5 V) — the only volts and amps pair that row has — and is the 220 V bus
        reference behind outlets 1–4.
      </p>
    </section>
  )
}