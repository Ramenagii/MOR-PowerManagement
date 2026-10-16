import { useEffect, useState } from 'react'
import { AlertCircle, LoaderCircle, Save } from 'lucide-react'
import { acknowledgeOutletFault, ApiError, clearOutletRecovery, fetchDashboardState, updateOutletPolicy } from '../api'
import type { Outlet } from '../types/dashboard'

type OutletLimit = Pick<Outlet, 'id' | 'name' | 'allowance' | 'isProtected'>

const FRAMEWORKS = [
  ['F1 · Acquire & monitor', 'Every fresh device batch', 'Validate measurements, relay reports, sensor health and the 1,300 W operating threshold. Stale or missing data is unknown, never zero.'],
  ['F2 · Selective disconnect', 'Above 1,300 W for 3 batches', 'Open one lowest-priority eligible relay at a time. Protected outlets are excluded; unresolved overloads raise an alert.'],
  ['F3 · Verify switching', 'After each relay command', 'Wait for device state feedback and a fresh sample before another automatic switch. A timeout needs operator review.'],
  ['F4 · Timed recovery', '55 seconds after automatic OFF', 'Trial reconnect one outlet, then reassess. If load again exceeds threshold, trip that same outlet and restart its wait; maximum five attempts per episode.'],
] as const

