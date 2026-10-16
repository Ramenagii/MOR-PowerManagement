import { useMemo } from 'react'
import type { Outlet } from '../types/dashboard'
import { DASHBOARD_TIPS, isMonitoredOnlyChannel, relayGpio } from '../data/dashboard'
import { isEnergizedOutlet } from '../utils/dashboard'
import { buildPath } from './DashboardHero'

type DashboardOutletProps = {
  outlet: Outlet
  /** Recorded watt buckets for this branch, oldest first. */
  history: Array<number | null>
  live: boolean
  /** Live INA226 mains volts; null when the device has nothing fresh. */
  mainsVolts: number | null
  busy: boolean
  onToggle: (id: number) => void
}

const SPARK_W = 400
const SPARK_H = 64

/** Priority -> the reference's tag classes. Critical and High are the two the
 *  mock colours; everything below that stays neutral so the grid does not fill
 *  up with chips that mean nothing operationally. */
const TAG_CLASS: Record<Outlet['priority'], string> = {
  Critical: 'tag crit',
  High: 'tag high',
  Medium: 'tag mid',
  Low: 'tag mid',
}

/**
 * One controlled channel, laid out as the reference's five-column row:
 *   [identity + tag] [watts] [sparkline] [allocation] [switch]
 *
 * The 4px rail down the left edge (the row's ::before) is the only place the
 * energized state is expressed as colour, and it greys out with the whole row
 * when the branch is open — so "off" dims the card instead of drawing a second
 * badge that would compete with the switch.
 *
 * Amps is DERIVED. State returns watts and the live INA226 mains volts, so the
 * figure is P / V at an assumed power factor of 1. The tooltip says which volts
 * it used; it is never presented as a direct CT reading. With no live volts
 * there is no honest value for either half of the pair, and the row says 0
 * rather than quoting the rated rail back as if it had been measured.
 *
 * CH5 is the one row that is not a controlled channel. It is a 5 V USB socket
 * with no relay behind it, so it renders the same five columns — a bench reads
 * as one list, and a USB socket that looks like a different product from a mains
 * outlet is a worse answer than one that says plainly what it is — but the
 * switch is disabled with the reason on it. A control that cannot write must not
 * look writable, and POSTing a disconnection for a branch with no relay would
 * return a success that changed nothing on the bench.
 */
