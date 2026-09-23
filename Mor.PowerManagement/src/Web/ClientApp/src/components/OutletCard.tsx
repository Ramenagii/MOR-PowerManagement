import { Power } from 'lucide-react'
import type { Outlet } from '../types/dashboard'
import { formatWatts, isEnergizedOutlet, statusClass } from '../utils/dashboard'

type OutletCardProps = {
  outlet: Outlet
  onToggle: (id: number) => void
}

export function OutletCard({ outlet, onToggle }: OutletCardProps) {
  const percent = Math.min((outlet.watts / outlet.allowance) * 100, 100)
  const isEnergized = isEnergizedOutlet(outlet.status)

  return (
    <article className={`outlet-card ${statusClass(outlet.status)}`}>
      <div className="outlet-header">
        <div>
          <h3>{outlet.name}</h3>
          <p>{outlet.role}</p>
        </div>
        <span className={`status-badge ${statusClass(outlet.status)}`}>{outlet.status}</span>
      </div>
      <div className="outlet-reading">
        <strong>{formatWatts(outlet.watts)}</strong>
        <span>Allowance {formatWatts(outlet.allowance)}</span>
      </div>
      <div className="mini-meter">
        <div style={{ width: `${percent}%` }} />
      </div>
      <dl className="outlet-meta">
        <div>
          <dt>Rating</dt>
          <dd>{outlet.volts}V</dd>
        </div>
        <div>
          <dt>Priority</dt>
          <dd>{outlet.priority}</dd>
        </div>
        <div>
          <dt>Meter</dt>
          <dd>{outlet.meter}</dd>
        </div>
        <div>
          <dt>Switching</dt>
          <dd>{outlet.relay}</dd>
        </div>
        <div>
          <dt>Schedule</dt>
          <dd>{outlet.schedule}</dd>
        </div>
        <div>
          <dt>Idle limit</dt>
          <dd>{outlet.idleLimit}</dd>
        </div>
      </dl>
      <button type="button" className="icon-button" onClick={() => onToggle(outlet.id)}>
        <Power size={16} />
        {isEnergized ? 'Disconnect' : 'Request activation'}
      </button>
    </article>
  )
}
