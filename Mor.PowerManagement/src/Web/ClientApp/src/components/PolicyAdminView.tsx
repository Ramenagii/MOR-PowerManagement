import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  FileDown,
  Info,
  LoaderCircle,
  Power,
  RotateCcw,
  Save,
  Search,
  SlidersHorizontal,
  TriangleAlert,
  Undo2,
  X,
} from 'lucide-react'
import { ApiError, fetchDashboardState, updateOutletPolicy, updateThresholds } from '../api'
import type { DashboardSnapshot } from '../api'
import type { Outlet, Priority } from '../types/dashboard'
import {
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
 *   - Thresholds live in WATTS. The FR-05/FR-06 sliders are a percent VIEW of
 *     that single value (see percentOfWatts / wattsFromPercent below) -- there is
 *     no second copy of the number to keep in sync.
 *   - Priority is the enum the backend actually stores: Low/Medium/High/Critical,
 *     described by its FR-07 shed position. Deliberately not the P0-P3 labels
 *     from the redesign mockup.
 */

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo
  return Math.min(Math.max(value, lo), hi)
}

/**
 * The single percent <-> watts binding used by both sliders and both number
 * boxes. Watts is the stored truth (it is what PUT /Dashboard/thresholds
 * takes), so percent is always DERIVED and never stored.
 */
function percentOfWatts(watts: number, maxWatts: number): number {
  if (!Number.isFinite(watts) || !Number.isFinite(maxWatts) || maxWatts <= 0) return 0
  return clamp(Math.round((watts / maxWatts) * 100), 0, 100)
}

function wattsFromPercent(percent: number, maxWatts: number): number {
  if (!Number.isFinite(percent) || !Number.isFinite(maxWatts) || maxWatts <= 0) return 0
  return clamp(Math.round((percent * maxWatts) / 100), 0, maxWatts)
}

function channelLabel(id: number): string {
  return `CH${String(id).padStart(2, '0')}`
}

function formatSeen(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}

/** Option copy states what the tier actually DOES under FR-07, not a label. */
const PRIORITY_OPTIONS: Array<{ value: Priority; label: string }> = [
  { value: 'Low', label: 'Low — shed first' },
  { value: 'Medium', label: 'Medium — secondary' },
  { value: 'High', label: 'High — protected' },
  { value: 'Critical', label: 'Critical — protected last' },
]

/**
 * Row state is reported as a dot plus a word, never as a filled pill: a table
 * with six rows should not carry six coloured chips. The dot carries the status
 * colour, and only two words borrow ink of their own -- DIRTY may use tertiary,
 * a rejected save must read as error.
 *
 * SYNCED and SAVED are the ordinary outcomes, so they wear the neutral outline
 * dot rather than the shared `ant-dot-normal` green. Green is not a state
 * colour in this console; a successful write is worth seeing, but it is not an
 * alarm, and amber/red stay reserved for edits-in-flight and rejections.
 */
type StatusPill = { label: string; ink: string; dot: string }

function statusPill(state: SaveState, dirty: boolean): StatusPill {
  if (state === 'error') return { label: 'REJECTED', ink: 'text-error', dot: 'ant-dot-critical' }
  if (state === 'saving') return { label: 'SAVING', ink: 'text-on-surface-variant', dot: 'ant-dot-warning' }
  if (state === 'saved') return { label: 'SAVED', ink: 'text-on-surface-variant', dot: 'bg-outline-variant' }
  if (dirty) return { label: 'DIRTY', ink: 'text-tertiary', dot: 'ant-dot-warning' }
  return { label: 'SYNCED', ink: 'text-on-surface-variant', dot: 'bg-outline-variant' }
}

/**
 * The shared table-header step. `.ant-table-header` in ant.css sets body-md;
 * this pins the same 14px run to the title-md token so every column head in the
 * console is named by the same step rather than inheriting whichever parent
 * happened to set it.
 */
const TH = 'px-3 py-2.5 font-title-md text-title-md font-semibold'

// ---------------------------------------------------------------------------
// Compound fields (Ant 32px input + unit suffix)
// ---------------------------------------------------------------------------

function UnitField({
  id,
  label,
  unit,
  value,
  onChange,
  hint,
  badge,
  min = 0,
  step = 1,
  required = false,
  disabled = false,
  placeholder,
}: {
  id: string
  label: string
  unit: string
  value: number | null
  onChange: (next: number | null) => void
  hint?: ReactNode
  badge?: ReactNode
  min?: number
  step?: number
  required?: boolean
  disabled?: boolean
  placeholder?: string
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="font-title-md text-title-md font-medium text-on-surface">
          {label}
          {required && <span className="ml-1 text-error">*</span>}
        </label>
        {badge ?? null}
      </div>
      <div
        className={`flex h-10 w-full overflow-hidden rounded-md border border-outline-variant shadow-sm ${
          disabled ? 'bg-surface-container' : 'bg-surface-container-lowest focus-within:border-primary'
        }`}
      >
        <input
          id={id}
          type="number"
          min={min}
          step={step}
          disabled={disabled}
          placeholder={placeholder}
          value={value ?? ''}
          onChange={(event) => {
            const raw = event.target.value
            onChange(raw === '' ? null : Number(raw))
          }}
          className="h-full min-w-0 flex-1 bg-transparent px-2.5 font-metric-value text-metric-value text-on-surface outline-none disabled:cursor-not-allowed disabled:text-outline"
        />
        <span className="flex h-full shrink-0 select-none items-center bg-surface-container px-2.5 font-metric-value text-metric-value text-on-surface-variant">
          {unit}
        </span>
      </div>
      {hint ? <p className="font-body-sm text-body-sm text-on-surface-variant">{hint}</p> : null}
    </div>
  )
}

