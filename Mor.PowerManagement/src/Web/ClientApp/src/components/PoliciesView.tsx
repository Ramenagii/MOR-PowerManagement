import { useEffect, useRef, useState } from 'react'
import { AlertCircle, BookmarkPlus, LoaderCircle, Save } from 'lucide-react'
import { acknowledgeOutletFault, ApiError, clearOutletRecovery, fetchDashboardState, updateOutletPolicy } from '../api'
import type { Outlet, Priority } from '../types/dashboard'
import { isMonitoredOnlyChannel } from '../data/dashboard'
import { draftFrom, sameDraft, type OutletDraft } from './policyAdmin'
import { SelectField } from './SelectField'

const PRIORITIES: Priority[] = ['Critical', 'High', 'Medium', 'Low']
const FRAMEWORKS = [
  ['F1 · Acquire & monitor', 'Every fresh device batch', 'Measurements and relay reports are validated against the system threshold. Stale or missing data is unknown, never zero.'],
  ['F2 · Selective disconnect', 'System overload or outlet cap', 'Lowest-priority eligible outlet sheds on system overload; an unprotected outlet trips at its own cap.'],
  ['F3 · Verify switching', 'After each relay command', 'Wait for device feedback and a fresh sample before another automatic switch. A timeout needs operator review.'],
  ['F4 · Timed recovery', '55 s after automatic OFF', 'Trial reconnect one outlet, reassess, and re-trip if load still exceeds threshold. Maximum five attempts per episode.'],
] as const
type FrameworkPreset = { name: string; outlets: Record<number, OutletDraft> }
const PRESET_STORAGE_KEY = 'mor.framework.presets.v1'
function readFrameworkPresets(): FrameworkPreset[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(PRESET_STORAGE_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is FrameworkPreset => Boolean(item && typeof item.name === 'string' && item.outlets && typeof item.outlets === 'object'))
  } catch { return [] }
}

