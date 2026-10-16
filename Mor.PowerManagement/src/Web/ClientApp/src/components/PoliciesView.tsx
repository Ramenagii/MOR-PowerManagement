import { useEffect, useState } from 'react'
import { AlertCircle, LoaderCircle, Save } from 'lucide-react'
import { ApiError, fetchDashboardState, updateOutletPolicy } from '../api'
import type { Outlet } from '../types/dashboard'
import { FRAMEWORK_SCOPE } from './policyAdmin'

type OutletLimit = Pick<Outlet, 'id' | 'name' | 'allowance'>

const SCENARIOS = [
  {
    title: 'Normal load',
    band: 'Normal',
    tone: 'normal',
    when: 'Below the warning threshold',
    response: 'Loads continue without changing relay state.',
  },
  {
    title: 'Warning',
    band: 'Warning',
    tone: 'warning',
    when: 'Between warning and P_limit',
    response: 'The system warns and can refuse an activation that would exceed P_limit.',
  },
  {
    title: 'Sustained overload',
    band: 'Critical',
    tone: 'critical',
    when: 'Above P_limit for three samples',
    response: 'The framework sheds one eligible outlet at a time by priority.',
  },
  {
    title: 'Recovery',
    band: 'Restore',
    tone: 'normal',
    when: 'Below 90% of P_limit for 30 seconds',
    response: 'Shed outlets return one at a time, with a five second pause between them.',
  },
] as const

