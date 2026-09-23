import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, GitBranch, Lock, Power, ShieldCheck } from 'lucide-react'
import { fetchPolicies, type PolicyItem } from '../api'

const actions = [
  {
    code: 'ACT_ALLOW(i)',
    result: 'Closes the selected relay and starts a 500 ms stabilization delay.',
  },
  {
    code: 'ACT_DENY(i)',
    result: 'Prevents relay closure and logs insufficient capacity.',
  },
  {
    code: 'ACT_SHED(i)',
    result: 'Opens the selected relay to reduce total load and logs the shedding event.',
  },
  {
    code: 'ACT_PRESERVE(i)',
    result: 'Keeps a high-priority relay unchanged during active shedding.',
  },
  {
    code: 'ACT_FAULT()',
    result: 'Opens all relays, isolates the prototype, and sets critical lockout flags.',
  },
]

const fallbackPolicies: PolicyItem[] = [
  {
    id: 'POL-01',
    name: 'Hardware Fault Isolation',
    condition: 'S_fault is TRUE',
    action: 'ACT_FAULT()',
  },
  {
    id: 'POL-02',
    name: 'Pre-Activation Assessment',
    condition: 'Request(i) and P_total is below P_limit',
    action: 'ACT_ALLOW(i)',
  },
  {
    id: 'POL-03',
    name: 'Pre-Activation Denial',
    condition: 'Request(i) and P_total is at or above P_limit',
    action: 'ACT_DENY(i)',
  },
  {
    id: 'POL-04',
    name: 'Post-Activation Verification',
    condition: '500 ms after activation and P_total exceeds P_limit',
    action: 'ACT_SHED(i)',
  },
  {
    id: 'POL-05',
    name: 'Load Shedding Level 1',
    condition: 'P_total exceeds P_limit for low-priority energized outlets',
    action: 'ACT_SHED(i)',
  },
  {
    id: 'POL-06',
    name: 'Load Shedding Level 2',
    condition: 'Overload remains after low-priority shedding',
    action: 'ACT_SHED(i) for medium priority',
  },
  {
    id: 'POL-07',
    name: 'Priority Preservation',
    condition: 'High-priority outlet is active during shedding',
    action: 'ACT_PRESERVE(i)',
  },
  {
    id: 'POL-08',
    name: 'Standby Load Management',
    condition: 'P_branch_i stays below standby threshold for 30 minutes',
    action: 'ACT_SHED(i)',
  },
]

const contextVariables = [
  ['P_limit', 'Configured operating limit for the prototype extension'],
  ['P_total', 'Aggregate measured load from all outlet channels'],
  ['P_branch_i', 'Per-outlet measured load from the assigned PZEM and CT'],
  ['O_priority_i', 'Outlet priority index used for selective response order'],
  ['O_relay_i', 'Relay state reported by the ESP32 output channel'],
  ['S_fault', 'Sensor or communication health flag'],
]

export function PoliciesView() {
  // Live POL-01..POL-08 from the backend; static copy stays as offline fallback.
  const [policies, setPolicies] = useState<PolicyItem[]>(fallbackPolicies)

  useEffect(() => {
    fetchPolicies().then(setPolicies).catch(() => undefined)
  }, [])

  return (
    <section className="view-stack" aria-label="Policies">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Policy repository</p>
          <h2>Event-Condition-Action control logic</h2>
        </div>
        <ShieldCheck size={22} />
      </div>

      <div className="detail-grid three">
        <article className="info-card">
          <div className="info-icon">
            <GitBranch />
          </div>
          <h3>ECA polling loop</h3>
          <p>
            The ESP32 synchronizes outlet states, reads per-branch load data, evaluates policies,
            and executes deterministic relay actions.
          </p>
        </article>
        <article className="info-card">
          <div className="info-icon">
            <CheckCircle2 />
          </div>
          <h3>Branch activation</h3>
          <p>
            Activation uses pre-checking, relay closure, a 500 ms stabilization delay, and
            post-activation verification.
          </p>
        </article>
        <article className="info-card">
          <div className="info-icon">
            <Power />
          </div>
          <h3>Standby is energized</h3>
          <p>
            Standby outlets remain relay-connected, still count as active load channels, and remain
            eligible for idle policy enforcement.
          </p>
        </article>
      </div>

      <section className="panel wide-panel">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">Discrete commands</p>
            <h2>Action space</h2>
          </div>
          <Lock size={20} />
        </div>
        <div className="matrix-list">
          {actions.map((action) => (
            <article key={action.code} className="matrix-row">
              <strong>{action.code}</strong>
              <p>{action.result}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="panel wide-panel">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">Policy execution matrix</p>
            <h2>POL-01 to POL-08</h2>
          </div>
          <AlertTriangle size={20} />
        </div>
        <div className="policy-matrix">
          {policies.map((policy) => (
            <article key={policy.id} className="policy-card">
              <span>{policy.id}</span>
              <h3>{policy.name}</h3>
              <p>{policy.condition}</p>
              <strong>{policy.action}</strong>
            </article>
          ))}
        </div>
      </section>

      <section className="panel wide-panel">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">Context variables</p>
            <h2>Measured inputs for policy evaluation</h2>
          </div>
        </div>
        <div className="variable-grid">
          {contextVariables.map(([name, description]) => (
            <article key={name}>
              <strong>{name}</strong>
              <p>{description}</p>
            </article>
          ))}
        </div>
        <p className="safe-note">
          These policies define prototype control behavior only. Physical protection still depends
          on properly rated fuses, wiring, terminals, enclosure design, and qualified review.
        </p>
      </section>
    </section>
  )
}