export function DashboardOutlet({ outlet, history, live, mainsVolts, busy, onToggle }: DashboardOutletProps) {
  const monitorOnly = isMonitoredOnlyChannel(outlet.id)
  const on = live && (monitorOnly || isEnergizedOutlet(outlet.status))

  const peak = useMemo(() => {
    let max = 0
    for (const value of history) {
      if (value !== null && Number.isFinite(value) && value > max) max = value
    }
    return max
  }, [history])

  const allowance = outlet.allowance
  const effWatts = live ? outlet.watts : 0
  const usedPercent = allowance > 0 ? (effWatts / allowance) * 100 : 0
  const over = live && allowance > 0 && outlet.watts > allowance

  // Sparkline is scaled against the branch's own allocation, so a 40 W branch
  // and a 300 W branch each fill their own box proportionally and the operator
  // reads utilisation rather than absolute size.
  const sparkScale = Math.max(allowance, peak, 1)

  const hasSpark = history.some((v) => v !== null && Number.isFinite(v))
  // The sparkline keeps its own 0-based domain against the branch allocation.
  // buildPath now takes an explicit domain because the hero needs a fitted one;
  // this is the zero-based case of that same signature.
  const sparkDomain = { min: 0, max: sparkScale }
  const area = hasSpark ? buildPath(history, SPARK_W, SPARK_H, sparkDomain, true) : ''
  const line = hasSpark ? buildPath(history, SPARK_W, SPARK_H, sparkDomain, false) : ''

  // The allocation rule the reference draws at half scale, positioned properly:
  // the mock passes an absolute y of ALLOC/2 into a 64-unit viewBox, which puts
  // it off-canvas and invisible. This computes the same rule in view space.
  const limitY = hasSpark
    ? SPARK_H - Math.min((allowance / 2 / sparkScale), 1) * (SPARK_H - 4) - 2
    : null

  // Live INA226 mains when the device is reporting; nothing otherwise.
  //
  // This used to fall back to `outlet.volts` — the channel's RATED rail — so a
  // rig with no fresh converter read "220.0 V · 0.00 A" on every row: a
  // configuration fact sitting in a column of measurements, indistinguishable
  // from a real 220.0 V sample, and the reason a dead converter still produced a
  // plausible-looking dashboard. With no live reference the pair now reads 0 and
  // the tooltip says why.
  //
  // CH5 derives from the same INA226 bus sample and no other source, because it
  // has no converter of its own. The tooltip on that row says the volts are the
  // bus it is fed from and not a sample taken at the socket, so the 5 V rail is
  // never mistaken for a 220 V measurement.
  const voltsLive = live && mainsVolts !== null && mainsVolts > 0
  const shownVolts = voltsLive ? mainsVolts : 0
  const amps = voltsLive && effWatts > 0 ? effWatts / shownVolts : 0
  const wattsText = Math.round(effWatts).toLocaleString()
  const vaText = `${shownVolts.toFixed(1)} V · ${amps.toFixed(2)} A`

  const vaTitle = monitorOnly
    ? DASHBOARD_TIPS.usb
    : voltsLive
      ? 'Live INA226 mains volts; branch amps derived as P / V at PF 1'
      : 'No fresh INA226 bus volts, so there is no reference to derive against and the rated rail is deliberately not substituted — both figures read 0'

  return (
    <article
      className={`mp-card row ${on ? '' : 'off'}`}
      aria-label={`${outlet.name}, ${monitorOnly ? 'monitored only, no relay' : on ? 'energized' : 'open'}, ${wattsText} watts`}
    >
      {/* 1 — identity + priority tag */}
      <div className="idcol">
        <b>{`${`CH${String(outlet.id).padStart(2, '0')}`} · ${outlet.name}`}</b>
        <div className="meta num" title={monitorOnly ? DASHBOARD_TIPS.usb : `Relay ${outlet.relay} on ${relayGpio(outlet.id)}`}>
          {monitorOnly ? '5 V USB · monitored' : relayGpio(outlet.id)}
        </div>
        <span
          className={`tag ${TAG_CLASS[outlet.priority]}`}
          title={
            monitorOnly
              ? `${outlet.priority} priority on the rail, but there is no relay to shed: the framework ranks it first and can do nothing with it`
              : `Shed order: ${outlet.priority} priority`
          }
        >
          {outlet.priority}
        </span>
      </div>

      {/* 2 — the figure */}
      <div>
        <div className="w">
          {wattsText}
          <small>W</small>
        </div>
        <div className="va num" title={vaTitle}>
          {vaText}
        </div>
      </div>

      {/* 3 — sparkline */}
      <div className="spark">
        <svg
          viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`${outlet.name} power trend, last 15 minutes`}
        >
          {hasSpark ? (
            <>
              {limitY !== null && (
                <line
                  x1="0"
                  x2={SPARK_W}
                  y1={limitY}
                  y2={limitY}
                  stroke="var(--warn)"
                  strokeDasharray="5 4"
                  strokeWidth="1.2"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              <path d={area} fill="var(--live)" opacity=".12" />
              <path
                d={line}
                fill="none"
                stroke="var(--live)"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
              />
            </>
          ) : (
            <line x1="0" x2={SPARK_W} y1={SPARK_H / 2} y2={SPARK_H / 2} stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          )}
        </svg>
      </div>

      {/* 4 — allocation */}
      <div className="alloc">
        <div className="top">
          <span>Allocation</span>
          <b className="num">{`${Math.round(effWatts).toLocaleString()} / ${Math.round(allowance).toLocaleString()} W`}</b>
        </div>
        <div
          className="meter"
          role="meter"
          aria-valuenow={Math.round(usedPercent)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${outlet.name} load against its allocation`}
        >
          <i style={{ width: `${Math.min(usedPercent, 100)}%`, background: over ? 'var(--bad)' : undefined }} />
        </div>
        <div className="pk num">
          {`Peak ${Math.round(live ? peak : 0).toLocaleString()} W · ${Math.round(usedPercent)}% used`}
        </div>
      </div>

      {/* 5 — switch */}
      {/*
        Disabled on CH5, and disabled for its own reason rather than sharing the
        "backend unreachable" one: that reason would be wrong, and an operator
        retrying an unreachable server to bring a socket up would be chasing a
        fault that does not exist. `aria-pressed` is omitted rather than set,
        because a control that cannot be pressed has no pressed state to report —
        the row's rail and the label above the switch already say the branch is
        powered and unswitchable.
      */}
      <button
        type="button"
        className="sw"
        aria-pressed={monitorOnly ? undefined : on}
        aria-label={
          monitorOnly
            ? `${outlet.name} is monitored only and has no relay to switch`
            : `${on ? 'Disconnect' : 'Activate'} ${outlet.name}`
        }
        title={
          monitorOnly
            ? 'Monitored-only channel: no relay is fitted behind the USB socket, so there is nothing to activate or disconnect.'
            : live
              ? on
                ? `POST /api/Dashboard/outlets/${outlet.id}/disconnection`
                : `POST /api/Dashboard/outlets/${outlet.id}/activation`
              : 'Backend unreachable — no command can be dispatched'
        }
        disabled={monitorOnly || !live || busy}
        onClick={() => onToggle(outlet.id)}
      />
    </article>
  )
}