export function PoliciesView() {
  const [outlets, setOutlets] = useState<Outlet[]>([])
  const [liveTotal, setLiveTotal] = useState<number | null>(null)
  const [deviceOnline, setDeviceOnline] = useState(false)
  const [deviceProtocolReady, setDeviceProtocolReady] = useState(false)
  const [initialLimits, setInitialLimits] = useState<OutletLimit[]>([])
  const [limits, setLimits] = useState<OutletLimit[]>([])
  const [systemLimit, setSystemLimit] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [clearingId, setClearingId] = useState<number | null>(null)

  useEffect(() => {
    let active = true
    const load = () => fetchDashboardState().then((snapshot) => {
      if (!active) return
      const current = snapshot.outlets.slice(0, 4).map(({ id, name, allowance, isProtected }) => ({ id, name, allowance, isProtected }))
      setOutlets(snapshot.outlets.slice(0, 4))
      setLiveTotal(snapshot.totalWatts)
      setDeviceOnline(snapshot.deviceOnline)
      setDeviceProtocolReady(snapshot.deviceProtocolReady)
      setInitialLimits((old) => old.length === 4 ? old : current)
      setLimits((old) => old.length === 4 ? old.map((draft) => current.find((x) => x.id === draft.id) ? { ...current.find((x) => x.id === draft.id)!, allowance: draft.allowance, isProtected: draft.isProtected } : draft) : current)
      setSystemLimit(snapshot.thresholds.critical)
      setLoading(false)
    }).catch(() => { if (active) { setError('Could not load the framework settings.'); setLoading(false) } })
    void load()
    const timer = window.setInterval(() => void load(), 2000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])

  const hasChanges = limits.some((item, i) => item.allowance !== initialLimits[i]?.allowance || item.isProtected !== initialLimits[i]?.isProtected)
  async function saveLimits() {
    setSaving(true); setSaved(false); setError(null)
    try {
      await Promise.all(limits.map((item) => updateOutletPolicy(item.id, { allowanceWatts: item.allowance, isProtected: item.isProtected })))
      setInitialLimits(limits); setSaved(true)
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 401 ? 'Your session expired. Sign in again to save.' : 'Could not save the framework settings.')
    } finally { setSaving(false) }
  }

  return <section className="design-main" aria-label="Framework">
    <header className="mb-space-lg flex flex-col gap-1">
      <h1 className="font-headline-md text-headline-md text-on-surface">Framework</h1>
      <p className="font-body-sm text-body-sm text-on-surface-variant">Four processes coordinate monitoring, selective trips, switching checks and timed recovery.</p>
    </header>

    <section className="ant-card mb-space-lg overflow-hidden" aria-labelledby="outlet-limits-heading">
      <div className="ant-card-header flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div><h2 id="outlet-limits-heading" className="font-title-lg text-title-lg font-semibold text-on-surface">Four outlet controls</h2>
          <p className="mt-1 font-body-sm text-body-sm text-on-surface-variant">Configured operating threshold: {systemLimit === null ? '—' : `${Math.round(systemLimit).toLocaleString()} W`}. Reviewed device rating is not recorded.</p></div>
        <button type="button" className="ant-btn ant-btn-primary" onClick={() => void saveLimits()} disabled={loading || saving || !hasChanges || limits.length !== 4 || limits.some((item) => !Number.isFinite(item.allowance) || item.allowance < 0)}>
          {saving ? <LoaderCircle size={16} className="animate-spin" /> : <Save size={16} />}{saving ? 'Saving…' : 'Save settings'}
        </button>
      </div>
      <div className="ant-card-body">
        {loading ? <div className="flex items-center gap-2 text-on-surface-variant"><LoaderCircle size={16} className="animate-spin" />Loading…</div> : limits.length === 4 ? <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {limits.map((item, index) => <div key={item.id} className="flex flex-col gap-2 rounded-lg border border-outline-variant bg-surface-container-low p-4">
            <span className="font-title-md font-semibold">CH{index + 1} · {item.name}</span>
            <label className="flex h-10 overflow-hidden rounded-md border border-outline-variant bg-surface-container-lowest"><input type="number" min={0} step={10} value={item.allowance} aria-label={`${item.name} trip allowance`} onChange={(event) => setLimits((old) => old.map((x) => x.id === item.id ? { ...x, allowance: event.target.value === '' ? 0 : Number(event.target.value) } : x))} className="min-w-0 flex-1 bg-transparent px-3 outline-none"/><span className="bg-surface-container px-3 py-2">W</span></label>
            <label className="flex items-center gap-2 text-sm text-on-surface-variant"><input type="checkbox" checked={item.isProtected} onChange={(event) => setLimits((old) => old.map((x) => x.id === item.id ? { ...x, isProtected: event.target.checked } : x))}/>Protected from automatic shedding</label>
          </div>)}
        </div> : <p className="text-sm text-on-surface-variant">The backend must have exactly four outlets before settings can be edited.</p>}
        {(error || saved) && <p className={`mt-3 flex items-center gap-2 text-sm ${error ? 'text-error' : 'text-on-surface-variant'}`} role={error ? 'alert' : 'status'}>{error && <AlertCircle size={16} />}{error ?? 'Framework settings saved.'}</p>}
      </div>
    </section>

    <section className="ant-card mb-space-lg overflow-hidden" aria-labelledby="framework-live-heading">
      <div className="ant-card-header flex items-center justify-between gap-4">
        <div><h2 id="framework-live-heading" className="font-title-lg font-semibold">Live framework state</h2><p className="mt-1 text-sm text-on-surface-variant">{deviceOnline ? 'Device reporting' : 'Device offline'} · total {liveTotal === null ? '—' : `${Math.round(liveTotal)} W`} / {systemLimit ?? '—'} W</p></div>
        <span className={`rounded-full px-3 py-1 text-xs ${deviceOnline && deviceProtocolReady ? 'bg-surface-container text-on-surface' : 'bg-amber-100 text-amber-900'}`}>{!deviceOnline ? 'NO FRESH DATA' : deviceProtocolReady ? 'MONITORING + CONTROL READY' : 'MONITORING · FIRMWARE UPDATE NEEDED'}</span>
      </div>
      <div className="ant-card-body grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {outlets.map((outlet, index) => <article key={outlet.id} className="rounded-lg border border-outline-variant p-3">
          <div className="flex justify-between gap-2"><strong>CH{index + 1} · {outlet.name}</strong><span className="text-xs text-on-surface-variant">{outlet.status.toUpperCase()}</span></div>
          <p className="mt-2 text-sm text-on-surface-variant">{outlet.commandNeedsReview ? 'Relay response needs review' : outlet.faultHold ? 'Fault hold' : outlet.manualHold ? 'Manual OFF hold' : outlet.recoveryLockout ? 'Recovery locked' : outlet.nextRecoveryAtUtc ? `Recovery in ${Math.max(0, Math.ceil((Date.parse(outlet.nextRecoveryAtUtc) - Date.now()) / 1000))} s` : outlet.recoveryTrialPending ? `Trial ${outlet.automaticRecoveryAttempts}/5 · verifying` : outlet.isProtected ? 'Protected outlet' : `Priority ${outlet.priority}`}</p>
          {outlet.automaticRecoveryAttempts > 0 && <p className="mt-1 font-metric-value text-xs text-outline">Automatic recovery {outlet.automaticRecoveryAttempts}/5</p>}
          {(outlet.recoveryLockout || outlet.commandNeedsReview) && <button type="button" className="ant-btn mt-2" disabled={clearingId !== null} onClick={async () => { setClearingId(outlet.id); try { await clearOutletRecovery(outlet.id) } catch { setError('Admin clearance failed. Check your role and backend connection.') } finally { setClearingId(null) } }}>{clearingId === outlet.id ? 'Clearing…' : 'Admin: clear after review'}</button>}
          {outlet.faultHold && <button type="button" className="ant-btn mt-2" disabled={clearingId !== null} onClick={async () => { setClearingId(outlet.id); try { await acknowledgeOutletFault(outlet.id) } catch { setError('Fault acknowledgement failed. Check your role and backend connection.') } finally { setClearingId(null) } }}>{clearingId === outlet.id ? 'Acknowledging…' : 'Admin: acknowledge fault'}</button>}
        </article>)}
      </div>
    </section>

    <section className="ant-card overflow-hidden" aria-labelledby="framework-processes-heading">
      <div className="ant-card-header"><h2 id="framework-processes-heading" className="font-title-lg font-semibold">Four connected processes</h2></div>
      <div className="ant-card-body grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {FRAMEWORKS.map(([title, trigger, response], index) => <article key={title} className="flex flex-col gap-3 rounded-lg border border-outline-variant bg-surface-container-low p-4">
          <div className="flex items-center justify-between"><h3 className="font-title-md font-semibold">{title}</h3><span className="font-metric-value text-outline">0{index + 1}</span></div>
          <p className="font-code text-sm text-primary">{trigger}</p><p className="text-sm leading-6 text-on-surface-variant">{response}</p>
        </article>)}
      </div>
    </section>
  </section>
}
