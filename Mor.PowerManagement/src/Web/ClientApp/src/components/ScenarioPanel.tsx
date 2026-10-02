import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  Database,
  Power,
  ShieldCheck,
  Zap,
} from 'lucide-react'

export type ScenarioNotice = {
  /**
   * live      - the batch was stored and the policy engine answered
   * simulated - the backend was unreachable, so nothing was written
   * error     - the write was attempted and rejected
   */
  tone: 'live' | 'simulated' | 'error'
  text: string
}

type ScenarioPanelProps = {
  onNormal: () => void
  onActivate: () => void
  onBlock: () => void
  onOverload: () => void
  onSelective: () => void
  onIdle: () => void
  notice: ScenarioNotice | null
  busy: boolean
}

/**
 * Defense scenario controls.
 *
 * These post a real telemetry batch to POST /api/Device/telemetry. The server
 * stores the rows, refreshes outlet state and evaluates POL-01..POL-08, so the
 * events reported in the notice are the policy engine's own output and the
 * Telemetry charts move at the same moment as the control action.
 *
 * The notice is deliberately explicit about which of those happened. A defense
 * panelist asking "did that actually record anything?" should be able to read
 * the answer off the screen, and when the backend is down the panel says so
 * rather than pretending the load was shed.
 */
export function ScenarioPanel({
  onNormal,
  onActivate,
  onBlock,
  onOverload,
  onSelective,
  onIdle,
  notice,
  busy,
}: ScenarioPanelProps) {
  const disabled = busy

  return (
    <section className="panel">
      <div className="section-heading compact">
        <div>
          <p className="eyebrow">Defense demo</p>
          <h2>Scenario controls</h2>
        </div>
        <ClipboardList size={20} />
      </div>

      <p className="scenario-honesty">
        <Database size={14} />
        Each scenario posts a real telemetry batch. The backend stores it and the policy
        engine raises the event, so the charts and the control action always tell the same
        story. The result line below reports what the server actually did.
      </p>

      <div className="scenario-grid">
        <button type="button" onClick={onNormal} disabled={disabled}>
          <CheckCircle2 size={16} />
          Normal operation
        </button>
        <button type="button" onClick={onActivate} disabled={disabled}>
          <Zap size={16} />
          Activate request
        </button>
        <button type="button" onClick={onBlock} disabled={disabled}>
          <AlertTriangle size={16} />
          Capacity block
        </button>
        <button type="button" onClick={onOverload} disabled={disabled}>
          <Zap size={16} />
          Post-activation overload
        </button>
        <button type="button" onClick={onSelective} disabled={disabled}>
          <ShieldCheck size={16} />
          Selective response
        </button>
        <button type="button" onClick={onIdle} disabled={disabled}>
          <Power size={16} />
          Idle shutdown
        </button>
      </div>

      {busy && (
        <p className="scenario-result" role="status">
          Posting telemetry batch...
        </p>
      )}

      {!busy && notice && (
        <p className={`scenario-result ${notice.tone}`} role="status">
          {notice.tone === 'live' && <Database size={14} />}
          {notice.text}
        </p>
      )}
    </section>
  )
}