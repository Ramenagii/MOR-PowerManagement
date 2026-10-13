import type { Outlet, OutletStatus } from '../types/dashboard'
import { formatWatts, isEnergizedOutlet } from '../utils/dashboard'

/**
 * No relay control. Not "a control that is switched off" — no control.
 *
 * `onToggle` used to be a prop of this card and it is deliberately gone: the
 * only element that ever consumed it was a permanently disabled button, so
 * keeping the prop would have kept a command path wired to nothing.
 */
type OutletCardProps = {
  outlet: Outlet
  /** The rig has latched a hardware fault, so no figure here is attributable. */
  faulted: boolean
}

/**
 * Colour discipline: this card carries exactly ONE chip — the status. Its rail,
 * its priority tier, its relay id and its sensor provenance are all static
 * metadata, so they are rendered as plain labelled text on on-surface-variant
 * and separated by a hairline rather than by colour. A 220 V rail and a 5 V USB
 * rail do not need different colours to be told apart, and priority is a shed
 * order rather than a health verdict, so colouring it red would be a lie.
 */
type StatusView = { label: string; tag: string }

const NEUTRAL_TAG = 'ant-tag border-outline-variant bg-surface-container text-on-surface-variant'

const STATUS_VIEWS: Record<OutletStatus, StatusView> = {
  Active: { label: 'Energized', tag: NEUTRAL_TAG },
  Standby: { label: 'Standby', tag: 'ant-tag ant-tag-warning' },
  Restricted: { label: 'Restricted', tag: 'ant-tag ant-tag-error' },
  Disconnected: { label: 'Open', tag: NEUTRAL_TAG },
}

function channelLabel(id: number): string {
  return `CH${String(id).padStart(2, '0')}`
}

/**
 * There is no relay control on this card, and the reason is printed in the slot
 * where one would have been rather than hidden in a tooltip.
 *
 * `POST /outlets/{id}/activation` exists and does update policy state, so the
 * button that used to sit here was not faking a network call — but
 * `RELAY_OUTPUT_ENABLED` is 0 and `RULES_ENABLED` is 0, so nothing on the
 * device moves a contact. A disabled button in that position was the worst of
 * the honest options: full width, primary-styled, the largest element on the
 * card, permanently inert. A reader scanning the grid was reading the visual
 * position of the card's main action, not a claim the card could act on — and a
 * control that can never fire should not hold the place of one. So the control
 * is gone and the slot carries a one-line status instead. The activation route
 * is still reachable, from the Scenario panel's SIM-02 vector, where dispatching
 * is the entire purpose of the control.
 *
 * WHY THE SHORT STRING AND NOT THE PARAGRAPH:
 *
 *   This sentence is identical on every card, and the grid prints it on all
 *   thirteen channels of the full rig. One reason given thirteen times is not
 *   thirteen reasons, it is a wall — and a wall of caveats is a screen nobody
 *   reads the numbers on. So the card carries the LABEL ("not driven") and the
 *   Dashboard states the full sentence once, in a disclosure immediately below
 *   the grid. The words are unchanged and they are still on the same screen.
 */
export const RELAY_UNAVAILABLE =
  'RELAY_OUTPUT_ENABLED is 0 — relay outputs are not driven in this build, so this writes policy state only. No contact moves.'

/**
 * The short form printed in the card footer. A label, not prose — it is the
 * same claim as RELAY_UNAVAILABLE compressed to the part a reader needs in
 * order to tell an absent control from one that merely cannot act yet.
 *
 * Constant, with nothing appended under a latched fault: a clause that appeared
 * on faulted cards and not on healthy ones would make the footer the one band
 * on the card whose height depends on state, which is the misalignment this
 * footer exists to remove. The fault clause is already stated in full, once, in
 * the Dashboard disclosure below the grid.
 */
const RELAY_UNAVAILABLE_SHORT = 'Relays not driven in this build'

/**
 * The sensor story per rail, as prose. Moved off the card's tooltip and into
 * the Dashboard's disclosure: a tooltip is unreachable by keyboard and
 * disappears the moment the pointer moves, and this sentence is the answer to
 * "where do these numbers come from?" on the page that shows the most numbers.
 */
export function branchSensorNote(ratedVolts: number): string {
  return `Branch current is metered by an ADS1015 front end reading the ZMCT103C clamped on this branch. The ${ratedVolts} V figure shown is the channel's rated rail, not a live sample.`
}

export const NOMINAL_RAIL_NOTE =
  'The USB rail carries no CT and no ADC input. Its figure is the rail nominal rating, which is not a measurement of draw.'

/** Current below 10 A is worth two decimals; above that the third digit is noise. */
function formatAmps(watts: number, volts: number): string | null {
  if (!(volts > 0) || !(watts > 0)) return null
  const amps = watts / volts
  return amps < 10 ? amps.toFixed(2) : amps.toFixed(1)
}

