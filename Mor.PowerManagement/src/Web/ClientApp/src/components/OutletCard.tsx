import { Power } from 'lucide-react'
import type { Outlet, OutletStatus } from '../types/dashboard'
import { formatWatts, isEnergizedOutlet } from '../utils/dashboard'

type OutletCardProps = {
  outlet: Outlet
  onToggle: (id: number) => void
}

/**
 * Colour discipline: this card carries exactly ONE chip — the status. Its rail,
 * its priority tier, its relay id and its sensor provenance are all static
 * metadata, so they are rendered as plain labelled text on on-surface-variant
 * and separated by a hairline rather than by colour. A 220 V rail and a 5 V USB
 * rail do not need different colours to be told apart, and priority is a shed
 * order rather than a health verdict, so colouring it red would be a lie.
 *
 * "Energized" — the normal state, and therefore the most common thing on
 * screen — wears the neutral surface tag, not the green success tag. Green is
 * not a state colour in this console: it would make the default state the
 * loudest one. The label still says which state it is, and amber and red stay
 * reserved for Standby/Restricted and for over-allowance respectively.
 */
type StatusView = { label: string; tag: string }

const NEUTRAL_TAG = 'ant-tag bg-surface-container text-on-surface-variant border-outline-variant'

const STATUS_VIEWS: Record<OutletStatus, StatusView> = {
  Active: { label: 'Energized', tag: NEUTRAL_TAG },
  Standby: { label: 'Standby', tag: 'ant-tag ant-tag-warning' },
  Restricted: { label: 'Restricted', tag: 'ant-tag ant-tag-warning' },
  Disconnected: { label: 'Open', tag: NEUTRAL_TAG },
}

function channelLabel(id: number): string {
  return `CH${String(id).padStart(2, '0')}`
}

/** Current below 10 A is worth two decimals; above that the third digit is noise. */
function formatAmps(watts: number, volts: number): string | null {
  if (!(volts > 0) || !(watts > 0)) return null
  const amps = watts / volts
  return amps < 10 ? amps.toFixed(2) : amps.toFixed(1)
}

/**
 * A single controlled channel.
 *
 * Shows volts and amps beside the load, because the firmware now reports real
 * per-branch current (an ADS1015 front end reading a CT on each branch) and a
 * card that only showed watts left the operator guessing at the current the
 * cable is actually carrying.
 *
 * Two honesty rules are enforced by the card itself:
 *
 *   1. Amps are DERIVED here. `GET /Dashboard/state` returns watts and the rated
 *      rail voltage, not an amps field, so the figure shown is P / V with the
 *      power factor assumed to be 1. It is labelled as derived and the title
 *      attribute says so; it is never presented as a direct CT reading.
 *   2. The legacy `meter` string is deliberately NOT rendered. It still carries
 *      the retired PZEM-004T label on older snapshots. What is shown instead is
 *      the sensor that is actually fitted: a branch CT on each mains outlet, and
 *      a residual for the USB rail, which has no CT and is inferred as the INA226
 *      mains total minus the measured branches.
 */
