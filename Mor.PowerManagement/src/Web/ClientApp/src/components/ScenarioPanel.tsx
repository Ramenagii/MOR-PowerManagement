import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  Power,
  RotateCcw,
  ShieldCheck,
  Zap,
} from 'lucide-react'

type ScenarioPanelProps = {
  onNormal: () => void
  onActivate: () => void
  onBlock: () => void
  onOverload: () => void
  onSelective: () => void
  onIdle: () => void
}

export function ScenarioPanel({
  onNormal,
  onActivate,
  onBlock,
  onOverload,
  onSelective,
  onIdle,
}: ScenarioPanelProps) {
  return (
    <section className="panel">
      <div className="section-heading compact">
        <div>
          <p className="eyebrow">Defense demo</p>
          <h2>Scenario controls</h2>
        </div>
        <ClipboardList size={20} />
      </div>
      <div className="scenario-grid">
        <button type="button" onClick={onNormal}>
          <RotateCcw size={16} />
          Normal operation
        </button>
        <button type="button" onClick={onActivate}>
          <CheckCircle2 size={16} />
          Activate request
        </button>
        <button type="button" onClick={onBlock}>
          <AlertTriangle size={16} />
          Capacity block
        </button>
        <button type="button" onClick={onOverload}>
          <Zap size={16} />
          Post-activation overload
        </button>
        <button type="button" onClick={onSelective}>
          <ShieldCheck size={16} />
          Selective response
        </button>
        <button type="button" onClick={onIdle}>
          <Power size={16} />
          Idle shutdown
        </button>
      </div>
    </section>
  )
}
