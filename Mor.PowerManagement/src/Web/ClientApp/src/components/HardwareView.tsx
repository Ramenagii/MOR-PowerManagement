import {
  Activity,
  Cable,
  ChevronRight,
  Cpu,
  Plug,
  ShieldCheck,
  ToggleLeft,
  TriangleAlert,
  Zap,
} from 'lucide-react'
import { Disclosure } from './Disclosure'

/**
 * Hardware -- the bill of materials and the wiring basis for the testing rig.
 *
 * Three facts drive this whole page, and all three have been wrong in earlier
 * revisions of this file:
 *
 *  1. The rig is FIVE channels: CH1-CH4 are 238 V AC outlets and CH5 is a 5 V
 *     USB socket. The earlier "thirteen control channels" card described the
 *     full build, not what is on the bench.
 *  2. The PZEM-004T v3.0 is RETIRED. What is fitted now is an ADS1220
 *     four-channel 16-bit ADC over SPI with a CT on EACH mains branch (CH1-CH4),
 *     which is why per-branch current is MEASURED rather than apportioned from a
 *     mains total. An INA226 sits on the 3.3 V DC supply rail as a standalone DC
 *     block — it is NOT the mains reference, and nothing else on the rig is. CH5
 *     has no sensor at all — its figure is the rail's nominal rating, and is
 *     labelled as nominal wherever it appears.
 *  3. The relay contacts are NORMALLY CLOSED. Power passes while the coil is
 *     idle, which means the pin HIGH is the energised channel and the pin LOW
 *     is the cut channel. That is the inverse of the NO relay most people wire
 *     first, and it is the single easiest thing on this build to get backwards.
 *
 * The relay truth is therefore stated three times: once as the banner, once as
 * the wiring chain, and once in the channel map's pin-state column. It is the
 * one place on this page allowed to be loud.
 *
 * Colour discipline (this page used to be a wall of chips): the NC truth table
 * owns the ONLY red on the screen, because it is a genuine hazard callout.
 * Everything else here is static documentation — rails, GPIO numbers, ADC
 * channels, part counts, wiring steps — and is rendered as plain text on
 * on-surface-variant, separated by hairlines and type weight rather than by
 * colour. Measured-vs-derived in the channel map is the one sanctioned
 * exception: a coloured dot plus neutral text, never a filled badge.
 */

const CHANNELS = [
  { channel: 'CH1', rail: '238 V AC', gpio: 10, adc: 'AIN0', sensed: true },
  { channel: 'CH2', rail: '238 V AC', gpio: 11, adc: 'AIN1', sensed: true },
  { channel: 'CH3', rail: '238 V AC', gpio: 12, adc: 'AIN2', sensed: true },
  { channel: 'CH4', rail: '238 V AC', gpio: 13, adc: 'AIN3', sensed: true },
  { channel: 'CH5', rail: '5 V DC USB', gpio: 14, adc: '—', sensed: false },
] as const

const perOutletParts = [
  'Grounded 238 V AC outlet (CH1-CH4) or USB socket (CH5)',
  'Normally-closed relay contact in the live conductor',
  'Branch current sensor on its own ADS1220 analogue channel (CH1-CH4 only)',
  'Per-channel firmware state: priority, allowance, schedule, idle limit',
  'Red rocker/manual switch or switch cap',
  'Rated-voltage label (238V mains or 5V USB)',
]

const systemParts = [
  'ESP32 DevKit / ESP32-WROOM-32 controller',
  'ADS1220 four-channel 16-bit ADC over SPI — one branch CT per mains outlet',
  'INA226 DC block on the 3.3V supply rail (100 mOhm shunt, 2 A range)',
  'I2C bus: SDA = GPIO 8, SCL = GPIO 9',
  'Inverting transistor driver per relay, GPIO 10 to GPIO 14',
  'Isolated 5 V supply such as Mean Well IRM-05-5',
  'Main switch near cord input',
  'Fuse or resettable breaker near input',
  'MOV after the fuse',
  'Live, neutral, and earth busbars',
  'Flame-retardant enclosure, grounded power cord, and strain relief',
]

