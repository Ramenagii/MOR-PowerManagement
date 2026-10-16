import type { Ina226Reading } from '../api'
import { DASHBOARD_TIPS } from '../data/dashboard'
import {
  INA226_SHUNT_FULL_SCALE_MV,
  ina226Freshness,
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
  if (amps < 1) return amps.toFixed(4)
  return amps < 10 ? amps.toFixed(3) : amps.toFixed(1)
}

function formatWatts(watts: number): string {
  if (watts < 1) return watts.toFixed(3)
  return watts < 10 ? watts.toFixed(2) : watts.toFixed(1)
}

/**
 * The DC path measured by the INA226. It connects to the ESP32 over I²C; the
 * bus voltage and shunt current come from the INA226 itself, not the CT ADC.
 *
 * A DEVICE CONSTANT in the same sense as the shunt's full scale: it describes
 * how the hardware was wired, not what it is currently reading, so it is
 * allowed to be a constant while every figure on the card stays nullable. The
 * reference sketch prints the same label in its own telemetry block —
 * `--- DC TELEMETRY (INA226)` — which is where the wording comes from.
 */
const DC_RAIL_LABEL = 'DC rail'

/** Which of the three headline figures the sample did not carry. */
function missingFigures(reading: Ina226Reading): string[] {
  const gaps: string[] = []
  if (reading.busVolts === null) gaps.push('bus volts')
  if (reading.currentAmps === null) gaps.push('current')
  if (reading.powerWatts === null) gaps.push('power')
  return gaps
}

/**
 * The INA226 connected directly to the ESP32 over I²C.
 *
 * This is a DC shunt measurement, separate from the mains CT branches. The INA226
 * is polled by the ESP32 over I²C; its bus voltage and shunt current do not come
 * from the ADS1220 CT channels. It mattered because the card also
 * claimed to be the only volts/amps pair CH5 had — so a 5 V USB socket was
 * displaying a number from the INA226 as if it were the USB socket's source.
 *
 * What the card is for is unchanged, and it is still the only place three
 * headline figures can be checked against each other: the converter measures
 * volts and shunt millivolts as separate conversions and multiplies them for its
 * power channel, so V x I and the reported watts are two answers to the same
 * question. The shunt rail and the reconciliation line at the foot exist to make
 * that comparison visible.
 *
 * The single rule, enforced once in `measured` below: outside a fresh, complete
 * sample every figure reads 0. Not the rated rail, not the last value seen, not
 * a dash that parses as a number. A 0 here is explicitly labelled as
 * "unmeasured", because 0 V on the rail and "nobody answered" are opposite
 * findings and the console has to be able to tell them apart.
 */
export function Ina226Card({ reading, live, now }: Ina226CardProps) {
  const { freshness, ageSeconds } = ina226Freshness(reading.sampledAt, now)
  const gaps = missingFigures(reading)

  // "Measured" needs all four: a reachable backend, a sample inside the 30 s
  // window, and all three headline figures actually present. A 2 s old sample
  // that omits bus volts is a partial read, and printing 0.0 V beside it would
  // claim the rail is dead.
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

  return (
    <section
      className={`mp-card ina${measured ? '' : ' is-off'}`}
      aria-label="INA226 DC rail sensor"
    >
      <div className="ina-h">
        {/*
          The rail is named in the heading, not only in the tooltip. It used to
          carry no rail at all, which left "bus volts" on screen with nothing
          telling the reader whether it was AC or DC — and the
          figure itself cannot say, because 3.30 is a perfectly good voltage on
          either. Two words in the heading is the cheapest way to make the number
          below it mean one thing.
        */}
        <b title={DASHBOARD_TIPS.ina226}>{`INA226 · ${DC_RAIL_LABEL} · ${state}`}</b>
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
          <div className="k">Rail volts</div>
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
            {formatWatts(watts)}
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
      {!measured && <p className="ina-note">
        {!live ? (
          <><b>Offline.</b> No live reading.</>
        ) : freshness === 'unmeasured' ? (
          <><b>No sample.</b> Check the ESP32 I²C connection.</>
        ) : freshness === 'stale' ? (
          <><b>Stale.</b> Sample is {`${Math.round(ageSeconds ?? 0)} s`} old.</>
        ) : gaps.length > 0 ? (
          <><b>Incomplete.</b> Missing {gaps.join(', ')}.</>
        ) : null}
      </p>}

      {/*
        The reason the other figures on this page are the figures they are — and
        the explicit statement of what this card is NOT, which is the half that
        used to be wrong.

        It used to read: "Feeds outlet 5 (USB 5 V) — the only volts and amps pair
        that row has — and is the 220 V bus reference behind outlets 1–4." That
        was two claims and both were false on this hardware. The converter is on
        a DC shunt path: it cannot measure the AC feed, and it is not the CT
        interface. The card was being cited as the source for numbers it had
        never produced, which is how unrelated readings ended up mixed together.

        So the statement is now the honest inverse. This card is standalone: the
        four mains branches derive their amps against the server's own mains
        reference (`mainsVolts`), CH5 has no converter at all, and neither of
        those reads one figure from this card. That is a sentence about absence,
        and it belongs on the card — otherwise the operator is left to assume the
        two are connected, which is exactly the assumption that put a DC reading
        in a mains column.
      */}
    </section>
  )
}