export function PoliciesView() {
  const [outlets, setOutlets] = useState<Outlet[]>([])
  const [liveTotal, setLiveTotal] = useState<number | null>(null)
  const [deviceOnline, setDeviceOnline] = useState(false)
  const [deviceProtocolReady, setDeviceProtocolReady] = useState(false)
  const [drafts, setDrafts] = useState<Record<number, OutletDraft>>({})
  const [baseline, setBaseline] = useState<Record<number, OutletDraft>>({})
  const [systemLimit, setSystemLimit] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [presets, setPresets] = useState<FrameworkPreset[]>(readFrameworkPresets)
  const [presetName, setPresetName] = useState('')
  const [clearingId, setClearingId] = useState<number | null>(null)
  const initialized = useRef(false)

  useEffect(() => {
    let active = true
    const load = () => fetchDashboardState().then((snapshot) => {
      if (!active) return
      const current = Object.fromEntries(snapshot.outlets.map((outlet) => [outlet.id, draftFrom(outlet)]))
      setOutlets(snapshot.outlets)
      setLiveTotal(snapshot.totalWatts)
      setDeviceOnline(snapshot.deviceOnline)
      setDeviceProtocolReady(snapshot.deviceProtocolReady)
      setSystemLimit(snapshot.thresholds.critical)
      setBaseline(current)
      if (!initialized.current) { setDrafts(current); initialized.current = true }
      setLoading(false)
    }).catch(() => { if (active) { setError('Could not load the framework settings.'); setLoading(false) } })
    void load()
    const timer = window.setInterval(() => void load(), 2000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])

  const dirtyOutlets = outlets.filter((outlet) => !sameDraft(drafts[outlet.id] ?? draftFrom(outlet), baseline[outlet.id] ?? draftFrom(outlet)))
  const hasChanges = dirtyOutlets.length > 0
  const setField = (id: number, field: keyof OutletDraft, value: string | number | boolean | null) => {
    setDrafts((current) => ({ ...current, [id]: { ...current[id], [field]: value } }))
    setSaved(false)
  }
  const shedGroups = (['Low', 'Medium', 'High', 'Critical'] as Priority[])
    .map((priority) => ({ priority, outlets: outlets.filter((outlet) => !isMonitoredOnlyChannel(outlet.id) && !outlet.isProtected && (drafts[outlet.id]?.priority ?? outlet.priority) === priority) }))
    .filter((group) => group.outlets.length > 0)

  const savePreset = () => {
    const name = window.prompt('Name this outlet framework preset:')?.trim()
    if (!name || outlets.length === 0) return
    const preset: FrameworkPreset = { name: name.slice(0, 48), outlets: Object.fromEntries(outlets.map((outlet) => [outlet.id, drafts[outlet.id] ?? draftFrom(outlet)])) }
    const next = [...presets.filter((item) => item.name !== preset.name), preset]
    window.localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(next))
    setPresets(next)
    setPresetName(preset.name)
  }

  const applyPreset = (name: string) => {
    setPresetName(name)
    const preset = presets.find((item) => item.name === name)
    if (!preset) return
    if (hasChanges && !window.confirm('Replace the unsaved outlet edits with this preset?')) return
    setDrafts(Object.fromEntries(outlets.map((outlet) => [outlet.id, { ...draftFrom(outlet), ...preset.outlets[outlet.id] }])))
    setSaved(false)
    setError(null)
  }

  async function saveLimits() {
    setSaving(true); setSaved(false); setError(null)
    try {
      await Promise.all(dirtyOutlets.map((outlet) => {
        const draft = drafts[outlet.id] ?? draftFrom(outlet)
        return updateOutletPolicy(outlet.id, {
          name: draft.name,
          ...(isMonitoredOnlyChannel(outlet.id) ? {} : { allowanceWatts: draft.allowanceWatts, priority: draft.priority, isProtected: draft.isProtected }),
          schedule: draft.schedule,
          ...(draft.idleLimitMinutes === null ? { clearIdleLimit: true } : { idleLimitMinutes: draft.idleLimitMinutes }),
        })
      }))
      const current = Object.fromEntries(outlets.map((outlet) => [outlet.id, drafts[outlet.id] ?? draftFrom(outlet)]))
      setBaseline(current)
      setSaved(true)
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 401 ? 'Your session expired. Sign in again to save.' : 'Could not save the framework settings.')
    } finally { setSaving(false) }
  }

  return <section className="design-main" aria-label="Framework">
    <header className="mb-space-lg flex flex-col gap-1">
      <h1 className="font-headline-md text-headline-md text-on-surface">Framework</h1>
      <p className="font-body-sm text-body-sm text-on-surface-variant">Configure outlet priority, power caps, monitoring notes, and idle timeouts. The USB channel is monitored only and cannot be switched.</p>
    </header>

    <section className="ant-card mb-space-lg overflow-hidden" aria-labelledby="outlet-limits-heading">
      <div className="ant-card-header flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div><h2 id="outlet-limits-heading" className="font-title-lg text-title-lg font-semibold text-on-surface">Outlet configurations</h2></div>
        <div className="flex flex-wrap items-center gap-2">
        <SelectField compact aria-label="Apply a saved outlet framework preset" value={presetName} onValueChange={applyPreset}>
          <option value="">Saved presets</option>
          {presets.map((preset) => <option key={preset.name} value={preset.name}>{preset.name}</option>)}
        </SelectField>
        <button type="button" className="ant-btn ant-btn-default" onClick={savePreset} disabled={loading || outlets.length === 0} aria-label="Save outlet framework preset" title="Save preset"><BookmarkPlus size={16} /></button>
        <button type="button" className="ant-btn ant-btn-primary" onClick={() => void saveLimits()} disabled={loading || saving || !hasChanges || dirtyOutlets.some((outlet) => { const d = drafts[outlet.id]; return !Number.isFinite(d?.idleLimitMinutes ?? 0) || (d?.idleLimitMinutes !== null && (d?.idleLimitMinutes ?? 0) < 0) || (!isMonitoredOnlyChannel(outlet.id) && (!Number.isFinite(d?.allowanceWatts) || (d?.allowanceWatts ?? -1) < 0)) })} aria-label="Save outlet prioritization settings">
          {saving ? <LoaderCircle size={16} className="animate-spin" /> : <Save size={16} />}
        </button>
        </div>
      </div>
      <div className="ant-card-body">
        {loading ? <div className="flex items-center gap-2 text-on-surface-variant"><LoaderCircle size={16} className="animate-spin" />Loading…</div> : outlets.length > 0 ? <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {outlets.map((outlet) => {
            const item = drafts[outlet.id] ?? draftFrom(outlet)
            const monitorOnly = isMonitoredOnlyChannel(outlet.id)
            const dirty = !sameDraft(item, baseline[outlet.id] ?? draftFrom(outlet))
            return <div key={outlet.id} className="flex flex-col gap-2 rounded-lg border border-outline-variant bg-surface-container-low p-4">
              <span className="font-title-md font-semibold">CH{String(outlet.id).padStart(2, '0')} · {monitorOnly ? 'Monitored only' : 'Relay outlet'}</span>
              <label className="flex flex-col gap-1 text-sm text-on-surface-variant">Outlet name<input value={item.name} maxLength={80} aria-label={`Name for ${outlet.name}`} onChange={(event) => setField(outlet.id, 'name', event.target.value)} className="ant-input" /></label>
              {!monitorOnly && <>
                <label className="flex flex-col gap-1 text-sm text-on-surface-variant">Priority tier
                  <SelectField value={item.priority} aria-label={`Priority tier for ${item.name}`} onValueChange={(priority) => setField(outlet.id, 'priority', priority as Priority)}>{PRIORITIES.map((priority) => <option key={priority} value={priority}>{priority}</option>)}</SelectField>
                </label>
                <label className="flex flex-col gap-1 text-sm text-on-surface-variant">Power allowance
                  <span className="flex h-10 overflow-hidden rounded-md border border-outline-variant bg-surface-container-lowest"><input type="number" min={0} step={10} value={item.allowanceWatts} aria-label={`${item.name} trip allowance`} onChange={(event) => setField(outlet.id, 'allowanceWatts', event.target.value === '' ? 0 : Number(event.target.value))} className="min-w-0 flex-1 bg-transparent px-3 outline-none"/><span className="bg-surface-container px-3 py-2">W</span></span>
                </label>
                <label className="flex items-center gap-2 text-sm text-on-surface-variant"><input type="checkbox" checked={item.isProtected} onChange={(event) => setField(outlet.id, 'isProtected', event.target.checked)}/>Protected from automatic shedding</label>
              </>}
              <label className="flex flex-col gap-1 text-sm text-on-surface-variant">Schedule note <span className="text-xs">Informational only; does not switch by clock time.</span><input value={item.schedule} maxLength={200} aria-label={`Schedule note for ${item.name}`} placeholder="e.g. 08:00–18:00" onChange={(event) => setField(outlet.id, 'schedule', event.target.value)} className="ant-input" /></label>
              <label className="flex flex-col gap-1 text-sm text-on-surface-variant">Idle limit <span className="text-xs">Stored setting; automatic idle shutdown is not active yet.</span>
                <span className="flex h-10 overflow-hidden rounded-md border border-outline-variant bg-surface-container-lowest"><input type="number" min={0} step={1} value={item.idleLimitMinutes ?? ''} placeholder="Exempt" aria-label={`Idle timeout minutes for ${item.name}`} onChange={(event) => setField(outlet.id, 'idleLimitMinutes', event.target.value === '' ? null : Number(event.target.value))} className="min-w-0 flex-1 bg-transparent px-3 outline-none"/><span className="bg-surface-container px-3 py-2">min</span></span>
              </label>
              {monitorOnly && <p className="text-xs text-on-surface-variant">USB outlet is always energized; its reading is monitored, with no relay control or shed tier.</p>}
              {dirty && <p className="text-xs text-primary">Unsaved changes</p>}
            </div>
          })}
        </div> : <p className="text-sm text-on-surface-variant">No outlets are configured in the backend.</p>}
        {!loading && outlets.length > 0 && <div className="mt-4 rounded-lg border border-outline-variant bg-surface-container-low p-4" aria-label="Outlet shed order preview">
          <p className="font-title-md font-semibold text-on-surface">Automatic shed order</p>
          <p className="mt-1 text-sm text-on-surface-variant">Tiers are shed from Low to Critical. Within a tier, the highest live load is disconnected first. Monitored-only outlets are excluded.</p>
          {shedGroups.length ? <ul className="mt-2 flex flex-col gap-1 font-medium text-on-surface">{shedGroups.map((group) => <li key={group.priority}><span>{group.priority}:</span> {group.outlets.map((item) => `CH${item.id} ${drafts[item.id]?.name ?? item.name}`).join(', ')}</li>)}</ul> : <p className="mt-2 font-medium text-on-surface">All relay outlets are protected; there are no automatic shed candidates.</p>}
        </div>}
        {(error || saved) && <p className={`mt-3 flex items-center gap-2 text-sm ${error ? 'text-error' : 'text-on-surface-variant'}`} role={error ? 'alert' : 'status'}>{error && <AlertCircle size={16} />}{error ?? 'Framework settings saved.'}</p>}
      </div>
    </section>

    <section className="ant-card mb-space-lg overflow-hidden" aria-labelledby="framework-live-heading">
      <div className="ant-card-header flex items-center justify-between gap-4">
        <div><h2 id="framework-live-heading" className="font-title-lg font-semibold">Live framework state</h2><p className="mt-1 text-sm text-on-surface-variant">{deviceOnline ? 'Device reporting' : 'Device offline'} · total {liveTotal === null ? '—' : `${Math.round(liveTotal)} W`} / {systemLimit ?? '—'} W</p></div>
        <span className={`rounded-full px-3 py-1 text-xs ${deviceOnline && deviceProtocolReady ? 'bg-surface-container text-on-surface' : 'bg-amber-100 text-amber-900'}`}>{!deviceOnline ? 'NO FRESH DATA' : deviceProtocolReady ? 'MONITORING + CONTROL READY' : 'MONITORING · FIRMWARE UPDATE NEEDED'}</span>
      </div>
      <div className="ant-card-body grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {outlets.map((outlet) => <article key={outlet.id} className="rounded-lg border border-outline-variant p-3">
          <div className="flex justify-between gap-2"><strong>CH{String(outlet.id).padStart(2, '0')} · {outlet.name}</strong><span className="text-xs text-on-surface-variant">{outlet.status.toUpperCase()}</span></div>
          <p className="mt-2 text-sm text-on-surface-variant">{isMonitoredOnlyChannel(outlet.id) ? 'Monitored only · no relay' : outlet.commandNeedsReview ? 'Relay response needs review' : outlet.commandPending ? 'Waiting for relay confirmation' : outlet.faultHold ? 'Fault hold' : outlet.manualHold ? 'Manual OFF hold' : outlet.recoveryLockout ? 'Recovery locked' : outlet.nextRecoveryAtUtc ? `Recovery in ${Math.max(0, Math.ceil((Date.parse(outlet.nextRecoveryAtUtc) - Date.now()) / 1000))} s` : outlet.recoveryTrialPending ? `Trial ${outlet.automaticRecoveryAttempts}/5 · verifying` : outlet.isProtected ? 'Protected outlet' : `Priority ${outlet.priority}`}</p>
          {outlet.automaticRecoveryAttempts > 0 && <p className="mt-1 font-metric-value text-xs text-outline">Automatic recovery {outlet.automaticRecoveryAttempts}/5</p>}
          {(outlet.recoveryLockout || outlet.commandNeedsReview) && <button type="button" className="ant-btn mt-2" disabled={clearingId !== null} onClick={async () => { setClearingId(outlet.id); try { await clearOutletRecovery(outlet.id) } catch { setError('Admin clearance failed. Check your role and backend connection.') } finally { setClearingId(null) } }}>{clearingId === outlet.id ? 'Clearing…' : 'Admin: clear after review'}</button>}
          {outlet.faultHold && <button type="button" className="ant-btn mt-2" disabled={clearingId !== null} onClick={async () => { setClearingId(outlet.id); try { await acknowledgeOutletFault(outlet.id) } catch { setError('Fault acknowledgement failed. Check your role and backend connection.') } finally { setClearingId(null) } }}>{clearingId === outlet.id ? 'Acknowledging…' : 'Admin: acknowledge fault'}</button>}
        </article>)}
      </div>
    </section>

    <section className="ant-card overflow-hidden" aria-labelledby="framework-processes-heading">
      <div className="ant-card-header"><h2 id="framework-processes-heading" className="font-title-lg font-semibold">Four connected processes</h2></div>
      <div className="ant-card-body grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">{FRAMEWORKS.map(([title, trigger, response], index) => <article key={title} className="flex flex-col gap-3 rounded-lg border border-outline-variant bg-surface-container-low p-4"><div className="flex items-center justify-between"><h3 className="font-title-md font-semibold">{title}</h3><span className="font-metric-value text-outline">0{index + 1}</span></div><p className="font-code text-sm text-primary">{index === 1 ? `System > ${systemLimit === null ? 'configured limit' : `${Math.round(systemLimit).toLocaleString()} W`} for 3 s · outlet ≥ own cap once` : trigger}</p><p className="text-sm leading-6 text-on-surface-variant">{response}</p></article>)}</div>
    </section>
  </section>
}
