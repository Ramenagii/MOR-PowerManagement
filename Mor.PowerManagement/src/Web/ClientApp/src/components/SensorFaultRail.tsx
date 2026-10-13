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
 * The grammar is the same one the provenance rails use across the console —
 * a rail, a well, a dot, a word — in its third state. It is not a toast, not a
 * modal and not a card in the grid, because all three of those are dismissible
 * or scrollable, and this must not be either.
 *
 * WHAT IS ON THE RAIL, AND WHY EACH LINE IS THERE:
 *
 *   · the headline, because it is the claim being made about the rig
 *   · the consequence in one sentence, because "0 W is not an idle rig" is the
 *     misread this whole surface exists to prevent
 *   · the device/sensor split as TWO VALUES — posting on schedule, not being
 *     read. That is the specific confusion a reader arrives with ("it says
 *     online"), and it survives without a paragraph under each cell
 *   · the backend's own sentence, verbatim, because it is the only statement
 *     about this fault written by the code that raised it
 *   · the action, because a rail that names a fault and stops is a dead end
 *
 * WHAT IS NOT ON THE RAIL:
 *
 *   The reasoning. Why a posting device still has no readings, which part is
 *   missing and where to start looking are all still here — they are one
 *   disclosure below the action, not deleted. A fault is the moment an operator
 *   reads, and a rail that spends its budget on its own justification is a rail
 *   that hides the fault behind the essay about it.
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
      className="wash-critical border-l-4 border-l-error px-space-lg py-space-md"
      role="alert"
      aria-live="polite"
      aria-label="Sensor fault: readings are not attributable"
    >
      <div className="flex flex-col gap-space-md">
        {/* --- Headline ----------------------------------------------------
            Two rows on a compact viewport, one from 768px up. The chip is
            `shrink-0` and roughly 180px wide, so inline it competes with the
            headline for the same 350px and squeezes it to one word per line —
            which is exactly the opposite of what a fault headline needs. */}
        <div className="flex flex-col gap-3 md:flex-row md:items-start">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <TriangleAlert size={22} className="mt-0.5 shrink-0 text-error" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="font-label-sm text-label-sm uppercase text-error">
                Critical · Sensor fault
              </p>
              <h2 className="text-balance font-headline-lg text-headline-lg text-on-surface">
                {fault.historical
                  ? 'No sensor fault has been cleared since the last one recorded'
                  : 'The prototype is isolated and no meter is being read'}
              </h2>
              <p className="mt-1 font-body-md text-body-md text-on-surface-variant">
                {faultConsequence(fault)}
              </p>
            </div>
          </div>
          <span
            className="self-start rounded-full border border-error-fixed bg-[#FFFFFF] px-2.5 py-1 font-metric-value text-metric-value font-medium text-error"
            title={fault.at ?? undefined}
          >
            {latched}
          </span>
        </div>

        {/* --- The two facts the "0 W" reading cannot survive ---------------
            Values, not explanations. "Posting on schedule" beside "Not being
            read" is the whole claim; the paragraph that used to sit under each
            cell repeated that claim in more words on the one screen where
            screen space is the scarcest thing in the console. */}
        <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-md border border-error-fixed bg-[#FBD9D5] md:grid-cols-2">
          <Fact
            icon={<Radio size={14} aria-hidden="true" />}
            label="ESP32 controller"
            value={fault.devicePosting ? 'Posting on schedule' : 'Not posting'}
            tone={fault.devicePosting ? 'info' : 'critical'}
          />
          <Fact
            icon={<TriangleAlert size={14} aria-hidden="true" />}
            label="Metering sensors"
            value="Not being read"
            tone="critical"
          />
        </dl>

        {/* --- The backend's own sentence, in the backend's own words -------- */}
        <div className="rounded-md border border-error-fixed bg-[#FFFFFF] px-3 py-2">
          <p className="font-label-sm text-label-sm uppercase text-on-surface-variant">
            From the event log, verbatim
          </p>
          <p className="mt-1 font-metric-value text-metric-value text-on-surface">{fault.detail}</p>
        </div>

        {/* --- Where to look next -------------------------------------------
            A pointer to the check, NOT the check itself. Which sensor is
            missing is a diagnosis; the API does not contain it and this console
            will not invent it from a symptom. */}
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="ant-btn ant-btn-default" onClick={onInspectHardware}>
            <CircuitBoard size={16} aria-hidden="true" />
            Check the bus and the parts list
          </button>
        </div>

        {/* --- The reasoning, one click away -------------------------------- */}
        <Disclosure
          tone="critical"
          label="Why this fault is latched, and what to check first"
          summary="Why this rail says what it says, and the first thing to check"
        >
          <dl className="flex flex-col gap-2">
            <Note
              label="ESP32 controller"
              tone={fault.devicePosting ? 'info' : 'critical'}
              body={
                fault.devicePosting
                  ? 'The device is alive and its heartbeat is current. That is the fact that makes the zeros below easy to misread.'
                  : 'No current heartbeat, so nothing below this point is live either way.'
              }
            />
            <Note
              label="Metering sensors"
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
            {fault.title} — no clearing event has been written since, so the fault is still latched.
          </p>
        </Disclosure>
      </div>
    </section>
  )
}

function Fact({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode
  label: string
  value: string
  tone: 'info' | 'critical'
}) {
  return (
    <div className="flex flex-col gap-1 bg-[#FFFFFF] px-3 py-2.5">
      <dt className="flex items-center gap-1.5 font-label-md text-label-md uppercase text-on-surface-variant">
        <span aria-hidden="true" className="text-on-surface-variant">
          {icon}
        </span>
        {label}
      </dt>
      <dd className="flex items-center gap-1.5 font-title-md text-title-md text-on-surface">
        <span
          className={`ant-dot ${tone === 'critical' ? 'ant-dot-critical' : 'ant-dot-info'}`}
          aria-hidden="true"
        />
        {value}
      </dd>
    </div>
  )
}

/** A dt/dd pair inside the disclosure — the explanation a cell no longer carries. */
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