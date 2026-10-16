import { memo, useMemo, type CSSProperties } from 'react'
import type { Outlet } from '../types/dashboard'
import {
  DASHBOARD_TIPS,
  UNAVAILABLE,
  isMonitoredOnlyChannel,
  relayGpio,
} from '../data/dashboard'
import { isEnergizedOutlet, isLatchedOutlet, relayChip, type RelayTone } from '../utils/dashboard'
import { buildPath } from './DashboardHero'

type DashboardOutletProps = {
  outlet: Outlet
  /** Recorded watt buckets for this branch, oldest first. */
  history: Array<number | null>
  /**
   * Position in the roster, 0-based. Carried only so the first-paint stagger in
   * styles.css can be offset per row; it is applied as `--row-index`, never as a
   * React key — the key is the outlet id, which is the only identity that
   * survives a poll.
   */
  rowIndex: number
  live: boolean
  /** Live INA226 mains volts; null when the device has nothing fresh. */
  mainsVolts: number | null
  busy: boolean
  onToggle: (id: number) => void
}

const SPARK_W = 400
const SPARK_H = 64

/**
 * The row badge is the branch's LIVE load band, not its configured priority.
 *
 * This used to read Critical / High / Medium / Low. Those are shed order, an
 * operator setting edited in the Framework admin, so they never change: a chip
 * that never changes is indistinguishable from a stuck sensor, and an operator
 * scanning a grid of rows learns the badge is furniture and stops reading it.
 * The priority is not lost — it moves into the tooltip, where a setting belongs
 * and where prose is asked for — and the badge takes over the one job that
 * moves on a dashboard: saying how this branch is doing RIGHT NOW.
 *
 * The band is watts against THIS branch's own allowance, so a 10 W USB socket
 * and a 1100 W mains outlet are each read against their own cap rather than one
 * shared number. Amber and red are the same two the allocation meter and the
 * rail already use, so one meaning holds across the page.
 *
 * It is a SECOND chip and not a replacement for the relay-state chip. The band
 * answers "how much of its cap is this branch using", the relay chip answers
 * "is the contact closed" — and on this rig those disagree constantly, because
 * an open branch sits at 0 W and therefore always bands Normal. Collapsing them
 * would make an isolated outlet the healthiest thing in the grid.
 */
type BranchBand = 'offline' | 'nocap' | 'normal' | 'near' | 'over'

const BAND_TAG: Record<BranchBand, string> = {
  offline: 'tag band-offline',
  nocap: 'tag band-nocap',
  normal: 'tag band-normal',
  near: 'tag band-near',
  over: 'tag band-over',
}

/** One word. A row is read from across a room; the rest is a tooltip. */
const BAND_WORD: Record<BranchBand, string> = {
  offline: 'Offline',
  nocap: 'No cap',
  normal: 'Normal',
  near: 'Near cap',
  over: 'Over cap',
}

/**
 * Relay-state chip, mirroring the reference sketch's `Status: %s` line.
 *
 * The reference prints TRIPPED / ACTIVE / STANDBY. The server sends four values
 * with no TRIPPED among them, so this cannot be a transcription — see
 * `relayChip` in utils/dashboard for the full argument. What survives of the
 * mapping is the SHAPE: one word per channel, drawn from the same three-tone
 * vocabulary, so a bench read at a glance looks like the device's own read-out.
 *
 * The four tones, and why each one is the tone it is:
 *   live     neutral fill. The ordinary case must not be the loudest thing.
 *   idle     hollow with amber ink. Powered, but drawing under the threshold.
 *   open     hollow, grey. A switch is fitted and an operator can press it, so
 *            this is a normal outcome and not a fault.
 *   latched  solid red. The one state no control on this screen can clear.
 *
 * `st-none` is the offline case and it is deliberately unlabelled: with no
 * session there is no relay state to report, and printing OPEN off
 * `baseOutlets` would be the browser asserting a reading it never received.
 */
const STATE_TAG: Record<RelayTone | 'none', string> = {
  live: 'st st-live',
  idle: 'st st-idle',
  open: 'st st-open',
  latched: 'st st-latched',
  none: 'st st-none',
}