/**
 * A percent slider and a percent number box over ONE stored watt value.
 *
 * Both controls emit percent; the handler converts to watts and hands the new
 * watt figure back. Nothing is stored twice, so moving the capacity field and
 * moving either slider can never disagree.
 */
function PercentField({
  id,
  label,
  watts,
  maxWatts,
  onWatts,
  tone = 'warning',
  hint,
}: {
  id: string
  label: string
  watts: number
  maxWatts: number
  onWatts: (next: number) => void
  tone?: 'warning' | 'critical'
  hint?: ReactNode
}) {
  const percent = percentOfWatts(watts, maxWatts)
  const disabled = maxWatts <= 0
  const critical = tone === 'critical'
  const Icon = critical ? TriangleAlert : Info

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <label
          htmlFor={id}
          className="flex items-center gap-1 font-title-md text-title-md font-medium text-on-surface"
        >
          <span>{label}</span>
          <Icon size={14} className={critical ? 'text-error' : 'text-outline'} aria-hidden="true" />
        </label>
        <span
          className={`whitespace-nowrap font-metric-value text-metric-value font-semibold ${
            critical ? 'text-error' : 'text-tertiary'
          }`}
        >
          {`${Math.round(watts).toLocaleString()} W (${percent}%)`}
        </span>
      </div>
      <div className="flex h-10 items-center gap-space-sm">
        <input
          id={id}
          type="range"
          min={0}
          max={100}
          step={1}
          value={percent}
          disabled={disabled}
          style={{ accentColor: critical ? '#ba1a1a' : '#7d5400' }}
          onChange={(event) => onWatts(wattsFromPercent(Number(event.target.value), maxWatts))}
          aria-label={`${label}, as a percentage of maximum capacity`}
          className={`h-1.5 min-w-0 flex-1 cursor-pointer rounded-full disabled:cursor-not-allowed ${
            critical ? 'bg-error-container' : 'bg-surface-container-high'
          }`}
        />
        <div className="flex h-10 w-20 shrink-0 overflow-hidden rounded-md border border-outline-variant bg-surface-container-lowest shadow-sm focus-within:border-primary">
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            value={percent}
            disabled={disabled}
            onChange={(event) => {
              const raw = event.target.value
              if (raw === '') return
              onWatts(wattsFromPercent(Number(raw), maxWatts))
            }}
            aria-label={`${label}, percentage`}
            className="h-full w-full min-w-0 bg-transparent px-1 text-center font-metric-value text-metric-value text-on-surface outline-none disabled:cursor-not-allowed"
          />
          <span className="flex h-full items-center bg-surface-container px-1.5 font-metric-value text-metric-value text-on-surface-variant">
            %
          </span>
        </div>
      </div>
      {disabled ? (
        <p className="font-body-sm text-body-sm text-outline">Set the maximum capacity first — this is a percentage of it.</p>
      ) : (
        hint
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export function PolicyAdminView() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [thresholdForm, setThresholdForm] = useState<ThresholdsForm | null>(null)
  const [thresholdState, setThresholdState] = useState<SaveState>('idle')
  const [thresholdMessage, setThresholdMessage] = useState<string | null>(null)

  const [drafts, setDrafts] = useState<Record<number, OutletDraft>>({})
  const [rowState, setRowState] = useState<Record<number, SaveState>>({})
  const [rowMessage, setRowMessage] = useState<Record<number, string | null>>({})

  // Table-local UI state: filter text, row selection, and the batch controls.
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  const [batchPriority, setBatchPriority] = useState('')
  const [batchBusy, setBatchBusy] = useState(false)

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
          ? `Rejected (${cause.status}). Warning must stay below critical; capacity, warning and critical must be positive.`
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

  // Sequential, so each row keeps its own PUT and its own reported outcome.
  const saveRows = async (ids: number[]) => {
    if (!snapshot || batchBusy) return
    setBatchBusy(true)
    try {
      for (const id of ids) {
        const outlet = snapshot.outlets.find((o) => o.id === id)
        if (outlet) await saveOutlet(outlet)
      }
    } finally {
      setBatchBusy(false)
    }
  }

  const revertAll = () => {
    if (!snapshot) return
    setThresholdForm(snapshot.thresholds)
    setDrafts(Object.fromEntries(snapshot.outlets.map((o) => [o.id, draftFrom(o)])))
    setThresholdState('idle')
    setThresholdMessage(null)
    setRowState({})
    setRowMessage({})
  }

  // The mockup shows an export affordance. Implemented honestly: it writes the
  // values on screen (drafts included, and labelled as such) to a local file.
  // Nothing is sent to the server, so it cannot masquerade as a save.
  const exportPolicy = () => {
    if (!snapshot || !thresholdForm) return
    const pending = (thresholdDirty ? 1 : 0) + dirtyOutletIds.size
    const payload = {
      exportedAt: new Date().toISOString(),
      source: 'GET /api/Dashboard/state',
      unsavedEdits: pending,
      note:
        pending > 0
          ? 'Includes unsaved on-screen drafts. Save the policies before treating this file as current.'
          : 'Matches the stored configuration.',
      thresholds: {
        maxCapacityWatts: thresholdForm.max,
        warningThresholdWatts: thresholdForm.warning,
        criticalThresholdWatts: thresholdForm.critical,
        warningPercent: percentOfWatts(thresholdForm.warning, thresholdForm.max),
        criticalPercent: percentOfWatts(thresholdForm.critical, thresholdForm.max),
        standbyThresholdWatts: thresholdForm.standby,
        standbyIdleMinutes: thresholdForm.standbyIdleMinutes,
        stabilizationDelayMs: thresholdForm.stabilizationDelayMs,
      },
      outlets: rows.map((outlet) => {
        const draft = drafts[outlet.id]
        return {
          channel: channelLabel(outlet.id),
          name: outlet.name,
          role: outlet.role,
          relay: outlet.relay,
          ratedVoltageVolts: outlet.volts,
          priority: draft?.priority ?? outlet.priority,
          allowanceWatts: draft?.allowanceWatts ?? outlet.allowance,
          schedule: draft?.schedule ?? outlet.schedule,
          idleLimitMinutes:
            draft?.idleLimitMinutes ??
            (outlet.idleLimit === 'Exempt' ? null : Number.parseInt(outlet.idleLimit, 10)),
        }
      }),
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'mor-policy-config.json'
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  // ----- derived values -----

  const thresholdDirty = Boolean(
    snapshot && thresholdForm && Object.keys(thresholdDiff(thresholdForm, snapshot.thresholds)).length > 0,
  )
  const dirtyCount = dirtyOutletIds.size
  const editCount = (thresholdDirty ? 1 : 0) + dirtyCount
  const maxWatts = thresholdForm ? thresholdForm.max : 0

  const dirtyIds = useMemo(
    () => rows.filter((o) => dirtyOutletIds.has(o.id)).map((o) => o.id),
    [rows, dirtyOutletIds],
  )

  const selectedDirtyIds = useMemo(
    () => rows.filter((o) => selected.has(o.id) && dirtyOutletIds.has(o.id)).map((o) => o.id),
    [rows, selected, dirtyOutletIds],
  )

  const visibleRows = useMemo(() => {
    const query = filter.trim().toLowerCase()
    if (!query) return rows
    return rows.filter((outlet) =>
      `${channelLabel(outlet.id)} ${outlet.name} ${outlet.role} ${outlet.relay} ${outlet.priority} ${outlet.volts}V`
        .toLowerCase()
        .includes(query),
    )
  }, [rows, filter])

  const allVisibleSelected = visibleRows.length > 0 && visibleRows.every((o) => selected.has(o.id))
  const someVisibleSelected = visibleRows.some((o) => selected.has(o.id))

  const totalAllocated = useMemo(() => {
    let sum = 0
    for (const outlet of rows) {
      const draft = drafts[outlet.id]
      const candidate = draft ? draft.allowanceWatts : outlet.allowance
      sum += Number.isFinite(candidate) ? candidate : 0
    }
    return sum
  }, [rows, drafts])

  const oversubscription = maxWatts > 0 ? totalAllocated / maxWatts : 0
  const shedCount = rows.filter((o) => o.priority === 'Low').length

  const saveAll = async () => {
    if (batchBusy) return
    setBatchBusy(true)
    try {
      if (thresholdDirty) await saveThresholds()
      await saveRows(dirtyIds)
    } finally {
      setBatchBusy(false)
    }
  }

  const toggleSelectAll = () => {
    setSelected((current) => {
      const next = new Set(current)
      if (allVisibleSelected) visibleRows.forEach((o) => next.delete(o.id))
      else visibleRows.forEach((o) => next.add(o.id))
      return next
    })
  }

  const toggleRow = (id: number) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Batch priority stages the change only. It does not write: each selected row
  // still needs its own PUT, which is what the Apply/Save-selected buttons do.
  const applyBatchPriority = (value: string) => {
    setBatchPriority('')
    if (!value) return
    const priority = value as Priority
    const targets = rows.filter((o) => selected.has(o.id)).map((o) => o.id)
    if (targets.length === 0) return
    setDrafts((current) => {
      const next = { ...current }
      for (const id of targets) {
        if (next[id]) next[id] = { ...next[id], priority }
      }
      return next
    })
    setRowState((current) => {
      const next = { ...current }
      for (const id of targets) next[id] = 'idle'
      return next
    })
  }

  // ----- states before any data exists -----

  const pageFrame = (body: ReactNode, title: string, subtitle: ReactNode) => (
    <section className="flex flex-col gap-space-lg" aria-label="Policy Administration">
      <div className="flex flex-col gap-1">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 font-body-sm text-body-sm text-on-surface-variant">
          <span>Console</span>
          <span className="text-outline">/</span>
          <span className="font-medium text-on-surface">Policy Admin</span>
        </nav>
        <h1 className="font-headline-md text-headline-md tracking-tight text-on-surface">{title}</h1>
        <p className="max-w-3xl font-body-md text-body-md text-on-surface-variant">{subtitle}</p>
      </div>
      {body}
    </section>
  )

  if (loadError && !snapshot) {
    return pageFrame(
      <div className="ant-card">
        <div className="ant-card-body flex flex-col items-start gap-2">
          <div className="flex items-center gap-2">
            <span className="ant-dot ant-dot-critical" />
            <span className="font-title-lg text-title-lg font-semibold text-on-surface">
              Configuration unavailable
            </span>
            <span className="font-body-sm text-body-sm uppercase tracking-wide text-on-surface-variant">
              Offline
            </span>
          </div>
          <p className="font-body-md text-body-md text-on-surface-variant">{loadError}</p>
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            Administration reads the current configuration from
            <code className="font-metric-value text-metric-value text-on-surface"> GET /Dashboard/state </code>
            and writes through
            <code className="font-metric-value text-metric-value text-on-surface"> PUT /Dashboard/thresholds </code>
            and
            <code className="font-metric-value text-metric-value text-on-surface">
              PUT /Dashboard/outlets/&#123;id&#125;/policy
            </code>
            . Sign in again once the backend is reachable.
          </p>
          <button type="button" className="ant-btn ant-btn-default" onClick={() => void load()}>
            <RotateCcw size={16} className="text-outline" />
            Try again
          </button>
        </div>
      </div>,
      'Configuration unavailable',
      'The console could not reach the policy API, so no stored configuration is loaded and nothing can be written.',
    )
  }

  if (!snapshot || !thresholdForm) {
    return pageFrame(
      <div className="ant-card">
        <div className="ant-card-body flex items-center gap-space-sm font-body-md text-body-md text-on-surface-variant">
          <LoaderCircle size={16} className="animate-spin text-primary" />
          Reading the current thresholds and outlet policies from the dashboard state endpoint...
        </div>
      </div>,
      'Loading configuration',
      'Fetching P_limit, the FR-05/FR-06 thresholds and every channel policy before the forms are seeded.',
    )
  }

  // ----- render -----

  const thresholdPendingFields = Object.keys(thresholdDiff(thresholdForm, snapshot.thresholds)).length
  const orderingBroken = thresholdForm.max <= 0 || thresholdForm.warning >= thresholdForm.critical

  return (
    <section className="flex flex-col gap-space-lg" aria-label="Policy Administration">
      {/* Operational breadcrumb, title and page-level toolbar

          THE ROW BREAKS AT 2xl, NOT AT lg, AND THAT IS THE WHOLE FIX.

          This header used to go side-by-side at `lg` (1024px). At the real
          measurement width — 1368px, which is `xl` in this project's own
          breakpoints (xl = 1200, 2xl = 1440) — the left block wanted 768px of
          `max-w-3xl` description and the right block wanted about 430px of
          buttons, and the 1304px content column had roughly 75px between them.
          That is not slack. It is enough room only if nothing wraps, so the
          first thing to give was the button group, and `shrink-0` on that group
          made sure it was the buttons and not the title that compressed.

          `2xl` is the first width at which the frame is genuinely capped and
          both blocks have real room: below it the page column grows with the
          viewport, so the header is stacked and the action group wraps as a
          unit instead of squeezing. Nothing is hidden at any width — the
          title, the unsaved count and all three actions are always present and
          always labelled, and Export collapses to its icon only in the
          intermediate range where the group is tight, never below that. */}
      <div className="flex flex-col gap-space-md 2xl:flex-row 2xl:items-end 2xl:justify-between">
        <div className="flex flex-col gap-1">
          <nav
            aria-label="Breadcrumb"
            className="flex items-center gap-1.5 font-body-sm text-body-sm text-on-surface-variant"
          >
            <span>Console</span>
            <span className="text-body-sm text-outline">/</span>
            <span className="font-medium text-on-surface">Policy Admin</span>
          </nav>
          <div className="mt-1 flex flex-wrap items-center gap-space-sm">
            <h1 className="font-headline-md text-headline-md tracking-tight text-on-surface">
              Policy &amp; Threshold Admin
            </h1>
            <span className="inline-flex items-center gap-1.5 rounded bg-surface-container-high px-2 py-0.5 font-body-sm text-body-sm font-medium text-on-surface-variant">
              {/* In sync is the ordinary state, so it gets the neutral outline
                  dot rather than the shared `ant-dot-normal` green. */}
              <span className={`ant-dot ${editCount > 0 ? 'ant-dot-warning' : 'bg-outline-variant'}`} />
              {editCount > 0 ? (
                <>
                  <span className="font-metric-value text-metric-value">{editCount}</span> unsaved{' '}
                  {editCount === 1 ? 'change' : 'changes'}
                </>
              ) : (
                'In sync with stored configuration'
              )}
            </span>
          </div>
          <p className="max-w-3xl font-body-md text-body-md text-on-surface-variant">
            Granular power caps, load-shedding priority tiers and hardware protection limits. Direct register
            dispatch.
          </p>
        </div>
        {/* `shrink-0` is gone. It was the reason the group squeezed rather than
            wrapped: it refused to give width, so the buttons themselves had to
            compress. Wrapping as a unit keeps every control at its natural
            size and moves the whole group to the next line instead. */}
        <div className="flex flex-wrap items-center gap-space-sm">
          <button
            type="button"
            className="ant-btn ant-btn-default"
            onClick={revertAll}
            disabled={editCount === 0 || batchBusy}
          >
            <Undo2 size={16} className="text-outline" />
            Discard edits
          </button>
          {/* Export writes nothing to the device and reads nothing back — it is
              the lowest-value action of the three, so it is the one that gives
              up its label first. The button keeps its accessible name at every
              width (`aria-label` plus `title`), so the icon is never the only
              thing naming it. */}
          <button
            type="button"
            className="ant-btn ant-btn-default"
            onClick={exportPolicy}
            aria-label="Export the current policy configuration as JSON"
            title="Export the current policy configuration as JSON"
          >
            <FileDown size={16} className="text-outline" />
            {/* `hidden 2xl:inline`, not `2xl:inline` alone: a span is already
                inline, so a bare `2xl:inline` would leave the label on screen at
                every width and collapse nothing. */}
            <span className="hidden 2xl:inline">Export JSON</span>
          </button>
          <button
            type="button"
            className="ant-btn ant-btn-primary"
            onClick={() => void saveAll()}
            disabled={editCount === 0 || batchBusy}
          >
            {batchBusy ? (
              <LoaderCircle size={16} className="animate-spin" />
            ) : (
              <Save size={16} />
            )}
            {batchBusy ? 'Saving...' : 'Save All Changes'}
          </button>
        </div>
      </div>

      {/* SECTION 1 — Global System Thresholds */}
      <section className="ant-card overflow-hidden" aria-labelledby="thresholds-heading">
        <div className="ant-card-header flex-col items-stretch sm:flex-row sm:items-center">
          <div className="flex flex-wrap items-center gap-2">
            <SlidersHorizontal size={20} className="text-primary" aria-hidden="true" />
            <h2
              id="thresholds-heading"
              className="font-title-lg text-title-lg font-semibold text-on-surface"
            >
              Global System Thresholds
            </h2>
            <code className="font-metric-value text-metric-value text-on-surface-variant">
              PUT /api/Dashboard/thresholds
            </code>
          </div>
          <div className="flex flex-wrap items-center gap-space-sm">
            <span className="flex items-center gap-1.5 font-body-sm text-body-sm text-on-surface-variant">
              <span
                className={`ant-dot ${snapshot.deviceOnline ? 'bg-outline-variant' : 'ant-dot-warning'}`}
              />
              {snapshot.deviceOnline ? 'Device online' : 'Device offline'}
              {snapshot.deviceLastSeen ? (
                <>
                  {' · seen '}
                  <span className="font-metric-value text-metric-value">
                    {formatSeen(snapshot.deviceLastSeen)}
                  </span>
                </>
              ) : null}
            </span>
            <button
              type="button"
              className="ant-btn ant-btn-default"
              onClick={() => void saveThresholds()}
              disabled={!thresholdDirty || thresholdState === 'saving'}
            >
              {thresholdState === 'saving' ? (
                <LoaderCircle size={16} className="animate-spin" />
              ) : (
                <Save size={16} />
              )}
              {thresholdState === 'saving' ? 'Saving' : 'Save thresholds'}
            </button>
          </div>
        </div>

        <div className="ant-card-body grid grid-cols-1 gap-space-lg md:grid-cols-2 xl:grid-cols-3">
          <UnitField
            id="threshold-max"
            label="Maximum System Capacity"
            unit="W"
            required
            min={1}
            step={10}
            value={thresholdForm.max}
            onChange={(next) => setThresholdField('max', next ?? 0)}
            badge={
              <span className="whitespace-nowrap font-metric-value text-metric-value text-on-surface-variant">
                FR-04
              </span>
            }
            hint="Main master circuit breaker trip ceiling. Both sliders below are a percentage of this value."
          />
          <PercentField
            id="threshold-warning"
            label="Warning Load Threshold"
            watts={thresholdForm.warning}
            maxWatts={maxWatts}
            onWatts={(next) => setThresholdField('warning', next)}
            hint="Telemetry warning and alert webhooks fire here (FR-05)."
          />
          <PercentField
            id="threshold-critical"
            label="Critical Trip Threshold"
            tone="critical"
            watts={thresholdForm.critical}
            maxWatts={maxWatts}
            onWatts={(next) => setThresholdField('critical', next)}
            hint="Initiates progressive load shedding (FR-06 → FR-07)."
          />
          <UnitField
            id="threshold-standby"
            label="Standby Detection Cutoff"
            unit="W"
            min={0}
            step={5}
            value={thresholdForm.standby}
            onChange={(next) => setThresholdField('standby', next ?? 0)}
            hint="Channels below this load qualify as idle state."
          />
          <UnitField
            id="threshold-standby-idle"
            label="Standby Idle Timeout"
            unit="min"
            min={0}
            step={1}
            value={thresholdForm.standbyIdleMinutes}
            onChange={(next) => setThresholdField('standbyIdleMinutes', next ?? 0)}
            badge={
              <span className="whitespace-nowrap font-metric-value text-metric-value text-on-surface-variant">
                FR-10
              </span>
            }
            hint="How long an idle load persists before the relay cuts."
          />
          <UnitField
            id="threshold-stabilization"
            label="Post-Trip Stabilization Delay"
            unit="ms"
            min={0}
            step={50}
            value={thresholdForm.stabilizationDelayMs}
            onChange={(next) => setThresholdField('stabilizationDelayMs', next ?? 0)}
            hint="Bus hysteresis enforced before shed channels are reconnected."
          />
        </div>

        {orderingBroken && (
          <div
            role="alert"
            className="mx-space-lg mb-space-lg wash-critical flex items-start gap-2 px-3 py-2 text-body-sm text-on-surface"
          >
            <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              {maxWatts <= 0
                ? 'Maximum system capacity must be above zero before the FR-05 and FR-06 percentages can be placed on a slider.'
                : `Warning (${Math.round(thresholdForm.warning).toLocaleString()} W) is not below critical (${Math.round(
                    thresholdForm.critical,
                  ).toLocaleString()} W). The server rejects this set — lower the warning or raise the critical.`}
            </span>
          </div>
        )}

        {thresholdMessage && (
          <p
            role="status"
            className={`mx-space-lg mb-space-lg px-3 py-2 font-body-sm text-body-sm ${
              thresholdState === 'error'
                ? 'wash-critical'
                : 'wash-quiet'
            }`}
          >
            {thresholdMessage}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-outline-variant bg-surface-container-low px-space-lg py-2.5 font-body-sm text-body-sm text-on-surface-variant">
          <div className="flex flex-wrap items-center gap-space-sm">
            <span>Partial update — only changed fields are sent</span>
            <span className="text-outline">·</span>
            <span>
              {thresholdPendingFields > 0 ? (
                <>
                  <span className="font-metric-value text-metric-value">{thresholdPendingFields}</span>{' '}
                  threshold {thresholdPendingFields === 1 ? 'field' : 'fields'} pending
                </>
              ) : (
                'No pending threshold changes'
              )}
            </span>
            <span className="text-outline">·</span>
            <span className="flex items-center gap-1.5">
              <span
                className={`ant-dot ${
                  thresholdState === 'error'
                    ? 'ant-dot-critical'
                    : thresholdState === 'saving'
                      ? 'ant-dot-warning'
                      : thresholdDirty
                        ? 'ant-dot-warning'
                        : 'bg-outline-variant'
                }`}
              />
              <span className="text-on-surface-variant">
                {thresholdState === 'saving'
                  ? 'Writing to the device config'
                  : thresholdState === 'saved'
                    ? 'Thresholds saved'
                    : thresholdDirty
                      ? 'Unsaved threshold edits'
                      : 'Thresholds synced'}
              </span>
            </span>
          </div>
          <span>Validation lives on the server — FR-04, FR-05 and FR-06 limits.</span>
        </div>
      </section>

      {/* SECTION 2 — Granular Channel Policy Table */}
      <section className="ant-card overflow-hidden" aria-labelledby="policy-heading">
        <div className="ant-card-header flex-col items-stretch md:flex-row md:items-center">
          <div className="flex flex-wrap items-center gap-2">
            <Power size={20} className="text-primary" aria-hidden="true" />
            <h2 id="policy-heading" className="font-title-lg text-title-lg font-semibold text-on-surface">
              Granular Channel Policy Table ({rows.length} {rows.length === 1 ? 'channel' : 'channels'})
            </h2>
            <code className="font-metric-value text-metric-value text-on-surface-variant">
              PUT /api/Dashboard/outlets/&#123;id&#125;/policy
            </code>
          </div>
          <div className="flex flex-wrap items-center gap-space-sm">
            {dirtyCount > 0 && (
              <span className="inline-flex items-center gap-1.5 font-body-sm text-body-sm uppercase tracking-wide text-tertiary">
                <span className="ant-dot ant-dot-warning" aria-hidden="true" />
                <span className="font-metric-value text-metric-value">{dirtyCount}</span> unsaved row
                {dirtyCount === 1 ? '' : 's'}
              </span>
            )}
            <div className="flex h-10 w-40 items-center gap-1.5 rounded-md border border-outline-variant bg-surface-container-lowest px-2.5 shadow-sm focus-within:border-primary sm:w-56">
              <Search size={14} className="shrink-0 text-outline" aria-hidden="true" />
              <input
                type="search"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter channels..."
                aria-label="Filter channels"
                className="min-w-0 flex-1 bg-transparent text-body-sm text-on-surface outline-none placeholder:text-outline"
              />
              {filter && (
                <button
                  type="button"
                  onClick={() => setFilter('')}
                  aria-label="Clear channel filter"
                  className="shrink-0 text-outline transition-colors hover:text-on-surface"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="w-full overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead className="ant-table-header">
              <tr>
                <th scope="col" className="w-9 px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    ref={(node) => {
                      if (node) node.indeterminate = !allVisibleSelected && someVisibleSelected
                    }}
                    onChange={toggleSelectAll}
                    aria-label="Select all listed channels"
                    className="h-4 w-4 cursor-pointer align-middle accent-primary"
                  />
                </th>
                <th scope="col" className={`min-w-[180px] ${TH}`}>
                  Channel
                </th>
                <th scope="col" className={TH}>
                  Voltage
                </th>
                <th scope="col" className={`min-w-[190px] ${TH}`}>
                  Priority Tier
                </th>
                <th scope="col" className={`min-w-[130px] ${TH} text-right`}>
                  Cap Limit (W)
                </th>
                <th scope="col" className={`min-w-[150px] ${TH}`}>
                  Schedule
                </th>
                <th scope="col" className={`min-w-[110px] ${TH} text-right`}>
                  Idle Limit
                </th>
                <th scope="col" className={TH}>
                  State
                </th>
                <th scope="col" className={`min-w-[150px] ${TH} text-right`}>
                  Action
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((outlet) => {
                const draft = drafts[outlet.id]
                if (!draft) return null
                const dirty = dirtyOutletIds.has(outlet.id)
                const state = rowState[outlet.id] ?? 'idle'
                const pill = statusPill(state, dirty)
                const isSelected = selected.has(outlet.id)
                const message = rowMessage[outlet.id]

                return (
                  <tr
                    key={outlet.id}
                    className={`ant-table-row border-l-2 ${
                      isSelected
                        ? 'border-l-primary'
                        : dirty
                          ? 'border-l-tertiary'
                          : 'border-l-transparent'
                    }`}
                  >
                    <td className="px-3 py-2.5 align-middle">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleRow(outlet.id)}
                        aria-label={`Select ${channelLabel(outlet.id)} ${outlet.name}`}
                        className="h-4 w-4 cursor-pointer align-middle accent-primary"
                      />
                    </td>

                    <td className="px-3 py-2.5 align-middle">
                      <div className="flex flex-col">
                        <span className="flex items-center gap-1.5 font-title-md text-title-md font-semibold text-on-surface">
                          <span className="font-metric-value text-metric-value">
                            {channelLabel(outlet.id)}
                          </span>
                          <span>{outlet.name}</span>
                        </span>
                        <span className="font-metric-value text-metric-value text-on-surface-variant">
                          {`${outlet.relay} · ${outlet.role}`}
                        </span>
                      </div>
                    </td>

                    {/* The rail is static metadata: mono text tells the 220 V mains apart from the
                        5 V USB feed without spending a status colour on it. */}
                    <td className="px-3 py-2.5 align-middle">
                      <span
                        className="font-metric-value text-metric-value text-on-surface-variant"
                        title={`${outlet.volts} V rail`}
                      >
                        {`${outlet.volts}V ${outlet.volts < 10 ? 'DC' : 'AC'}`}
                      </span>
                    </td>

                    <td className="px-3 py-2.5 align-middle">
                      <select
                        value={draft.priority}
                        aria-label={`Priority for ${outlet.name}`}
                        onChange={(event) =>
                          setDraftField(outlet.id, 'priority', event.target.value as Priority)
                        }
                        className="h-10 w-full rounded-md border border-outline-variant bg-surface-container-lowest px-2 text-body-sm text-on-surface shadow-sm outline-none focus:border-primary"
                      >
                        {PRIORITY_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </td>

                    <td className="px-3 py-2.5 align-middle">
                      <div className="flex h-10 overflow-hidden rounded-md border border-outline-variant bg-surface-container-lowest shadow-sm focus-within:border-primary">
                        <input
                          type="number"
                          min={0}
                          step={5}
                          value={draft.allowanceWatts}
                          aria-label={`Allowance watts for ${outlet.name}`}
                          onChange={(event) =>
                            setDraftField(
                              outlet.id,
                              'allowanceWatts',
                              event.target.value === '' ? 0 : Number(event.target.value),
                            )
                          }
                          className="ant-table-num min-w-0 flex-1 bg-transparent px-2 text-on-surface outline-none"
                        />
                        <span className="flex h-full shrink-0 select-none items-center bg-surface-container px-1.5 font-metric-value text-metric-value text-on-surface-variant">
                          W
                        </span>
                      </div>
                    </td>

                    <td className="px-3 py-2.5 align-middle">
                      <input
                        type="text"
                        maxLength={200}
                        value={draft.schedule}
                        aria-label={`Schedule for ${outlet.name}`}
                        placeholder="Always on"
                        onChange={(event) => setDraftField(outlet.id, 'schedule', event.target.value)}
                        className="ant-input"
                      />
                    </td>

                    {/* An empty box is the FR-10 exempt state; the backend spells
                        it clearIdleLimit rather than a number. */}
                    <td className="px-3 py-2.5 align-middle">
                      <div className="flex h-10 overflow-hidden rounded-md border border-outline-variant bg-surface-container-lowest shadow-sm focus-within:border-primary">
                        <input
                          type="number"
                          min={0}
                          step={1}
                          value={draft.idleLimitMinutes ?? ''}
                          placeholder="Exempt"
                          aria-label={`Idle limit minutes for ${outlet.name}`}
                          onChange={(event) =>
                            setDraftField(
                              outlet.id,
                              'idleLimitMinutes',
                              event.target.value === '' ? null : Number(event.target.value),
                            )
                          }
                          className="ant-table-num min-w-0 flex-1 bg-transparent px-2 text-right text-on-surface outline-none placeholder:text-outline"
                        />
                        <span className="flex h-full shrink-0 select-none items-center bg-surface-container px-1.5 font-metric-value text-metric-value text-on-surface-variant">
                          min
                        </span>
                      </div>
                    </td>

                    {/* Reports the actual outcome of the last write attempt
                        rather than an assumed "synced" state. */}
                    <td className="whitespace-nowrap px-3 py-2.5 align-middle">
                      <span className="inline-flex items-center gap-1.5">
                        <span className={`ant-dot ${pill.dot}`} aria-hidden="true" />
                        <span className={`font-body-sm text-body-sm uppercase ${pill.ink}`}>{pill.label}</span>
                      </span>
                    </td>

                    <td className="px-3 py-2.5 align-middle">
                      <div className="flex flex-col items-end gap-1">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => void saveOutlet(outlet)}
                            disabled={!dirty || state === 'saving' || batchBusy}
                            className="flex h-7 items-center gap-1 rounded-md bg-surface-container px-2 font-title-md text-title-md text-primary transition-colors hover:bg-primary hover:text-on-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-surface-container disabled:hover:text-primary"
                          >
                            {state === 'saving' ? (
                              <LoaderCircle size={14} className="animate-spin" />
                            ) : state === 'saved' ? (
                              <CheckCircle2 size={14} />
                            ) : (
                              <Save size={14} />
                            )}
                            {state === 'saving' ? 'Saving' : 'Apply'}
                          </button>
                          <button
                            type="button"
                            onClick={() => revertOutlet(outlet)}
                            disabled={!dirty || state === 'saving'}
                            aria-label={`Revert edits for ${outlet.name}`}
                            title="Discard this row's edits"
                            className="flex h-7 w-7 items-center justify-center rounded-md text-outline transition-colors hover:bg-surface-container hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-30"
                          >
                            <RotateCcw size={14} />
                          </button>
                        </div>
                        {message && (
                          <span
                            role="status"
                            className={`max-w-[260px] text-right text-body-sm ${
                              state === 'error' ? 'text-error' : 'text-on-surface-variant'
                            }`}
                          >
                            {message}
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}

              {visibleRows.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-space-lg text-center">
                    <div className="mx-auto flex max-w-md flex-col items-center gap-2">
                      <span className={`ant-dot ${rows.length === 0 ? 'ant-dot-warning' : 'bg-outline-variant'}`} />
                      <p className="font-title-md text-title-md font-medium text-on-surface">
                        {rows.length === 0 ? 'No channels configured yet' : 'No channels match this filter'}
                      </p>
                      <p className="font-body-sm text-body-sm text-on-surface-variant">
                        {rows.length === 0
                          ? 'The dashboard state returned an empty outlet list, so there is nothing to edit.'
                          : `Nothing on the rig matches “${filter.trim()}”. Clear the filter to see all ${rows.length} channels.`}
                      </p>
                      {rows.length > 0 && (
                        <button type="button" className="ant-btn ant-btn-default" onClick={() => setFilter('')}>
                          <X size={16} className="text-outline" />
                          Clear filter
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Summary + batch actions */}
        <div className="flex flex-col gap-space-md bg-surface-container-low px-space-lg py-space-md xl:flex-row xl:items-center xl:justify-between">
          <div className="flex flex-wrap items-center gap-space-lg">
            {/* The one hero figure on this view: every per-channel cap this
                screen can edit, summed, against the limit it has to fit inside.
                Everything else here is a peer reading at metric-value. */}
            <div className="flex items-baseline gap-1.5">
              <span className="font-title-md text-title-md text-on-surface-variant">Total allocated cap</span>
              <span className="font-metric-display text-metric-display font-semibold text-on-surface">
                {`${Math.round(totalAllocated).toLocaleString()} W`}
              </span>
              <span className="font-metric-value text-metric-value text-outline">
                {`/ ${Math.round(maxWatts).toLocaleString()} W`}
              </span>
            </div>
            <div className="rounded bg-surface-container px-2.5 py-1 font-body-sm text-body-sm">
              {oversubscription > 1.001 ? (
                <>
                  <span className="font-semibold text-tertiary">
                    Oversubscription{' '}
                    <span className="font-metric-value text-metric-value">
                      {oversubscription.toFixed(2)}×
                    </span>
                  </span>
                  <span className="text-outline"> · </span>
                  <span className="text-on-surface-variant">
                    supported via duty cycling and FR-07 priority shedding
                  </span>
                </>
              ) : (
                <span className="text-on-surface-variant">
                  Headroom{' '}
                  <span className="font-metric-value text-metric-value">
                    {`${Math.round(Math.max(0, maxWatts - totalAllocated)).toLocaleString()} W`}
                  </span>{' '}
                  below P_limit
                </span>
              )}
            </div>
            <div className="rounded bg-surface-container px-2.5 py-1 font-body-sm text-body-sm text-on-surface-variant">
              <span className="font-semibold text-on-surface">
                <span className="font-metric-value text-metric-value">{shedCount}</span> at Low priority
              </span>
              <span className="text-outline"> · </span>
              <span>shed first under FR-07</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-space-sm">
            <div className="relative">
              <select
                value={batchPriority}
                onChange={(event) => applyBatchPriority(event.target.value)}
                disabled={selected.size === 0 || batchBusy}
                aria-label="Set priority for the selected channels"
                className="h-10 rounded-md border border-outline-variant bg-surface-container-lowest pl-3 pr-8 text-body-sm text-on-surface shadow-sm outline-none focus:border-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="" disabled>
                  {selected.size === 0
                    ? 'Select channels to batch-edit'
                    : `Set priority for ${selected.size} selected...`}
                </option>
                {PRIORITY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {`Set to ${option.label}`}
                  </option>
                ))}
              </select>
              <span className="pointer-events-none absolute right-2 top-2 text-outline" aria-hidden="true">
                <ChevronDown size={16} />
              </span>
            </div>
            <button
              type="button"
              className="ant-btn ant-btn-default"
              onClick={() => void saveRows(selectedDirtyIds)}
              disabled={selectedDirtyIds.length === 0 || batchBusy}
            >
              {batchBusy ? (
                <LoaderCircle size={16} className="animate-spin" />
              ) : (
                <Save size={16} />
              )}
              {selectedDirtyIds.length > 0
                ? `Save ${selectedDirtyIds.length} selected`
                : 'Save selected'}
            </button>
          </div>
        </div>
      </section>

      <p className="font-body-sm text-body-sm text-on-surface-variant">
        Priority drives the selective-response order in FR-07 and FR-08, and the preservation rule in FR-09 keeps
        High and Critical channels energized while lower priorities are shed. A blank idle limit marks the channel
        exempt from the FR-10 standby shutdown. Rows are listed worst-priority-first, because those are the channels
        an operator reconsiders first during a shed.
      </p>

      <div className="grid grid-cols-1 gap-space-lg md:grid-cols-2">
        <article className="ant-card">
          <div className="ant-card-body flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Save size={18} className="text-primary" aria-hidden="true" />
              <h3 className="font-title-lg text-title-lg font-semibold text-on-surface">
                Writes go to the real API
              </h3>
            </div>
            <p className="font-body-md text-body-md text-on-surface-variant">
              Threshold edits are sent to
              <code className="font-metric-value text-metric-value text-on-surface"> PUT /Dashboard/thresholds </code>
              and row edits to
              <code className="font-metric-value text-metric-value text-on-surface">
                PUT /Dashboard/outlets/&#123;id&#125;/policy
              </code>
              . Both are partial updates and both are validated server-side. Saving writes to the same database the
              policies read from, so there is no local-only shadow state.
            </p>
          </div>
        </article>
        <article className="ant-card">
          <div className="ant-card-body flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <CircleAlert size={18} className="text-tertiary" aria-hidden="true" />
              <h3 className="font-title-lg text-title-lg font-semibold text-on-surface">
                The device applies asynchronously
              </h3>
            </div>
            <p className="font-body-md text-body-md text-on-surface-variant">
              A saved threshold is persisted immediately, but the ESP32 reads it on its next evaluation cycle. Relay
              state will not visibly change until the device polls again, so a save confirmation is not a claim that
              a relay has already moved.
            </p>
          </div>
        </article>
      </div>
    </section>
  )
}