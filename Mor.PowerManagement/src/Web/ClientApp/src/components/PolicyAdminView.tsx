import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, RotateCcw, Save, SlidersHorizontal, X } from 'lucide-react'
import { ApiError, fetchDashboardState, updateOutletPolicy, updateThresholds } from '../api'
import type { Outlet, Priority } from '../types/dashboard'
import { MetricCard } from './MetricCard'
import {
  PRIORITIES,
  PRIORITY_RANK,
  draftFrom,
  sameDraft,
  thresholdDiff,
  type OutletDraft,
  type SaveState,
  type ThresholdsForm,
} from './policyAdmin'

/**
 * Policy Administration -- the management half the thesis promises (roadmap M3).
 *
 * The backend already exposed both writes (PUT /Dashboard/thresholds and
 * PUT /Dashboard/outlets/{id}/policy); nothing in the client called them. This
 * view is the missing caller. There is no new API surface here, only a UI.
 *
 * Both commands are PARTIAL: only the fields present in the body are applied, so
 * every field saves on its own. That is what makes per-row saving safe -- a
 * priority change cannot accidentally rewrite an allowance.
 *
 * Design notes that matter:
 *   - Edits are staged in local state and diffed against the loaded snapshot.
 *     "Save" only sends what actually changed, and is disabled when nothing has.
 *   - A rejection from validation is surfaced rather than second-guessed. The
 *     server owns the rules (warning < critical, positive values); duplicating
 *     them here would create two sources of truth that drift.
 *   - Priority is the enum the backend actually stores: Low/Medium/High/Critical.
 *     Deliberately not the P0-P3 labels from the redesign mockup.
 */