/**
 * Band a branch by its own share of its own allowance.
 *
 * 80% is where a branch stops being routine: it is close enough that one more
 * device turns the row red, which is the moment an operator wants to know
 * about. 100% is the cap itself.
 *
 * Two states exist that are not bands, and both exist because a measurement
 * that was never taken must not be rendered as a healthy one:
 *   - offline, when there is no session. `live` gates this, so a cached last
 *     good reading can never sit in the badge as if it were current.
 *   - nocap, when the branch has no allowance configured at all. Without a cap
 *     there is nothing to compare against, and calling that "Normal" or "Over
 *     cap" would both be invented. `allowance` comes straight off the admin
 *     field with no fallback in api.ts, so 0 is a value the server can send.
 */
export function branchBand(watts: number, allowance: number, live: boolean): BranchBand {
  if (!live) return 'offline'
  if (!(allowance > 0)) return 'nocap'
  const pct = (watts / allowance) * 100
  if (pct > 100) return 'over'
  if (pct >= 80) return 'near'
  return 'normal'
}

/**
 * One controlled channel, laid out as the reference's five-column row:
 *   [identity + live band + relay state] [watts] [sparkline] [allocation] [switch]
 *
 * Two chips sit under the channel name and they answer two different questions.
 * `branchBand` is the load against this branch's own allowance; `relayChip` is
 * the contact position the server reports. Priority — the operator's shed order —
 * lives in the band's tooltip next to the percentage the band was computed from,
 * so the row reads two ways, quickly and completely, without either chip being
 * a frozen setting wearing a live one's clothes.
 *
 * They are two chips rather than one because they disagree constantly: an open
 * branch draws 0 W, so its band is always Normal, and a single chip would have
 * to choose between "healthy" and "isolated" for a branch that is both.
 *
 * The 4px rail down the left edge (the row's ::before) is the only place the
 * energized state is expressed as colour, and it greys out with the whole row
 * when the branch is open — so "off" dims the card instead of drawing a second
 * badge that would compete with the switch. Latched is the one exception and it
 * goes to red: a branch the policy engine has isolated is not "off", and dimming
 * it to look like an operator's own disconnect would understate what happened.
 *
 * Amps is DERIVED. State returns watts and a live mains-volts reference, so the
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
function DashboardOutletRow({ outlet, history, rowIndex, live, mainsVolts, busy, onToggle }: DashboardOutletProps) {
  const monitorOnly = isMonitoredOnlyChannel(outlet.id)
  const latched = live && isLatchedOutlet(outlet.status)
  const on = live && (monitorOnly || isEnergizedOutlet(outlet.status))

  /*
   * The relay-state chip. Gated on `live` for the same reason every other figure
   * on this page is: `baseOutlets` says Disconnected so the row has a shape, and
   * a chip that renders that offline is the console reporting a relay position
   * no relay was ever in. Offline the chip is present and empty rather than
   * absent, so the row keeps its layout and does not reflow when the session
   * comes back.
   */
  const state = live ? relayChip(outlet.status) : null
  const stateTag = state ? STATE_TAG[state.tone] : STATE_TAG.none
  const stateWord = state?.word ?? UNAVAILABLE
  const stateDetail = state ? state.detail : DASHBOARD_TIPS.offline

  /*
   * The allocation denominator, and it is whatever the server says it is. The
   * reference caps each branch at 1100 W against a 4400 W ceiling, but those
   * are numbers the Framework admin writes and GET /Dashboard/state reads back,
   * so they arrive per row and nothing here may re-assert them. 0 is a value the
   * server can legally send — `allowanceWatts` is not validated above zero — so
   * it is handled rather than divided by: the meter sits empty and the badge
   * says No cap, instead of showing Infinity %.
   */
  const allowance = outlet.allowance
  const effWatts = live ? outlet.watts : 0
  const usedPercent = allowance > 0 ? (effWatts / allowance) * 100 : 0
  const over = live && allowance > 0 && outlet.watts > allowance

  /*
   * THE PEAK IS THE MAXIMUM OF WHAT IS LIVE AND WHAT WAS RECORDED.
   *
   * This used to be the maximum of the history buckets alone, with the live
   * reading left out of it. That is not an approximation, it is a row that
   * contradicts itself: close a relay on a branch whose last fifteen minutes
   * topped out at 127 W and the same card renders 792 W in the watts column,
   * 792 / 1100 W in the allocation line, and "Peak 127 W" underneath them. Two
   * of those three numbers are measuring the instant and one is measuring the
   * window, and the label does not say which is which — so an operator watching
   * a toggle cannot tell whether the console believes the branch went to 792 W
   * or whether the 792 W is the stale one. A peak that sits below the reading it
   * is supposed to bound is not a peak. It is the best of a subset wearing a
   * summary's clothes.
   *
   * So the rule here is absolute rather than approximate: the displayed peak is
   * `max(buckets, live)`, which makes peak < live unrepresentable on screen
   * rather than merely unlikely. Offline both sources are empty and it reads 0,
   * like every other measured figure on this page.
   *
   * The percentage beside it is derived from THIS figure, not from the live one.
   * That is the second half of the same bug: a line reading "Peak 792 W · 72%
   * used" pairs a peak with the instantaneous utilisation and reports the two as
   * if they were one measurement. Peak-percent is peak / allowance, so the pair
   * is always the same arithmetic — and it is allowed to exceed 100, because a
   * peak above the allocation is the single most useful thing this line says.
   * The meter above it keeps the live figure and stays clamped; the two answer
   * different questions and neither borrows the other's number.
   */
  const bucketPeak = useMemo(() => {
    let max = 0
    for (const value of history) {
      if (value !== null && Number.isFinite(value) && value > max) max = value
    }
    return max
  }, [history])
  const peakWatts = live ? Math.max(bucketPeak, effWatts) : 0
  const peakPercent = allowance > 0 ? (peakWatts / allowance) * 100 : 0

  // The badge's band and the tooltip sentence that explains it are derived from
  // the same three numbers as the meter below, so the chip can never disagree
  // with the bar it sits beside. Band text is one word; the tooltip carries the
  // arithmetic — both facts about this branch, neither of them invented.
  const band = branchBand(effWatts, allowance, live)
  const bandTitle = `${!live
    ? 'GET /api/Dashboard/state did not answer, so this row carries no load reading and no band.'
    : band === 'nocap'
      ? 'No allowance is configured for this branch, so there is no cap to read the load against.'
      : `${Math.round(effWatts).toLocaleString()} W is ${Math.round(usedPercent)}% of its allowance.`} ${
    monitorOnly
      ? `Shed order: ${outlet.priority} priority, but there is no relay to shed — the framework ranks it first and can do nothing with it.`
      : `Shed order: ${outlet.priority} priority, assigned in the Framework tab.`
  }`

  // Sparkline is scaled against the branch's own allocation, so a 40 W branch
  // and a 1100 W branch each fill their own box proportionally and the operator
  // reads utilisation rather than absolute size.
  //
  // The floor is `peakWatts`, not the bucket peak, and that is the same fix as
  // the label's: the live reading is part of this branch's range whether or not
  // a bucket has caught up to it yet. Scaling on the buckets alone drew a fresh
  // spike off the top of the plot, which is the one thing a trend line must not
  // do — it clips the highest point of the trace and leaves the operator reading
  // a branch that never went above its old maximum.
  const sparkScale = Math.max(allowance, peakWatts, 1)

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
  //
  // Gated on a real allowance for the same reason: half of nothing is nothing,
  // and a rule pinned to the floor of an uncapped branch reads as "this branch
  // is sitting on its limit" when the truth is that it has no limit to sit on.
  const limitY =
    hasSpark && allowance > 0
      ? SPARK_H - Math.min((allowance / 2 / sparkScale), 1) * (SPARK_H - 4) - 2
      : null

  // Live mains reference when the device is reporting; nothing otherwise.
  //
  // This used to fall back to `outlet.volts` — the channel's RATED rail — so a
  // rig with no fresh reading produced "238.0 V · 0.00 A" on every row: a
  // configuration fact sitting in a column of measurements, indistinguishable
  // from a real 238.0 V sample, and the reason a dead input still produced a
  // plausible-looking dashboard. With no live reference the pair now reads 0
  // and the tooltip says why.
  //
  // CH5 has no converter of its own, and the one converter on the rig sits on
  // the separate INA226 DC shunt path — not the 5 V USB socket or 238 V mains feed.
  // It used to be handed `ina226.busVolts` as its "volts", which put a DC
  // figure in the pair on a 5 V socket. `mainsVolts` is already null for that
  // channel, so the pair reads 0 and the tooltip states the reason: nothing on
  // this rig measures that rail.
  const voltsLive = live && mainsVolts !== null && mainsVolts > 0
  const shownVolts = voltsLive ? mainsVolts : 0
  const amps = voltsLive && effWatts > 0 ? effWatts / shownVolts : 0
  const wattsText = Math.round(effWatts).toLocaleString()
  const vaText = `${shownVolts.toFixed(1)} V · ${amps.toFixed(2)} A`

  // The peak line carries its own arithmetic, because a figure that cannot be
  // re-derived from the two numbers above it is how "Peak 127 W" next to a live
  // 792 W survived review in the first place.
  const peakTitle = !live
    ? 'GET /api/Dashboard/state did not answer, so there is neither a live reading nor a window to take a peak from.'
    : `Peak is the larger of this branch's live reading (${wattsText} W) and every watt bucket recorded in the last 15 minutes (${Math.round(
        bucketPeak,
      ).toLocaleString()} W), so the peak can never print below the live figure above it. ${
        allowance > 0
          ? `That peak is ${Math.round(peakPercent)}% of this branch's ${Math.round(allowance).toLocaleString()} W allocation.`
          : 'No allocation is configured for this branch, so there is no percentage to quote against it.'
      }`

  const vaTitle = monitorOnly
    ? DASHBOARD_TIPS.usb
    : voltsLive
      ? 'Live mains volts; branch amps derived as P / V at PF 1'
      : 'No fresh mains volts, so there is no reference to derive against and the rated rail is deliberately not substituted — both figures read 0'

  return (
    <article
      className={`mp-card row ${on ? '' : 'off'}${latched ? ' latched' : ''}`}
      /*
        `--row-index` offsets the first-paint stagger in styles.css. It is a
        plain custom property on a DOM node that React never re-creates, so it
        is read once when the animation starts and cannot restart it. Changing
        it on a poll would do nothing visible, which is the point.
      */
      style={{ '--row-index': rowIndex } as CSSProperties}
      aria-label={`${outlet.name}, ${
        monitorOnly ? 'monitored only, no relay' : state ? state.word.toLowerCase() : 'relay state not reported'
      }, ${BAND_WORD[band].toLowerCase()}, ${wattsText} watts`}
    >
      {/* 1 — identity + live load band */}
      <div className="idcol">
        <b>{`${`CH${String(outlet.id).padStart(2, '0')}`} · ${outlet.name}`}</b>
        <div className="meta num" title={monitorOnly ? DASHBOARD_TIPS.usb : `Relay ${outlet.relay} on ${relayGpio(outlet.id)}`}>
          {monitorOnly ? '5 V USB · monitored' : relayGpio(outlet.id)}
        </div>
        {/*
          Two chips, two questions. The band moves with the load; the relay state
          moves with the contact. They share a line because the row is read in one
          pass, and they are two chips rather than one because on this rig they
          disagree constantly — an open branch draws 0 W, so it always bands
          Normal. One chip would have to drop one of those facts.
        */}
        <div className="chips">
          <span className={BAND_TAG[band]} title={bandTitle}>
            {BAND_WORD[band]}
          </span>
          <span className={stateTag} title={stateDetail}>
            {stateWord}
          </span>
        </div>
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
          aria-valuenow={allowance > 0 ? Math.round(usedPercent) : undefined}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={
            allowance > 0
              ? `${outlet.name} load against its allocation`
              : `${outlet.name} has no allocation configured, so there is nothing to measure this against`
          }
        >
          <i style={{ width: `${Math.min(usedPercent, 100)}%`, background: over ? 'var(--bad)' : undefined }} />
        </div>
        <div className="pk num" title={peakTitle}>
          {allowance > 0
            ? `Peak ${Math.round(peakWatts).toLocaleString()} W · ${Math.round(peakPercent)}% used`
            : `Peak ${Math.round(peakWatts).toLocaleString()} W · no allocation set`}
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

        Left ENABLED on a latched branch, on purpose. The server ignores relay
        reports for a restricted outlet, but an activation request is a different
        path and the engine does re-assess one — so this is not a dead control
        and greying it out would be a claim the console cannot make. What it must
        not do is let the button read as the fix, so the tooltip says outright
        that pressing it re-requests rather than restores.
      */}
      <button
        type="button"
        className="sw"
        aria-pressed={monitorOnly || latched ? undefined : on}
        aria-label={
          monitorOnly
            ? `${outlet.name} is monitored only and has no relay to switch`
            : latched
              ? `Re-request activation for ${outlet.name}, which the policy engine has latched shut`
              : `${on ? 'Disconnect' : 'Activate'} ${outlet.name}`
        }
        title={
          monitorOnly
            ? 'Monitored-only channel: no relay is fitted behind the USB socket, so there is nothing to activate or disconnect.'
            : !live
              ? 'Backend unreachable — no command can be dispatched'
              : latched
                ? `Latched by the policy engine. This posts an activation REQUEST to POST /api/Dashboard/outlets/${outlet.id}/activation — the engine re-assesses it and may refuse or re-latch the branch. It does not restore a latched outlet on its own.`
                : on
                  ? `POST /api/Dashboard/outlets/${outlet.id}/disconnection`
                  : `POST /api/Dashboard/outlets/${outlet.id}/activation`
        }
        disabled={monitorOnly || !live || busy}
        onClick={() => onToggle(outlet.id)}
      />
    </article>
  )
}

/*
 * EQUALITY, NOT IDENTITY — and that distinction is the whole fix for the rows
 * replaying their entrance on every data tick.
 *
 * A poll every 500 ms hands this component a brand-new `outlet` object and a
 * brand-new `history` array even when nothing about the branch has changed, so
 * any check written as `prev === next` fails on every tick. That failure is
 * cheap while the row is inert. It stops being cheap the moment the row carries
 * motion: a re-render that React could have skipped is a re-render that walks
 * the row's animation from zero, which is how a page that only polls ended up
 * looking like it was reloading. So the row is compared by VALUE and a poll that
 * changes nothing produces no render at all.
 *
 * `onToggle` is deliberately NOT compared. Dashboard passes a stable wrapper
 * that resolves the live callback through a ref, so ignoring the prop cannot
 * leave the switch holding a stale roster — which is the failure a naive
 * "ignore the function props" memo introduces, and the reason that wrapper
 * exists rather than the raw handler being passed straight through.
 *
 * Every field of `Outlet` is compared rather than only the ones this file reads
 * today. A row that went stale because someone added a field to the type and not
 * to this list would be a far worse bug than the re-renders it prevents.
 */
function sameOutlet(a: Outlet, b: Outlet): boolean {
  if (a === b) return true
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.role === b.role &&
    a.meter === b.meter &&
    a.relay === b.relay &&
    a.priority === b.priority &&
    a.allowance === b.allowance &&
    a.volts === b.volts &&
    a.watts === b.watts &&
    a.status === b.status &&
    a.schedule === b.schedule &&
    a.idleLimit === b.idleLimit
  )
}

/**
 * Bucket-by-bucket, because `history` is rebuilt from the poll response on every
 * tick. Length is compared first: the server resizes the window's grid, and a
 * row whose window genuinely changed must render even if the leading values
 * happen to match.
 */
function sameHistory(a: Array<number | null>, b: Array<number | null>): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export const DashboardOutlet = memo(DashboardOutletRow, (prev, next) => {
  return (
    prev.rowIndex === next.rowIndex &&
    prev.live === next.live &&
    prev.mainsVolts === next.mainsVolts &&
    prev.busy === next.busy &&
    sameOutlet(prev.outlet, next.outlet) &&
    sameHistory(prev.history, next.history)
  )
})
