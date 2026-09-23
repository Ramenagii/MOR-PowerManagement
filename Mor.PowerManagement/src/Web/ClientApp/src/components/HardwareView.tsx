import { Cable, Cpu, Plug, ShieldCheck, ToggleLeft, Zap } from 'lucide-react'

const perOutletParts = [
  'Grounded AC outlet/socket (or USB socket)',
  'Relay switching channel',
  'Shared mains PZEM-004T v3.0 energy meter on the common feed',
  'Outlet-specific firmware policy state',
  'Red rocker/manual switch or switch cap',
  'Rated-voltage label (220V, 110V, or 5V USB)',
]

const systemParts = [
  'ESP32 DevKit / ESP32-WROOM-32 controller',
  'Isolated 5 V supply such as Mean Well IRM-05-5',
  'Main switch near cord input',
  'Fuse or resettable breaker near input',
  'MOV after the fuse',
  'Live, neutral, and earth busbars',
  'Flame-retardant enclosure, grounded power cord, and strain relief',
]

const hardwareCards = [
  {
    icon: <Plug />,
    title: 'Thirteen control channels',
    body: '8x220V outlets plus a 110V instrument outlet and 4 USB sockets, each with relay switching and firmware state, metered by one mains PZEM.',
  },
  {
    icon: <Cpu />,
    title: 'ESP32 edge controller',
    body: 'The ESP32 runs local policy decisions, relay commands, sensor polling, and dashboard synchronization.',
  },
  {
    icon: <ShieldCheck />,
    title: 'Input support parts',
    body: 'A fuse or resettable breaker, MOV, main switch, and strain relief support safer prototype operation.',
  },
  {
    icon: <Cable />,
    title: 'Separated distribution',
    body: 'Live, neutral, and earth use separate distribution paths. Earth remains continuous and unswitched.',
  },
]

export function HardwareView() {
  return (
    <section className="view-stack" aria-label="Hardware components">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Hardware components</p>
          <h2>Locked prototype architecture</h2>
        </div>
        <Cpu size={22} />
      </div>

      <div className="detail-grid four">
        {hardwareCards.map((card) => (
          <article className="info-card" key={card.title}>
            <div className="info-icon">{card.icon}</div>
            <h3>{card.title}</h3>
            <p>{card.body}</p>
          </article>
        ))}
      </div>

      <section className="hardware-layout">
        <article className="panel hardware-detail-panel">
          <div className="section-heading compact">
            <div>
              <p className="eyebrow">Per outlet channel</p>
              <h2>Repeated thirteen times</h2>
            </div>
            <ToggleLeft size={20} />
          </div>
          <ul className="component-list">
            {perOutletParts.map((part) => (
              <li key={part}>{part}</li>
            ))}
          </ul>
        </article>

        <article className="panel hardware-detail-panel">
          <div className="section-heading compact">
            <div>
              <p className="eyebrow">System-level parts</p>
              <h2>Shared hardware</h2>
            </div>
            <Zap size={20} />
          </div>
          <ul className="component-list">
            {systemParts.map((part) => (
              <li key={part}>{part}</li>
            ))}
          </ul>
        </article>
      </section>

      <section className="panel wide-panel">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">Wiring basis</p>
            <h2>Relay and CT placement</h2>
          </div>
          <Cable size={20} />
        </div>
        <div className="wiring-chain" aria-label="Live conductor wiring sequence">
          <span>Live bus</span>
          <span>CT</span>
          <span>Relay COM</span>
          <span>Relay NO</span>
          <span>Outlet live</span>
        </div>
        <div className="detail-grid two">
          <article className="info-card compact-card">
            <h3>Neutral path</h3>
            <p>Neutral bus connects directly to each outlet neutral and is kept separate from live.</p>
          </article>
          <article className="info-card compact-card">
            <h3>Earth path</h3>
            <p>Earth bus connects continuously to outlet earth terminals and is never relay-switched.</p>
          </article>
        </div>
        <p className="safe-note">
          CTs must clamp only around their assigned outlet live branch. Clamping live and neutral
          together cancels the magnetic field and produces near-zero readings.
        </p>
      </section>
    </section>
  )
}
