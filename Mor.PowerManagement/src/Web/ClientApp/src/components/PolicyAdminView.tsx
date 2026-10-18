import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  CircleAlert,
  FileDown,
  Info,
  LoaderCircle,
  RotateCcw,
  Save,
  SlidersHorizontal,
  TriangleAlert,
  Undo2,
} from 'lucide-react'
import { ApiError, fetchDashboardState, updateThresholds } from '../api'
import type { DashboardSnapshot } from '../api'
import {
  thresholdDiff,
  type SaveState,
  type ThresholdsForm,
} from './policyAdmin'

/**
 * Framework Administration -- the management half the thesis promises (roadmap M3).
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
 *   - Outlet-level prioritization and allocation live in the Framework view.
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

function formatSeen(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}

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
        className={`flex h-8 w-full overflow-hidden rounded-md border border-outline-variant shadow-sm ${
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
      <div className="flex h-8 items-center gap-space-sm">
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
        <div className="flex h-8 w-20 shrink-0 overflow-hidden rounded-md border border-outline-variant bg-surface-container-lowest shadow-sm focus-within:border-primary">
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
      setThresholdForm(state.thresholds)
    })
  }, [load])

  const setThresholdField = (field: keyof ThresholdsForm, value: number) => {
    setThresholdForm((current) => (current ? { ...current, [field]: value } : current))
    setThresholdState('idle')
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

  const revertAll = () => {
    if (!snapshot) return
    setThresholdForm(snapshot.thresholds)
    setThresholdState('idle')
    setThresholdMessage(null)
  }

  // Export the threshold values shown on this page, including pending edits.
  const exportPolicy = () => {
    if (!snapshot || !thresholdForm) return
    const pending = thresholdDirty ? 1 : 0
    const payload = {
      exportedAt: new Date().toISOString(),
      source: 'GET /api/Dashboard/state',
      unsavedEdits: pending,
      note:
        pending > 0
          ? 'Includes unsaved threshold edits. Save them before treating this file as current.'
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
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'mor-threshold-config.json'
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  // ----- derived values -----

  const thresholdDirty = Boolean(
    snapshot && thresholdForm && Object.keys(thresholdDiff(thresholdForm, snapshot.thresholds)).length > 0,
  )
  const editCount = thresholdDirty ? 1 : 0
  const maxWatts = thresholdForm ? thresholdForm.max : 0

  // ----- states before any data exists -----

  const pageFrame = (body: ReactNode, title: string, subtitle: ReactNode) => (
    <section className="framework-admin-page flex flex-col gap-space-lg" aria-label="Threshold settings">
      <div className="flex flex-col gap-1">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 font-body-sm text-body-sm text-on-surface-variant">
          <span>Console</span>
          <span className="text-outline">/</span>
          <span className="font-medium text-on-surface">Threshold</span>
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
      'The console could not reach the framework API, so no stored configuration is loaded and nothing can be written.',
    )
  }

  if (!snapshot || !thresholdForm) {
    return pageFrame(
      <div className="ant-card">
        <div className="ant-card-body flex items-center gap-space-sm font-body-md text-body-md text-on-surface-variant">
          <LoaderCircle size={16} className="animate-spin text-primary" />
          Reading the current global thresholds from the dashboard state endpoint...
        </div>
      </div>,
      'Loading configuration',
      'Fetching P_limit and the FR-05/FR-06 thresholds before the forms are seeded.',
    )
  }

  // ----- render -----

  const thresholdPendingFields = Object.keys(thresholdDiff(thresholdForm, snapshot.thresholds)).length
  const orderingBroken = thresholdForm.max <= 0 || thresholdForm.warning >= thresholdForm.critical

  return (
    <section className="framework-admin-page flex flex-col gap-space-lg" aria-label="Threshold settings">
      {/* Operational breadcrumb, title and page-level toolbar */}
      <div className="flex flex-col gap-space-md lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-1">
          <nav
            aria-label="Breadcrumb"
            className="flex items-center gap-1.5 font-body-sm text-body-sm text-on-surface-variant"
          >
            <span>Console</span>
            <span className="text-body-sm text-outline">/</span>
            <span className="font-medium text-on-surface">Threshold</span>
          </nav>
          <div className="mt-1 flex flex-wrap items-center gap-space-sm">
            <h1 className="font-headline-md text-headline-md tracking-tight text-on-surface">
              Threshold Settings
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
            Configure the system-wide capacity, warning, critical and standby thresholds.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-space-sm">
          <button
            type="button"
            className="ant-btn ant-btn-default"
            onClick={revertAll}
            disabled={editCount === 0 || thresholdState === 'saving'}
            aria-label="Discard all unsaved edits"
          >
            <Undo2 size={14} className="text-outline" />
          </button>
          <button type="button" className="ant-btn ant-btn-default" onClick={exportPolicy} aria-label="Export threshold settings as JSON">
            <FileDown size={14} className="text-outline" />
          </button>
          <button
            type="button"
            className="ant-btn ant-btn-primary"
            onClick={() => void saveThresholds()}
            disabled={editCount === 0 || thresholdState === 'saving'}
            aria-label="Save threshold settings"
          >
            {thresholdState === 'saving' ? (
              <LoaderCircle size={16} className="animate-spin" />
            ) : (
              <Save size={16} />
            )}
          </button>
        </div>
      </div>

      {/* SECTION 1 — Global System Thresholds */}
      <section className="framework-admin-thresholds ant-card overflow-hidden" aria-labelledby="thresholds-heading">
        <div className="ant-card-header flex-col items-stretch sm:flex-row sm:items-center">
          <div className="flex flex-wrap items-center gap-2">
            <SlidersHorizontal size={20} className="text-primary" aria-hidden="true" />
            <h2
              id="thresholds-heading"
              className="font-title-lg text-title-lg font-semibold text-on-surface"
            >
              Global System Thresholds
            </h2>
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
            className="mx-space-lg mb-space-lg flex items-start gap-2 rounded-md border border-error bg-error-container px-3 py-2 text-body-sm text-on-error-container"
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
            className={`mx-space-lg mb-space-lg rounded-md border px-3 py-2 font-body-sm text-body-sm ${
              thresholdState === 'error'
                ? 'border-error bg-error-container text-on-error-container'
                : 'border-outline-variant bg-surface-container-low text-on-surface'
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


    </section>
  )
}