export function OutletCard({ outlet, onToggle }: OutletCardProps) {
  const isEnergized = isEnergizedOutlet(outlet.status)
  const status = STATUS_VIEWS[outlet.status]
  const isMains = outlet.volts >= 220

  const rawPercent = outlet.allowance > 0 ? (outlet.watts / outlet.allowance) * 100 : 0
  const overAllowance = rawPercent > 100
  const usedPercent = Math.min(100, rawPercent)
  const amps = formatAmps(outlet.watts, outlet.volts)

  const fillClass = overAllowance
    ? 'bg-error'
    : rawPercent >= 85
      ? 'bg-tertiary-container'
      : isEnergized
        ? 'bg-primary'
        : 'bg-outline-variant'

  const sensor = isMains ? 'Branch CT (ADS1015)' : 'Residual of INA226 total'
  const sensorNote = isMains
    ? `Branch current metered by an ADS1015 front end reading the CT on this branch. The ${outlet.volts} V figure shown is the channel's rated rail, not a live sample.`
    : 'The USB rail carries no CT. Its figure is a residual — the INA226 mains total minus the measured branches — so it inherits the error of the branches it was derived from.'

  return (
    <article
      className="ant-card flex flex-col gap-space-sm p-space-md"
      aria-label={`${outlet.name} · ${status.label}`}
    >
      <header className="flex items-start justify-between gap-space-sm">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-metric-value text-metric-value font-semibold text-on-surface">
            {channelLabel(outlet.id)}
          </span>
          <h3 className="truncate font-title-lg text-title-lg font-semibold text-on-surface" title={outlet.name}>
            {outlet.name}
          </h3>
        </div>
        <span className={`${status.tag} shrink-0`}>{status.label}</span>
      </header>

      {/* Static metadata line. Role, relay, rail and shed priority are facts
          about the channel, not verdicts about its health, so they read as one
          muted sentence instead of three competing chips. Labels are body text;
          anything carrying a figure rides the mono metric token so the digits
          stay tabular. */}
      <p className="truncate font-body-sm text-body-sm text-on-surface-variant">
        {outlet.role} · <span className="font-metric-value text-metric-value">{outlet.relay}</span>
      </p>
      <p
        className="truncate font-body-sm text-body-sm text-on-surface-variant"
        title="Shed order under FR-07: Low priority is shed first, Critical is protected last"
      >
        {`Priority: ${outlet.priority} · Rail:`}{' '}
        <span className="font-metric-value text-metric-value">
          {`${outlet.volts}V ${isMains ? 'AC' : 'DC'}`}
        </span>
      </p>

      {/* V / A / W well. Units ride in the caption, never after the figure, so
          the three columns stay aligned while the values stream. */}
      <div className="grid grid-cols-3 gap-1 rounded-md bg-surface-container-low px-1 py-2 text-center">
        <div>
          <div className="font-body-sm text-body-sm uppercase tracking-wide text-on-surface-variant">Rail</div>
          <div className="font-metric-value text-metric-value font-semibold text-on-surface">
            {outlet.volts}
            <span className="font-metric-value text-metric-value font-normal text-on-surface-variant"> V</span>
          </div>
        </div>
        <div>
          <div className="font-body-sm text-body-sm uppercase tracking-wide text-on-surface-variant">Current</div>
          <div
            className="font-metric-value text-metric-value font-semibold text-on-surface"
            title="Derived as P / V from the branch CT sample, assuming a power factor of 1"
          >
            {amps === null ? '—' : amps}
            <span className="font-metric-value text-metric-value font-normal text-on-surface-variant"> A</span>
          </div>
        </div>
        <div>
          <div className="font-body-sm text-body-sm uppercase tracking-wide text-on-surface-variant">Load</div>
          <div
            className={`font-metric-value text-metric-value font-semibold ${
              overAllowance ? 'text-error' : 'text-on-surface'
            }`}
          >
            {Math.round(outlet.watts).toLocaleString()}
            <span className="font-metric-value text-metric-value font-normal text-on-surface-variant"> W</span>
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
              overAllowance ? 'text-error' : rawPercent >= 85 ? 'text-tertiary-container' : 'text-on-surface-variant'
            }`}
          >
            {`${Math.round(rawPercent)}%`}
          </span>
        </div>
        <div
          className="ant-meter"
          role="meter"
          aria-valuenow={Math.round(usedPercent)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${outlet.name} load against its allowance`}
        >
          <div className={`ant-meter-fill ${fillClass}`} style={{ width: `${usedPercent}%` }} />
        </div>
        {overAllowance && (
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

      {/* Activation is a REQUEST that the policy engine may deny on capacity
          grounds, so it is not styled as the primary command — the shell's one
          primary action stays with the primary buttons in each view. */}
      <button
        type="button"
        className={`ant-btn ant-btn-default mt-auto w-full ${
          isEnergized ? '' : 'font-semibold text-primary hover:border-primary'
        }`}
        onClick={() => onToggle(outlet.id)}
      >
        <Power size={16} aria-hidden="true" />
        {isEnergized ? 'Disconnect' : 'Request activation'}
      </button>
    </article>
  )
}