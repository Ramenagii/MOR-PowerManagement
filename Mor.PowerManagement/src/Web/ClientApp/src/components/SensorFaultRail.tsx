import { CircuitBoard, Radio, TriangleAlert } from 'lucide-react'
import { faultConsequence, type SensorFault } from '../utils/sensorFault'
import { Disclosure } from './Disclosure'

type SensorFaultRailProps = {
  fault: SensorFault | null
  /** Jumps to the Hardware view, where the bus and the parts are documented. */
  onInspectHardware: () => void
}

/**
 * The fault rail — the one loud thing in a deliberately quiet console.
 *
 * DESIGN.md's posture is "quiet executive clarity", which is right for a
 * console that is watching a healthy rig. It is the wrong posture for a
 * console that is watching a faulted one, because the expensive failure here
 * is not an alarm nobody read — it is an absent alarm. Five cards reading
 * `0.0 W` under a green "System Normal" pill is a screen that looks calm and
 * is blind. So when the device has latched a fault the console spends its
 * whole colour budget in one place, above the content, on every view.
 *
 * IT IS A STRIP, NOT A PANEL.
 *
 * It used to measure 1289x388px full-width: a headline, a paragraph, a
 * two-cell definition list, a verbatim quote block and a button. That is a
 * panel, and a panel sitting above every view on every tab is a toll paid on
 * every page for a fault that changes maybe once a session.
 *
 * So the permanent part is now one line — the status dot, the claim, when it
 * latched, and the way out — and everything else is one click away. Loudness
 * is the colour and the dot, not the area. A rail that shouts in 40px of
 * critical wash is still shouting; one that shouts in 388px is just in the way.
 *
 * WHAT IS ON THE STRIP, AND WHY EACH PIECE IS THERE:
 *
 *   · the status dot and the wash, because the fault is the claim
 *   · the headline, because it is the claim being made about the rig
 *   · the latched age, because "since when" is the first question after "what"
 *   · the action, because a rail that names a fault and stops is a dead end
 *   · a disclosure, so the reasoning costs nothing until it is wanted
 *
 * THE VERBATIM QUOTE BLOCK IS GONE, AND WAS NOT RELOCATED.
 *
 * It quoted the fault event's own `detail` string under a heading reading "From
 * the event log, verbatim" — which became a lie the moment the event log left
 * the page. It does not need re-homing: that exact string is the `detail` of
 * the fault event, and the fault event is a row in the notification centre,
 * which renders the backend's detail verbatim in its entry. It is on the page,
 * in its context, under the event's own title and timestamp, which is a better
 * home for it than a quotation of it.
 *
 * The device/sensor split survives as VALUES — "Posting on schedule" beside
 * "Not being read" — inside the disclosure, where the sentence that used to
 * sit under each cell explains them. The fault is still the moment an operator
 * reads; the rail just stops spending its budget on its own justification.
 */