/**
 * A single controlled channel.
 *
 * Three honesty rules are enforced by the card itself:
 *
 *   1. Under a latched sensor fault, EVERY figure here reads "no reading". The
 *      roster, the allowance, the schedule and the relay id are facts about the
 *      configuration and stay true; the volts, amps and watts are readings, and
 *      a reading taken while the device says it cannot read is not one.
 *   2. Amps are DERIVED here. `GET /Dashboard/state` returns watts and the rated
 *      rail voltage, not an amps field, so the figure shown is P / V with the
 *      power factor assumed to be 1. It is labelled as derived and the title
 *      attribute says so; it is never presented as a direct CT reading.
 *   3. The legacy `meter` string is deliberately NOT rendered. It still carries
 *      the retired PZEM-004T label on older snapshots. What is shown instead is
 *      the sensor that is actually fitted: a branch CT on each mains outlet
 *      behind an ADS1015, and a nominal rating on the USB rail, which has no CT
 *      wired to it at all.
 */
export function OutletCard({ outlet, faulted }: OutletCardProps) {
  const isEnergized = isEnergizedOutlet(outlet.status)
  const status = STATUS_VIEWS[outlet.status]
  const isMains = outlet.volts >= 220

  const rawPercent = outlet.allowance > 0 ? (outlet.watts / outlet.allowance) * 100 : 0
  const overAllowance = rawPercent > 100
  const usedPercent = Math.min(100, rawPercent)
  const amps = formatAmps(outlet.watts, outlet.volts)

  // Under a fault the fill is not "at zero percent" — there is nothing to place
  // on the track. An empty track with a critical rail says "unattributable";
  // a full-width zero bar says "measured, and it happens to be nothing".
  const fillClass = faulted
    ? 'bg-error'
    : overAllowance
      ? 'bg-error'
      : rawPercent >= 85
        ? 'bg-tertiary'
        : isEnergized
          ? 'bg-secondary'
          : 'bg-outline-variant'

  const sensor = isMains ? 'ADS1015 + ZMCT103C on this branch' : 'No sensor — nominal rating'
  const sensorNote = isMains ? branchSensorNote(outlet.volts) : NOMINAL_RAIL_NOTE

  const loadLabel = faulted ? 'No reading' : `${Math.round(outlet.watts).toLocaleString()}`

  return (
    <article
      className="ant-card flex flex-col gap-space-sm p-space-md"
      aria-label={`${outlet.name} · ${status.label}${faulted ? ' · sensor fault, figures not attributable' : ''}`}
    >
      <header className="flex items-start justify-between gap-space-sm">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-metric-value text-metric-value font-semibold text-on-surface">
            {channelLabel(outlet.id)}
          </span>
          <h3
            className="truncate font-title-lg text-title-lg font-semibold text-on-surface"
            title={outlet.name}
          >
            {outlet.name}
          </h3>
        </div>
        <span className={`${status.tag} shrink-0`}>{status.label}</span>
      </header>

      {/* Static metadata line. Role, relay, rail and shed priority are facts
          about the channel, not verdicts about its health, so they read as one
          muted sentence instead of three competing chips. */}
      <p className="truncate font-body-sm text-body-sm text-on-surface-variant">
        {outlet.role} · <span className="font-metric-value text-metric-value">{outlet.relay}</span>
      </p>
      <p
        className="truncate font-body-sm text-body-sm text-on-surface-variant"
        title="Shed order under FR-07: Low priority is shed first, Critical is protected last. RULES_ENABLED is 0, so no priority order is enforced on hardware."
      >
        {`Priority: ${outlet.priority} · Rail:`}{' '}
        <span className="font-metric-value text-metric-value">
          {`${outlet.volts}V ${isMains ? 'AC' : 'DC'}`}
        </span>
      </p>

      {/* V / A / W well. Units ride in the caption, never after the figure, so
          the three columns stay aligned while the values stream. */}
      <div className="grid grid-cols-3 gap-1 rounded bg-surface-container-low px-1 py-2 text-center">
        <div>
          <div className="font-label-sm text-label-sm uppercase text-on-surface-variant">Rail</div>
          <div className="font-metric-value text-metric-value font-semibold text-on-surface">
            {outlet.volts}
            <span className="font-metric-value text-metric-value font-normal text-on-surface-variant">
              {' '}
              V
            </span>
          </div>
        </div>
        <div>
          <div className="font-label-sm text-label-sm uppercase text-on-surface-variant">
            Current
          </div>
          <div
            className="font-metric-value text-metric-value font-semibold text-on-surface"
            title="Derived as P / V from the branch CT sample, assuming a power factor of 1"
          >
            {faulted ? '—' : amps === null ? '—' : amps}
            <span className="font-metric-value text-metric-value font-normal text-on-surface-variant">
              {' '}
              A
            </span>
          </div>
        </div>
        <div>
          <div className="font-label-sm text-label-sm uppercase text-on-surface-variant">Load</div>
          <div
            className={`font-metric-value text-metric-value font-semibold ${
              faulted ? 'text-error' : overAllowance ? 'text-error' : 'text-on-surface'
            }`}
          >
            {/*
              The unit goes with the figure. "No reading W" is a watts value with
              a missing number, which is exactly the ambiguity the faulted state
              is here to remove.
            */}
            {faulted ? (
              'No reading'
            ) : (
              <>
                {loadLabel}
                <span className="font-metric-value text-metric-value font-normal text-on-surface-variant">
                  {' '}
                  W
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Load against this channel's own allowance. */}
      <div>
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <span className="truncate font-body-sm text-body-sm text-on-surface-variant">
            Allowance{' '}
            <span className="font-metric-value text-metric-value">{formatWatts(outlet.allowance)}</span>
          </span>
          <span
            className={`shrink-0 font-metric-value text-metric-value font-semibold ${
              faulted ? 'text-error' : overAllowance ? 'text-error' : rawPercent >= 85 ? 'text-tertiary' : 'text-on-surface-variant'
            }`}
          >
            {faulted ? 'not attributable' : `${Math.round(rawPercent)}%`}
          </span>
        </div>
        <div
          className="ant-meter"
          role="meter"
          aria-valuenow={faulted ? undefined : Math.round(usedPercent)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={
            faulted
              ? `${outlet.name} load — not attributable, the device has latched a sensor fault`
              : `${outlet.name} load against its allowance`
          }
        >
          {/* A hatched bar, not an empty one: the shape says "there is a value
              here and it cannot be trusted", which a zero-width bar cannot. */}
          <div
            className={`ant-meter-fill ${fillClass}`}
            style={{
              width: faulted ? '100%' : `${usedPercent}%`,
              backgroundImage: faulted
                ? 'repeating-linear-gradient(135deg, rgba(255,255,255,0.82) 0 3px, rgba(255,255,255,0) 3px 8px)'
                : undefined,
              opacity: faulted ? 0.28 : undefined,
            }}
          />
        </div>
        {!faulted && overAllowance && (
          <p className="mt-1 font-metric-value text-metric-value text-error">
            {`Over allowance by ${Math.round(outlet.watts - outlet.allowance).toLocaleString()} W`}
          </p>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 border-t border-outline-variant pt-2">
        <div className="flex min-w-0 items-baseline justify-between gap-2">
          <dt className="font-body-sm text-body-sm text-on-surface-variant">Schedule</dt>
          <dd className="truncate font-metric-value text-metric-value text-on-surface" title={outlet.schedule}>
            {outlet.schedule}
          </dd>
        </div>
        <div className="flex min-w-0 items-baseline justify-between gap-2">
          <dt className="font-body-sm text-body-sm text-on-surface-variant">Idle limit</dt>
          <dd className="truncate font-metric-value text-metric-value text-on-surface">{outlet.idleLimit}</dd>
        </div>
        <div className="col-span-2 flex min-w-0 items-baseline justify-between gap-2">
          <dt className="shrink-0 font-body-sm text-body-sm text-on-surface-variant">Sensor</dt>
          <dd className="truncate font-body-sm text-body-sm text-on-surface" title={sensorNote}>
            {sensor}
          </dd>
        </div>
      </dl>

      {/* Footer: a status, not a control.
          The relay command this card used to offer is gone rather than
          disabled — RELAY_OUTPUT_ENABLED is 0, so the control could never fire
          and a permanently dead button holding the card's main-action position
          told a reader more about the layout than about the rig. What is left
          is one line, above the same hairline as the table above it, saying
          that no contact moves. It is the same line on every card and it is
          never extended, so `mt-auto` lands the footer at one height across
          the grid; the fault clause lives once, in the Dashboard disclosure
          directly below.

          The value wraps rather than truncates. It is one line anywhere the
          card is wider than the sentence — every desktop and tablet layout,
          and the single-column phone layout — and two lines in the 480–620px
          band, where the outlet grid is two columns and the cards are about
          226px. Both lines show in that band, and every card lands on the
          same one, because the string is the same string. An ellipsis would
          have been the cheaper option and the dishonest one: it clips the
          only honest sentence this card still carries. */}
      <div className="mt-auto flex min-w-0 items-baseline justify-between gap-2 border-t border-outline-variant pt-2">
        <span className="shrink-0 font-body-sm text-body-sm text-on-surface-variant">Relay</span>
        <span
          className="min-w-0 text-right font-body-sm text-body-sm text-on-surface-variant line-clamp-2"
          title={RELAY_UNAVAILABLE}
        >
          {RELAY_UNAVAILABLE_SHORT}
        </span>
      </div>
    </article>
  )
}