export function PoliciesView() {
  const [initialLimits, setInitialLimits] = useState<OutletLimit[]>([])
  const [limits, setLimits] = useState<OutletLimit[]>([])
  const [systemLimit, setSystemLimit] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let active = true
    fetchDashboardState()
      .then((snapshot) => {
        if (!active) return
        const current = snapshot.outlets
          .slice(0, 4)
          .map(({ id, name, allowance }) => ({ id, name, allowance }))
        setInitialLimits(current)
        setLimits(current)
        setSystemLimit(snapshot.thresholds.critical)
      })
      .catch(() => {
        if (active) setError('Could not load the outlet limits. Check that the backend is running.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const hasChanges = limits.some(
    (limit, index) => limit.allowance !== initialLimits[index]?.allowance,
  )

  async function saveLimits() {
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      await Promise.all(
        limits.map((limit) =>
          updateOutletPolicy(limit.id, { allowanceWatts: limit.allowance }),
        ),
      )
      setInitialLimits(limits)
      setSaved(true)
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.status === 401
          ? 'Your session expired. Sign in again to save these limits.'
          : 'Could not save the outlet limits. Try again.',
      )
    } finally {
      setSaving(false)
    }
  }

  function updateLimit(id: number, rawValue: string) {
    const allowance = rawValue === '' ? 0 : Number(rawValue)
    setLimits((current) =>
      current.map((limit) => (limit.id === id ? { ...limit, allowance } : limit)),
    )
    setSaved(false)
  }

  return (
    <section className="design-main" aria-label="Framework">
      <nav aria-label="Breadcrumb" className="mb-space-sm flex items-center gap-space-sm">
        <span className="font-body-sm text-body-sm text-on-surface-variant">Console</span>
        <span className="font-body-sm text-body-sm text-outline-variant" aria-hidden>
          /
        </span>
        <strong className="font-body-sm text-body-sm font-semibold text-on-surface">Framework</strong>
      </nav>

      <header className="mb-space-lg flex flex-col gap-1">
        <h1 className="font-headline-md text-headline-md text-on-surface">Framework</h1>
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          Four outlet limits and the system load response.{' '}
          <span className="font-semibold text-on-surface">{FRAMEWORK_SCOPE}</span>
        </p>
      </header>

      <section className="ant-card mb-space-lg overflow-hidden" aria-labelledby="outlet-limits-heading">
        <div className="ant-card-header flex-col items-stretch sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 id="outlet-limits-heading" className="font-title-lg text-title-lg font-semibold text-on-surface">
              Outlet limits
            </h2>
            <p className="mt-1 font-body-sm text-body-sm text-on-surface-variant">
              Set the maximum allowance for each outlet. System limit: {systemLimit === null ? '—' : `${Math.round(systemLimit).toLocaleString()} W`}.
            </p>
          </div>
          <button
            type="button"
            className="ant-btn ant-btn-primary"
            onClick={() => void saveLimits()}
            disabled={loading || saving || !hasChanges || limits.length !== 4 || limits.some((limit) => !Number.isFinite(limit.allowance) || limit.allowance < 0)}
          >
            {saving ? <LoaderCircle size={16} className="animate-spin" /> : <Save size={16} />}
            {saving ? 'Saving…' : 'Save limits'}
          </button>
        </div>

        <div className="ant-card-body">
          {loading ? (
            <div className="flex items-center gap-space-sm font-body-sm text-body-sm text-on-surface-variant">
              <LoaderCircle size={16} className="animate-spin text-primary" />
              Loading outlet limits…
            </div>
          ) : limits.length === 4 ? (
            <div className="grid grid-cols-1 gap-space-md sm:grid-cols-2 xl:grid-cols-4">
              {limits.map((limit, index) => (
                <label
                  key={limit.id}
                  className="flex flex-col gap-2 rounded-lg border border-outline-variant bg-surface-container-low p-space-md"
                >
                  <span className="font-title-md text-title-md font-semibold text-on-surface">
                    CH{index + 1} · {limit.name}
                  </span>
                  <span className="flex h-10 overflow-hidden rounded-md border border-outline-variant bg-surface-container-lowest focus-within:border-primary">
                    <input
                      type="number"
                      min={0}
                      step={10}
                      value={limit.allowance}
                      aria-label={`${limit.name} allowance in watts`}
                      onChange={(event) => updateLimit(limit.id, event.target.value)}
                      className="ant-table-num min-w-0 flex-1 bg-transparent px-3 text-on-surface outline-none"
                    />
                    <span className="flex items-center bg-surface-container px-3 font-metric-value text-metric-value text-on-surface-variant">
                      W
                    </span>
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              The backend must have exactly four outlets before limits can be edited.
            </p>
          )}

          {(error || saved) && (
            <p
              className={`mt-space-md flex items-center gap-2 font-body-sm text-body-sm ${error ? 'text-error' : 'text-on-surface-variant'}`}
              role={error ? 'alert' : 'status'}
            >
              {error && <AlertCircle size={16} aria-hidden />}
              {error ?? 'Outlet limits saved.'}
            </p>
          )}
        </div>
      </section>

      <section className="ant-card overflow-hidden" aria-labelledby="framework-scenarios-heading">
        <div className="ant-card-header">
          <h2 id="framework-scenarios-heading" className="font-title-lg text-title-lg font-semibold text-on-surface">
            Operating scenarios
          </h2>
        </div>
        <div className="ant-card-body grid grid-cols-1 gap-space-md sm:grid-cols-2 xl:grid-cols-4">
          {SCENARIOS.map((scenario, index) => (
            <article
              key={scenario.title}
              className="flex flex-col gap-space-sm rounded-lg border border-outline-variant bg-surface-container-low p-space-md"
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-title-md text-title-md font-semibold text-on-surface">
                  {scenario.title}
                </h3>
                <span className="font-metric-value text-metric-value text-outline">
                  {String(index + 1).padStart(2, '0')}
                </span>
              </div>
              <span className="font-metric-value text-metric-value text-on-surface-variant">
                {scenario.band}
              </span>
              <p className="font-code text-code text-outline">{scenario.when}</p>
              <p className="font-body-sm text-body-sm text-on-surface-variant">{scenario.response}</p>
            </article>
          ))}
        </div>
      </section>
    </section>
  )
}