/**
 * The truth table for one relay channel, stated as a table so it cannot be misremembered.
 *
 * The safe (powered) row is deliberately NOT green. This page owns exactly two
 * colours: red for the NC hazard callout, and neutral grey for "this is the
 * ordinary case". `ant-dot-normal` in the shared ant.css is still `bg-secondary`,
 * so the neutral dot is applied here as a utility (the utilities layer wins over
 * the components layer) instead of by editing shared CSS.
 */
const PIN_STATES = [
  ['HIGH', 'Coil idle', 'Contact CLOSED', 'Channel powered', 'bg-outline-variant'],
  ['LOW', 'Coil energised', 'Contact OPEN', 'Channel cut', 'bg-error'],
] as const

/** Live-conductor chain for one 238 V branch. NC, not NO. */
const LIVE_CHAIN = ['Live bus', 'Branch sensor', 'Relay COM', 'Relay NC', 'Outlet live'] as const

/**
 * The shared table-header step. `.ant-table-header` in ant.css sets body-md;
 * this pins the same 14px run to the title-md token so every column head in the
 * console is named by the same step rather than inheriting whichever parent
 * happened to set it.
 */
const TH = 'px-3 py-2.5 font-title-md text-title-md font-semibold'

export function HardwareView() {
  return (
    <section className="design-main" aria-label="Hardware components">
      {/* --- Breadcrumb ------------------------------------------------------ */}
      <nav aria-label="Breadcrumb" className="mb-space-sm flex items-center gap-space-sm">
        <span className="font-body-sm text-body-sm text-on-surface-variant">Console</span>
        <span className="font-body-sm text-body-sm text-outline-variant" aria-hidden>
          /
        </span>
        <strong className="font-body-sm text-body-sm font-semibold text-on-surface">Hardware</strong>
      </nav>

      {/* --- Page head ------------------------------------------------------- */}
      <header className="mb-space-lg flex flex-col gap-space-md lg:flex-row lg:items-end lg:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="font-headline-md text-headline-md text-on-surface">
            Locked prototype architecture
          </h1>
          <p className="max-w-3xl font-body-md text-body-md text-on-surface-variant">
            What the bench rig is built from and how it is wired. Five channels, one mains feed, one
            I2C bus, and normally-closed relay contacts throughout.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-x-space-lg gap-y-1 font-body-sm text-body-sm text-on-surface-variant">
          <span className="inline-flex items-center gap-1.5 font-semibold text-error">
            <span className="ant-dot ant-dot-critical" aria-hidden />
            NC contacts
          </span>
          <span>
            <span className="font-metric-value text-metric-value">5</span> channels
          </span>
        </div>
      </header>

      {/* --- The one loud thing ---------------------------------------------- */}
      <section
        className="ant-card mb-space-lg overflow-hidden border-l-4 border-l-error"
        aria-labelledby="relay-truth-heading"
      >
        <div className="ant-card-body flex flex-col gap-space-md">
          <div className="flex flex-wrap items-center gap-2">
            <TriangleAlert size={20} className="shrink-0 text-error" aria-hidden />
            <h2
              id="relay-truth-heading"
              className="font-title-lg text-title-lg font-semibold text-on-surface"
            >
              These relays are normally closed — pin HIGH powers the channel, pin LOW cuts it
            </h2>
            <span className="font-label-sm text-label-sm uppercase text-error">
              Inverted logic
            </span>
          </div>

          <p className="max-w-4xl font-body-md text-body-md text-on-surface-variant">
            Every channel uses a normally-closed (NC) contact. Power passes while the coil is idle, so
            the safe state of the driver is also the powered state of the channel. This is the exact
            inverse of a normally-open relay, where you energise the coil to switch the load on, and
            it is the most error-prone part of this build.
          </p>

          <div className="w-full overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead className="ant-table-header">
                <tr>
                  <th scope="col" className={`w-28 ${TH}`}>
                    GPIO pin
                  </th>
                  <th scope="col" className={`min-w-[150px] ${TH}`}>
                    Coil
                  </th>
                  <th scope="col" className={`min-w-[150px] ${TH}`}>
                    Contact
                  </th>
                  <th scope="col" className={TH}>
                    Result on this channel
                  </th>
                </tr>
              </thead>
              <tbody>
                {PIN_STATES.map(([pin, coil, contact, result, tone]) => (
                  <tr key={pin} className="ant-table-row border-l-2 border-l-transparent">
                    <td className="px-3 py-2.5 align-middle">
                      <code
                        className={`rounded px-2 py-0.5 font-metric-value text-metric-value font-semibold ${
                          tone === 'bg-error'
                            ? 'bg-error-container text-on-error-container'
                            : 'bg-surface-container text-on-surface'
                        }`}
                      >
                        {pin}
                      </code>
                    </td>
                    <td className="px-3 py-2.5 align-middle font-body-md text-body-md text-on-surface-variant">
                      {coil}
                    </td>
                    <td className="px-3 py-2.5 align-middle">
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          className={`ant-dot ${tone === 'bg-error' ? 'ant-dot-critical' : 'bg-outline-variant'}`}
                          aria-hidden
                        />
                        <span className="font-body-md text-body-md text-on-surface">{contact}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2.5 align-middle font-title-md text-title-md text-on-surface">
                      {result}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="rounded-md border border-error bg-error-container px-3 py-2 font-body-sm text-body-sm text-on-error-container">
            A firmware driver that assumes a normally-open relay will energise the coil on every
            channel at boot and cut power to the entire rig — and, worse, will report every channel as
            energised while the contacts are open. Firmware writes the pin HIGH to power a channel and
            LOW to cut it; nothing else in the codebase may assume otherwise.
          </p>
        </div>
      </section>

      {/* --- Four facts that decide everything else ---------------------------
          Five channels is this page's one hero figure, so it is the only card
          that wears metric-display; the three facts beside it are the same size
          as every other reading in the console and earn their place from the
          red rule and the label, not from a bigger numeral. */}
      <section
        className="mb-space-lg grid grid-cols-1 gap-space-md sm:grid-cols-2 xl:grid-cols-4"
        aria-label="Rig summary"
      >
        <article className="ant-card">
          <div className="ant-card-body flex h-full flex-col gap-space-sm p-space-md">
            <div className="flex items-center justify-between gap-space-sm">
              <span className="font-body-sm text-body-sm text-on-surface-variant">Control channels</span>
              <Plug size={18} className="text-on-surface-variant" aria-hidden />
            </div>
            <p className="font-metric-display text-metric-display text-on-surface flex items-baseline gap-1.5">
              5
              <span className="font-metric-value text-metric-value font-normal text-on-surface-variant">
                CH1–CH5
              </span>
            </p>
            <p className="font-metric-value text-metric-value text-on-surface-variant">
              CH1–CH4 · 238 V AC outlets
            </p>
            <p className="mt-auto font-metric-value text-metric-value text-outline">
              CH5 · 5 V USB socket
            </p>
          </div>
        </article>

        <article className="ant-card border-l-4 border-l-error">
          <div className="ant-card-body flex h-full flex-col gap-space-sm p-space-md">
            <div className="flex items-center justify-between gap-space-sm">
              <span className="font-body-sm text-body-sm text-on-surface-variant">Relay interface</span>
              <span className="font-body-sm text-body-sm font-semibold text-error">NC</span>
            </div>
            <p className="font-metric-value text-metric-value text-on-surface flex items-baseline gap-1.5">
              HIGH
              <span className="font-body-md text-body-md font-normal text-on-surface-variant">
                = on
              </span>
            </p>
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              Coil idle → contact closed
            </p>
            <p className="mt-auto font-body-sm text-body-sm text-outline">
              Pin LOW → contact opens, channel cut
            </p>
          </div>
        </article>

        <article className="ant-card">
          <div className="ant-card-body flex h-full flex-col gap-space-sm p-space-md">
            <div className="flex items-center justify-between gap-space-sm">
              <span className="font-body-sm text-body-sm text-on-surface-variant">Mains metering</span>
              <Activity size={18} className="text-on-surface-variant" aria-hidden />
            </div>
            <p className="font-metric-value text-metric-value text-on-surface flex items-baseline gap-1.5">
              ADS1220
              <span className="font-metric-value text-metric-value font-normal text-on-surface-variant">
                + branch CT
              </span>
            </p>
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              16-bit ADC over SPI · one CT per branch
            </p>
            <p className="mt-auto font-metric-value text-metric-value text-outline">
              INA226 · 3.3V DC rail
            </p>
          </div>
        </article>

        <article className="ant-card">
          <div className="ant-card-body flex h-full flex-col gap-space-sm p-space-md">
            <div className="flex items-center justify-between gap-space-sm">
              <span className="font-body-sm text-body-sm text-on-surface-variant">I2C bus</span>
              <Cpu size={18} className="text-on-surface-variant" aria-hidden />
            </div>
            <p className="font-metric-value text-metric-value text-on-surface flex items-baseline gap-1.5">
              8 / 9
              <span className="font-metric-value text-metric-value font-normal text-on-surface-variant">
                SDA / SCL
              </span>
            </p>
            <p className="font-metric-value text-metric-value text-on-surface-variant">
              INA226 · 3.3V DC rail
            </p>
            <p className="mt-auto font-metric-value text-metric-value text-outline">
              Relay GPIOs 10–14
            </p>
          </div>
        </article>
      </section>

      {/* --- Channel map ------------------------------------------------------ */}
      <section className="ant-card mb-space-lg overflow-hidden" aria-labelledby="channel-map-heading">
        <div className="ant-card-header">
          <div className="flex flex-wrap items-center gap-2">
            <ToggleLeft size={20} className="text-on-surface-variant" aria-hidden />
            <h2
              id="channel-map-heading"
              className="font-title-lg text-title-lg font-semibold text-on-surface"
            >
              Channel map
            </h2>
            <span className="font-metric-value text-metric-value text-on-surface-variant">GPIO 10–14</span>
          </div>
          <p className="max-w-md font-body-sm text-body-sm text-on-surface-variant">
            One relay pin and one analogue input per channel. Only the four mains branches are sensed.
          </p>
        </div>

        <div className="w-full overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead className="ant-table-header">
              <tr>
                <th scope="col" className={`min-w-[110px] ${TH}`}>
                  Channel
                </th>
                <th scope="col" className={`min-w-[140px] ${TH}`}>
                  Rail
                </th>
                <th scope="col" className={`min-w-[130px] ${TH} text-right`}>
                  Relay GPIO
                </th>
                <th scope="col" className={`min-w-[130px] ${TH}`}>
                  ADC input
                </th>
                <th scope="col" className={`min-w-[220px] ${TH}`}>
                  Load measurement
                </th>
              </tr>
            </thead>
            <tbody>
              {CHANNELS.map((channel) => (
                <tr key={channel.channel} className="ant-table-row border-l-2 border-l-transparent">
                  <td className="px-3 py-2.5 align-middle">
                    <span className="font-metric-value text-metric-value font-semibold text-on-surface">
                      {channel.channel}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 align-middle">
                    <span className="font-metric-value text-metric-value text-on-surface-variant">
                      {channel.rail}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 align-middle">
                    <span className="ant-table-num text-on-surface">{channel.gpio}</span>
                  </td>
                  <td className="px-3 py-2.5 align-middle">
                    <span
                      className={`font-metric-value text-metric-value ${
                        channel.sensed ? 'text-on-surface' : 'text-outline'
                      }`}
                    >
                      {channel.adc}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 align-middle">
                    {channel.sensed ? (
                      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                        <span className="ant-dot bg-outline-variant" aria-hidden />
                        <span className="font-body-md text-body-md text-on-surface-variant">
                          Measured — branch sensor
                        </span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                        <span className="ant-dot ant-dot-warning" aria-hidden />
                        <span className="font-body-md text-body-md text-on-surface-variant">
                          Nominal — no sensor on this branch
                        </span>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* --- Parts ------------------------------------------------------------ */}
      <div className="mb-space-lg grid grid-cols-1 gap-space-md xl:grid-cols-2">
        <section className="ant-card overflow-hidden" aria-labelledby="per-outlet-heading">
          <div className="ant-card-header">
            <div className="flex flex-wrap items-center gap-2">
              <Plug size={20} className="text-on-surface-variant" aria-hidden />
              <h2
                id="per-outlet-heading"
                className="font-title-lg text-title-lg font-semibold text-on-surface"
              >
                Repeated five times on the testing rig
              </h2>
            </div>
            <span className="font-body-sm text-body-sm text-on-surface-variant">Per channel</span>
          </div>
          <div className="ant-card-body">
            <ul className="flex list-disc flex-col gap-2 pl-5 marker:text-outline-variant">
              {perOutletParts.map((part) => (
                <li key={part}>
                  <span className="font-body-md text-body-md text-on-surface-variant">{part}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="ant-card overflow-hidden" aria-labelledby="system-parts-heading">
          <div className="ant-card-header">
            <div className="flex flex-wrap items-center gap-2">
              <Zap size={20} className="text-on-surface-variant" aria-hidden />
              <h2
                id="system-parts-heading"
                className="font-title-lg text-title-lg font-semibold text-on-surface"
              >
                Shared hardware
              </h2>
            </div>
            <span className="font-body-sm text-body-sm text-on-surface-variant">One of each</span>
          </div>
          <div className="ant-card-body">
            <ul className="flex list-disc flex-col gap-2 pl-5 marker:text-outline-variant">
              {systemParts.map((part) => (
                <li key={part}>
                  <span className="font-body-md text-body-md text-on-surface-variant">{part}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>

      {/* --- Wiring basis ----------------------------------------------------- */}
      <section className="ant-card mb-space-lg overflow-hidden" aria-labelledby="wiring-heading">
        <div className="ant-card-header">
          <div className="flex flex-wrap items-center gap-2">
            <Cable size={20} className="text-on-surface-variant" aria-hidden />
            <h2
              id="wiring-heading"
              className="font-title-lg text-title-lg font-semibold text-on-surface"
            >
              Wiring basis
            </h2>
          </div>
          <span className="font-label-sm text-label-sm uppercase text-error">
            NC, not NO
          </span>
        </div>

        <div className="ant-card-body flex flex-col gap-space-lg">
          <div>
            <p className="mb-2 font-label-sm text-label-sm uppercase text-on-surface-variant">
              Live conductor, one{' '}
              <span className="font-metric-value text-metric-value">238 V</span> branch
            </p>
            <div className="flex flex-wrap items-center gap-1" aria-label="Live conductor wiring sequence">
              {LIVE_CHAIN.map((step, index) => (
                <span key={step} className="flex items-center gap-1">
                  <span
                    className={`rounded-md px-2.5 py-1.5 font-body-sm text-body-sm ${
                      step === 'Relay NC'
                        ? 'bg-error-container font-semibold text-on-error-container'
                        : 'bg-surface-container text-on-surface'
                    }`}
                  >
                    {step}
                  </span>
                  {index < LIVE_CHAIN.length - 1 && (
                    <ChevronRight size={16} aria-hidden className="shrink-0 text-outline" />
                  )}
                </span>
              ))}
            </div>
            <p className="mt-2 font-body-sm text-body-sm text-on-surface-variant">
              The branch sensor sits ahead of the relay so the ADC still reads zero once the contact is
              open. The switched terminal is <strong className="text-on-surface">NC</strong>, not NO:
              the idle coil leaves the contact closed and the channel live.
            </p>
          </div>

          <div>
            <p className="mb-2 font-label-sm text-label-sm uppercase text-on-surface-variant">
              I2C bus
            </p>
            <div className="flex flex-wrap items-center gap-1" aria-label="I2C bus connections">
              {['ESP32 GPIO 8 · SDA', 'ESP32 GPIO 9 · SCL', 'INA226 @ 0x40'].map((step, index, all) => (
                <span key={step} className="flex items-center gap-1">
                  <span className="rounded-md bg-surface-container px-2.5 py-1.5 font-metric-value text-metric-value text-on-surface">
                    {step}
                  </span>
                  {index < all.length - 1 && (
                    <ChevronRight size={16} aria-hidden className="shrink-0 text-outline" />
                  )}
                </span>
              ))}
            </div>
            <p className="mt-2 font-body-sm text-body-sm text-on-surface-variant">
              The INA226 is the only device on this bus. The branch ADC is an{' '}
              <strong className="text-on-surface">ADS1220 on SPI</strong> — SCLK 12, MISO 13, MOSI 11,
              CS 10, DRDY 14 — so a wiring fault here affects the 3.3V DC block only, not the four
              mains branches.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-space-md md:grid-cols-3">
            <article className="rounded-md border border-outline-variant p-space-md">
              <h3 className="font-title-md text-title-md text-on-surface">Neutral path</h3>
              <p className="mt-1 font-body-sm text-body-sm text-on-surface-variant">
                Neutral bus connects directly to each outlet neutral and is kept separate from live.
                It is never switched.
              </p>
            </article>
            <article className="rounded-md border border-outline-variant p-space-md">
              <h3 className="font-title-md text-title-md text-on-surface">Earth path</h3>
              <p className="mt-1 font-body-sm text-body-sm text-on-surface-variant">
                Earth bus connects continuously to outlet earth terminals and is never
                relay-switched. Continuous earth outranks any switching function.
              </p>
            </article>
            <article className="rounded-md border border-outline-variant p-space-md">
              <div className="flex items-center gap-2">
                <h3 className="font-title-md text-title-md text-on-surface">USB rail</h3>
                <span className="font-label-sm text-label-sm uppercase text-on-surface-variant">
                  No sensor fitted
                </span>
              </div>
              <p className="mt-1 font-body-sm text-body-sm text-on-surface-variant">
                CH5 has no current sensor. Its reading is the 5 V rail’s nominal
                rating repeated across the window, so it must never be read as a measured zero or
                as a measured load.
              </p>
            </article>
          </div>

          {/*
            Two caveats that used to sit permanently at the foot of this card,
            each in its own wash. They are true and they matter, but they are
            notes about the build rather than steps in the wiring, and printed
            open they compete with the parts list above them for the same
            attention. A disclosure keeps them one click away on a page someone
            reads top to bottom, and off the critical path when they are not
            looking for them.
          */}
          <Disclosure
            label="Wiring caveats"
            summary="Two caveats about the sensing chain: CT placement, and the retired PZEM-004T"
          >
            <div className="grid grid-cols-1 gap-space-md md:grid-cols-2">
              <div className="flex items-start gap-space-sm rounded-md bg-surface-container-low p-space-sm">
                <TriangleAlert size={16} aria-hidden className="mt-0.5 shrink-0 text-on-surface-variant" />
                <p className="font-body-sm text-body-sm text-on-surface-variant">
                  Branch sensors must sit on their assigned outlet live branch only. Clamping live and
                  neutral together cancels the magnetic field and produces near-zero readings — the
                  classic reason a channel reads zero while the load is plainly on.
                </p>
              </div>
              <div className="flex items-start gap-space-sm rounded-md bg-surface-container-low p-space-sm">
                <Activity size={16} aria-hidden className="mt-0.5 shrink-0 text-on-surface-variant" />
                <p className="font-body-sm text-body-sm text-on-surface-variant">
                  The PZEM-004T v3.0 is retired and is not fitted to this rig. The roster still
                  carries a &ldquo;PZEM-01 &hellip; mains bus&rdquo; label on its meterChannel field from before
                  the ADS1220 conversion; it is a stale seed value, not a device, and the console does
                  not render it as a sensor name.
                </p>
              </div>
            </div>
          </Disclosure>
        </div>
      </section>

      {/* --- Closing note ------------------------------------------------------ */}
      <section className="ant-card" aria-labelledby="safety-heading">
        <div className="ant-card-body flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <ShieldCheck size={18} className="text-on-surface-variant" aria-hidden />
            <h2
              id="safety-heading"
              className="font-title-lg text-title-lg font-semibold text-on-surface"
            >
              Prototype scope, and what still protects the rig
            </h2>
          </div>
          <p className="max-w-4xl font-body-md text-body-md text-on-surface-variant">
            Firmware acts on these contacts, but firmware is not protection. Normally-closed contacts
            also mean a de-powered or unplugged controller leaves every channel <em>on</em>, not off —
            isolation has to come from the main switch and the upstream fuse. Physical safety still
            depends on properly rated fuses, wiring, terminals, enclosure design, and qualified
            review.
          </p>
        </div>
      </section>
    </section>
  )
}