export function PolicyAdminView() {
  const [snapshot, setSnapshot] = useState<{
    outlets: Outlet[]
    thresholds: ThresholdsForm
  } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [thresholdForm, setThresholdForm] = useState<ThresholdsForm | null>(null)
  const [thresholdState, setThresholdState] = useState<SaveState>('idle')
  const [thresholdMessage, setThresholdMessage] = useState<string | null>(null)

  const [drafts, setDrafts] = useState<Record<number, OutletDraft>>({})
  const [rowState, setRowState] = useState<Record<number, SaveState>>({})
  const [rowMessage, setRowMessage] = useState<Record<number, string | null>>({})

  const load = useCallback(async () => {
    try {
      const state = await fetchDashboardState()
      setSnapshot(state)
      setLoadError(null)
      return state
    } catch (cause) {
      setLoadError(cause instanceof ApiError && cause.status === 0 ? 'Backend unreachable' : String(cause))
      return null
    }
  }, [])

  useEffect(() => {
    void load().then((state) => {
      if (!state) return
      // Seed both forms from the same snapshot so the dirty-checks below have a
      // single, consistent baseline.
      setThresholdForm(state.thresholds)
      setDrafts(Object.fromEntries(state.outlets.map((o) => [o.id, draftFrom(o)])))
    })
  }, [load])

  // Outlet rows sorted worst-priority-first: the rows an operator needs to
  // reconsider during shedding are the ones already at the top.
  const rows = useMemo(() => {
    if (!snapshot) return []
    return [...snapshot.outlets].sort(
      (a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] || a.id - b.id,
    )
  }, [snapshot])

  const dirtyOutletIds = useMemo(() => {
    if (!snapshot) return new Set<number>()
    return new Set(
      snapshot.outlets
        .filter((outlet) => {
          const draft = drafts[outlet.id]
          return draft !== undefined && !sameDraft(draft, draftFrom(outlet))
        })
        .map((outlet) => outlet.id),
    )
  }, [snapshot, drafts])

  const setThresholdField = (field: keyof ThresholdsForm, value: number) => {
    setThresholdForm((current) => (current ? { ...current, [field]: value } : current))
    setThresholdState('idle')
  }

  const setDraftField = (id: number, field: keyof OutletDraft, value: string | number | null) => {
    setDrafts((current) => ({ ...current, [id]: { ...current[id], [field]: value } as OutletDraft }))
    setRowState((current) => ({ ...current, [id]: 'idle' }))
  }

  const saveThresholds = async () => {
    if (!thresholdForm || !snapshot) return
    setThresholdState('saving')
    setThresholdMessage(null)
    try {
      const diff = thresholdDiff(thresholdForm, snapshot.thresholds)
      if (Object.keys(diff).length === 0) {
        setThresholdState('idle')
        return
      }
      await updateThresholds(diff)
      // Re-read rather than trusting the local form: the server owns the rules.
      const state = await load()
      if (state) setThresholdForm(state.thresholds)
      setThresholdState('saved')
      setThresholdMessage('Thresholds updated. The device applies them on its next evaluation cycle.')
    } catch (cause) {
      setThresholdState('error')
      setThresholdMessage(
        cause instanceof ApiError
          ? `Rejected (${cause.status}). Warning must stay below critical, and all values must be positive.`
          : String(cause),
      )
    }
  }

  const saveOutlet = async (outlet: Outlet) => {
    const draft = drafts[outlet.id]
    if (!draft) return
    setRowState((current) => ({ ...current, [outlet.id]: 'saving' }))
    setRowMessage((current) => ({ ...current, [outlet.id]: null }))

    try {
      await updateOutletPolicy(outlet.id, {
        priority: draft.priority,
        allowanceWatts: draft.allowanceWatts,
        schedule: draft.schedule,
        // null means "exempt", which the command spells as clearIdleLimit.
        ...(draft.idleLimitMinutes === null
          ? { clearIdleLimit: true }
          : { idleLimitMinutes: draft.idleLimitMinutes }),
      })
      const state = await load()
      // Re-seed only this row from the server's response, so a clamp shows up.
      if (state) {
        const updated = state.outlets.find((o) => o.id === outlet.id)
        if (updated) setDrafts((current) => ({ ...current, [outlet.id]: draftFrom(updated) }))
      }
      setRowState((current) => ({ ...current, [outlet.id]: 'saved' }))
      setRowMessage((current) => ({ ...current, [outlet.id]: 'Policy saved.' }))
    } catch (cause) {
      setRowState((current) => ({ ...current, [outlet.id]: 'error' }))
      setRowMessage((current) => ({
        ...current,
        [outlet.id]: cause instanceof ApiError ? `Rejected (${cause.status}).` : String(cause),
      }))
    }
  }

  const revertOutlet = (outlet: Outlet) => {
    setDrafts((current) => ({ ...current, [outlet.id]: draftFrom(outlet) }))
    setRowState((current) => ({ ...current, [outlet.id]: 'idle' }))
    setRowMessage((current) => ({ ...current, [outlet.id]: null }))
  }

  if (loadError && !snapshot) {
    return (
      <section className="view-stack" aria-label="Policy Administration">
        <div className="page-heading">
          <div>
            <p className="eyebrow">Administration</p>
            <h2>Configuration unavailable</h2>
          </div>
        </div>
        <div className="panel">
          <p className="safe-note">
            {loadError} Administration reads the current configuration from
            <code> /Dashboard/state</code> and writes through
            <code> /Dashboard/thresholds</code> and <code> /Dashboard/outlets/{'{id}'}/policy</code>.
          </p>
        </div>
      </section>
    )
  }

  if (!snapshot || !thresholdForm) {
    return (
      <section className="view-stack" aria-label="Policy Administration">
        <div className="page-heading">
          <div>
            <p className="eyebrow">Administration</p>
            <h2>Loading configuration</h2>
          </div>
        </div>
        <div className="chart-empty">Reading the current thresholds and outlet policies...</div>
      </section>
    )
  }

  const thresholdDirty = Object.keys(thresholdDiff(thresholdForm, snapshot.thresholds)).length > 0
  const dirtyCount = dirtyOutletIds.size
  const shedOrder = rows.filter((o) => o.priority === 'Low').length
  return (
    <section className="view-stack" aria-label="Policy Administration">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Administration</p>
          <h2>Thresholds and outlet policy</h2>
        </div>
        <SlidersHorizontal size={22} />
      </div>

      <section className="overview-grid" aria-label="Configuration summary">
        <MetricCard
          icon={<SlidersHorizontal />}
          label="Capacity (P_limit)"
          value={`${thresholdForm.max} W`}
          note={`Warning ${thresholdForm.warning} W / Critical ${thresholdForm.critical} W`}
        />
        <MetricCard
          icon={<AlertTriangle />}
          label="Unsaved edits"
          value={`${(thresholdDirty ? 1 : 0) + dirtyCount}`}
          note={
            thresholdDirty || dirtyCount > 0
              ? 'Not yet written to the database'
              : 'In sync with the stored configuration'
          }
        />
        <MetricCard
          icon={<X />}
          label="First to shed"
          value={`${shedOrder} low-priority`}
          note="POL-05 sheds these before medium priority"
        />
      </section>

      <section className="panel wide-panel">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">System thresholds</p>
            <h2>POL-02 / POL-03 / POL-04 limits</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={() => void saveThresholds()}
            disabled={!thresholdDirty || thresholdState === 'saving'}
          >
            <Save size={16} />
            {thresholdState === 'saving' ? 'Saving...' : 'Save thresholds'}
          </button>
        </div>

        <div className="threshold-form">
          <label>
            <span>Max capacity (W)</span>
            <input
              type="number"
              min={1}
              step={10}
              value={thresholdForm.max}
              onChange={(e) => setThresholdField('max', Number(e.target.value))}
            />
          </label>
          <label>
            <span>Warning (W)</span>
            <input
              type="number"
              min={1}
              step={10}
              value={thresholdForm.warning}
              onChange={(e) => setThresholdField('warning', Number(e.target.value))}
            />
          </label>
          <label>
            <span>Critical (W)</span>
            <input
              type="number"
              min={1}
              step={10}
              value={thresholdForm.critical}
              onChange={(e) => setThresholdField('critical', Number(e.target.value))}
            />
          </label>
          <label>
            <span>Standby (W)</span>
            <input
              type="number"
              min={0}
              step={5}
              value={thresholdForm.standby}
              onChange={(e) => setThresholdField('standby', Number(e.target.value))}
            />
          </label>
          <label>
            <span>Standby idle (min)</span>
            <input
              type="number"
              min={0}
              step={1}
              value={thresholdForm.standbyIdleMinutes}
              onChange={(e) => setThresholdField('standbyIdleMinutes', Number(e.target.value))}
            />
          </label>
          <label>
            <span>Stabilization delay (ms)</span>
            <input
              type="number"
              min={0}
              step={50}
              value={thresholdForm.stabilizationDelayMs}
              onChange={(e) => setThresholdField('stabilizationDelayMs', Number(e.target.value))}
            />
          </label>
        </div>

        {thresholdForm.max > 0 && (
          <div className="threshold-preview">
            <div className="meter" aria-label="Threshold positions against capacity">
              <div
                className="warning-mark"
                style={{ left: `${(thresholdForm.warning / thresholdForm.max) * 100}%` }}
              />
              <div
                className="critical-mark"
                style={{ left: `${(thresholdForm.critical / thresholdForm.max) * 100}%` }}
              />
            </div>
            <p className="threshold-row">
              <span>0 W</span>
              <span>{`Warning ${Math.round((thresholdForm.warning / thresholdForm.max) * 100)}%`}</span>
              <span>{`Critical ${Math.round((thresholdForm.critical / thresholdForm.max) * 100)}%`}</span>
              <span>{`${thresholdForm.max} W`}</span>
            </p>
          </div>
        )}

        {thresholdMessage && (
          <p className={`save-message ${thresholdState}`} role="status">
            {thresholdMessage}
          </p>
        )}

        <p className="safe-note">
          Capacity, warning and critical are the limits POL-02, POL-03 and POL-04 evaluate
          against. Standby idle time and stabilization delay are the two timing inputs the
          firmware reads directly. Only changed fields are sent, so editing one value cannot
          overwrite another. Validation lives on the server; an out-of-order set is rejected
          there.
        </p>
      </section>
      <section className="panel wide-panel">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">Per-outlet policy</p>
            <h2>{`${rows.length} channels, shed order Low to Critical`}</h2>
          </div>
        </div>

        <div className="policy-table" role="table" aria-label="Outlet policy">
          <div className="policy-row policy-head" role="row">
            <span role="columnheader">Channel</span>
            <span role="columnheader">Priority</span>
            <span role="columnheader">Allowance (W)</span>
            <span role="columnheader">Schedule</span>
            <span role="columnheader">Idle limit</span>
            <span role="columnheader">Actions</span>
          </div>

          {rows.map((outlet) => {
            const draft = drafts[outlet.id]
            if (!draft) return null
            const dirty = dirtyOutletIds.has(outlet.id)
            const state = rowState[outlet.id] ?? 'idle'

            return (
              <div key={outlet.id} role="row" className={`policy-row ${dirty ? 'dirty' : ''}`}>
                <span role="cell" className="policy-channel">
                  <strong>{`CH${String(outlet.id).padStart(2, '0')}`}</strong>
                  <span>{outlet.name}</span>
                </span>

                <span role="cell">
                  <select
                    value={draft.priority}
                    aria-label={`Priority for ${outlet.name}`}
                    onChange={(e) => setDraftField(outlet.id, 'priority', e.target.value as Priority)}
                  >
                    {PRIORITIES.map((priority) => (
                      <option key={priority} value={priority}>
                        {priority}
                      </option>
                    ))}
                  </select>
                </span>

                <span role="cell">
                  <input
                    type="number"
                    min={0}
                    step={5}
                    value={draft.allowanceWatts}
                    aria-label={`Allowance watts for ${outlet.name}`}
                    onChange={(e) => setDraftField(outlet.id, 'allowanceWatts', Number(e.target.value))}
                  />
                </span>

                <span role="cell">
                  <input
                    type="text"
                    maxLength={200}
                    value={draft.schedule}
                    aria-label={`Schedule for ${outlet.name}`}
                    onChange={(e) => setDraftField(outlet.id, 'schedule', e.target.value)}
                  />
                </span>

                <span role="cell">
                  <input
                    type="number"
                    min={0}
                    step={1}
                    // An empty box is the exempt state; the backend spells it clearIdleLimit.
                    value={draft.idleLimitMinutes ?? ''}
                    placeholder="Exempt"
                    aria-label={`Idle limit minutes for ${outlet.name}`}
                    onChange={(e) =>
                      setDraftField(
                        outlet.id,
                        'idleLimitMinutes',
                        e.target.value === '' ? null : Number(e.target.value),
                      )
                    }
                  />
                </span>

                <span role="cell" className="policy-actions">
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => void saveOutlet(outlet)}
                    disabled={!dirty || state === 'saving'}
                  >
                    {state === 'saved' ? <CheckCircle2 size={16} /> : <Save size={16} />}
                    {state === 'saving' ? 'Saving...' : 'Save'}
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => revertOutlet(outlet)}
                    disabled={!dirty || state === 'saving'}
                    aria-label={`Revert edits for ${outlet.name}`}
                  >
                    <RotateCcw size={16} />
                  </button>
                  {rowMessage[outlet.id] && (
                    <span className={`save-message ${state}`}>{rowMessage[outlet.id]}</span>
                  )}
                </span>
              </div>
            )
          })}
        </div>

        <p className="safe-note">
          Priority drives the selective-response order in POL-05 and POL-06, and the
          preservation rule in POL-07 keeps High and Critical channels energized while lower
          priorities are shed. A blank idle limit marks the channel exempt from the POL-08
          standby shutdown. Rows are listed worst-priority-first, because those are the
          channels an operator reconsiders first during a shed.
        </p>
      </section>
      <section className="detail-grid two">
        <article className="info-card">
          <div className="info-icon">
            <Save />
          </div>
          <h3>Writes go to the real API</h3>
          <p>
            Threshold edits are sent to <code>PUT /Dashboard/thresholds</code> and row edits to
            <code> PUT /Dashboard/outlets/{'{id}'}/policy</code>. Both are partial updates and
            both are validated server-side. Saving writes to the same database the policies
            read from, so there is no local-only shadow state.
          </p>
        </article>
        <article className="info-card">
          <div className="info-icon">
            <X />
          </div>
          <h3>Device applies asynchronously</h3>
          <p>
            A saved threshold is persisted immediately, but the ESP32 reads it on its next
            evaluation cycle. Relay state will not visibly change until the device polls
            again, so a save confirmation is not a claim that a relay has already moved.
          </p>
        </article>
      </section>
    </section>
  )
}