export function SensorFaultRail({ fault, onInspectHardware }: SensorFaultRailProps) {
  if (!fault) return null

  const latched =
    fault.minutesAgo === null
      ? 'latched'
      : fault.minutesAgo === 0
        ? 'latched just now'
        : fault.minutesAgo === 1
          ? 'latched 1 min ago'
          : fault.minutesAgo < 60
            ? `latched ${fault.minutesAgo} min ago`
            : `latched ${Math.floor(fault.minutesAgo / 60)} h ago`

  return (
    <section
      className="wash-critical border-l-4 border-l-error px-space-lg py-2.5"
      role="alert"
      aria-live="polite"
      aria-label="Sensor fault: readings are not attributable"
    >
      {/*
        One row that wraps. The consequence sentence — "0 W is not an idle rig"
        — is the misread this whole surface exists to prevent, so it is not cut:
        it is the second line of the same block, after the headline, and it is
        what makes the dot mean anything.

        A dot, not a triangle and a dot. The rail's grammar is a rail, a well, a
        dot and a word; carrying both a warning triangle and a critical dot put
        two red marks side by side in the left margin, which reads as two facts
        rather than one. The triangle still names the fault inside the
        disclosure, where it sits next to the sensor it is about.
      */}
      <div className="flex flex-wrap items-center gap-x-space-md gap-y-2">
        <span className="ant-dot ant-dot-critical shrink-0" aria-hidden="true" />

        <p className="min-w-0 flex-1">
          <span className="block text-balance font-title-md text-title-md text-on-surface">
            {fault.historical
              ? 'No sensor fault has been cleared since the last one recorded'
              : 'The prototype is isolated and no meter is being read'}
          </span>
          <span className="mt-0.5 block max-w-[96ch] font-body-md text-body-md text-on-surface-variant">
            {faultConsequence(fault)}
          </span>
        </p>

        <span
          className="shrink-0 rounded-full border border-error-fixed bg-[#FFFFFF] px-2.5 py-0.5 font-metric-value text-metric-value font-medium text-error"
          title={fault.at ?? undefined}
        >
          {latched}
        </span>

        <button
          type="button"
          className="ant-btn ant-btn-default h-8 shrink-0 px-2.5"
          onClick={onInspectHardware}
        >
          <CircuitBoard size={16} aria-hidden="true" />
          Check the bus
        </button>
      </div>

      {/* --- The reasoning, one click away --------------------------------- */}
      <div className="mt-2">
        <Disclosure
          tone="critical"
          label="Why this fault is latched, and what to check first"
          summary="Why this rail says what it says, and the first thing to check"
        >
          <dl className="flex flex-col gap-2">
            <Fact
              icon={<Radio size={14} aria-hidden="true" />}
              label="ESP32 controller"
              value={fault.devicePosting ? 'Posting on schedule' : 'Not posting'}
              tone={fault.devicePosting ? 'info' : 'critical'}
              body={
                fault.devicePosting
                  ? 'The device is alive and its heartbeat is current. That is the fact that makes the zeros below easy to misread.'
                  : 'No current heartbeat, so nothing below this point is live either way.'
              }
            />
            <Fact
              icon={<TriangleAlert size={14} aria-hidden="true" />}
              label="Metering sensors"
              value="Not being read"
              tone="critical"
              body="The device latched a hardware fault and isolated itself. Which part is missing is a diagnosis, not something this API reports."
            />
            <Note
              label="Consequence"
              tone="critical"
              body={`${fault.channelsAffected} channels are unattributable. Sensed channels are held at 'no reading' rather than rendered as a measured zero.`}
            />
          </dl>

          <p className="max-w-[64ch] font-body-sm text-body-sm text-on-surface-variant">
            Start with I2C presence for the ADS1015 and the INA226 on SDA GPIO 8 / SCL GPIO 9 — an absent
            address probe on a shared bus is the usual cause, not the sensors themselves.
          </p>

          <p className="max-w-[64ch] font-body-sm text-body-sm text-on-surface-variant">
            {fault.title} — no clearing event has been written since, so the fault is still latched. The
            full event, with its detail verbatim, is in the notification centre in the top bar.
          </p>
        </Disclosure>
      </div>
    </section>
  )
}

/**
 * A dt/dd pair inside the disclosure: the value the cell used to carry on the
 * permanent rail, with the explanation that used to sit under each cell.
 *
 * Merged into one element on purpose. They were the same fact at two
 * granularities — "Posting on schedule" above, "the device is alive and its
 * heartbeat is current" below, both about ESP32 — and two labelled lists with
 * identical headings is one list read twice.
 */
function Fact({
  icon,
  label,
  value,
  tone,
  body,
}: {
  icon: React.ReactNode
  label: string
  value: string
  tone: 'info' | 'critical'
  body: string
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="flex items-center gap-1.5 font-label-sm text-label-sm uppercase text-on-surface-variant">
        <span aria-hidden="true" className="text-on-surface-variant">
          {icon}
        </span>
        {label}
      </dt>
      <dd className="max-w-[76ch] font-body-sm text-body-sm text-on-surface-variant">
        <span className="flex items-center gap-1.5 font-title-md text-title-md text-on-surface">
          <span
            className={`ant-dot ${tone === 'critical' ? 'ant-dot-critical' : 'ant-dot-info'}`}
            aria-hidden="true"
          />
          {value}
        </span>
        <span className="mt-0.5 block">{body}</span>
      </dd>
    </div>
  )
}

/** A dt/dd pair inside the disclosure with no value of its own. */
function Note({ label, body, tone }: { label: string; body: string; tone: 'info' | 'critical' }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="flex items-center gap-1.5 font-label-sm text-label-sm uppercase text-on-surface-variant">
        <span
          className={`ant-dot ${tone === 'critical' ? 'ant-dot-critical' : 'ant-dot-info'}`}
          aria-hidden="true"
        />
        {label}
      </dt>
      <dd className="max-w-[76ch] font-body-sm text-body-sm text-on-surface-variant">{body}</dd>
    </div>
  )
}