import type { ScenarioNotice } from './ScenarioPanel'

/**
 * The six vector buttons, in the reference mock's order and with its dot
 * colours. The mock's own handler picked a random row count and a random total
 * — which is exactly the invented-result behaviour this console must not have.
 * Every line in `.out` below is therefore assembled from the server's actual
 * IngestResult: readingsStored, totalWatts and the events the policy engine
 * raised. Nothing here is synthesised.
 *
 * Mapping onto the existing prescribed vectors (SIM-01..06), all of which post
 * to real endpoints:
 *   Normal   -> SIM-01 baseline replay
 *   Surge    -> SIM-03 capacity-block rehearsal (drives toward the warn band)
 *   Policy   -> SIM-05 selective response (priority-ordered shed)
 *   Overload -> SIM-04 post-activation overload (forces FR-06)
 *   Audit    -> SIM-02 activation request (the backend admits or denies it)
 *   Shutdown -> SIM-06 idle timeout cutoff
 */
export type VectorId = 'normal' | 'surge' | 'policy' | 'overload' | 'audit' | 'shutdown'

export const VECTORS: Array<{ id: VectorId; label: string; color: string; sim: string }> = [
  { id: 'normal', label: 'Normal', color: 'var(--ok)', sim: 'SIM-01' },
  { id: 'surge', label: 'Surge', color: 'var(--live)', sim: 'SIM-03' },
  { id: 'policy', label: 'Policy', color: 'var(--warn)', sim: 'SIM-05' },
  { id: 'overload', label: 'Overload', color: 'var(--bad)', sim: 'SIM-04' },
  { id: 'audit', label: 'Audit', color: 'var(--mute)', sim: 'SIM-02' },
  { id: 'shutdown', label: 'Shutdown', color: 'var(--mute)', sim: 'SIM-06' },
]

/** Tooltip body per vector, moved off the card face but kept in full. */
export const VECTOR_TIPS: Record<VectorId, string> = {
  normal:
    'SIM-01 · Normal operation baseline\nReplays every energized channel at the draw it is already reporting, with no injected watts and no shed channels.\nExpect: the engine stores the batch and raises nothing.',
  surge:
    'SIM-03 · Capacity block rehearsal\nDrives every live channel to 82% of its draw so the rig sits inside the warning band.\nExpect: a following activation request is genuinely refused.',
  policy:
    'SIM-05 · Selective response\nSheds the lowest-priority energized channel, ordered Low → Critical.\nExpect: load drops by exactly that channel’s contribution.',
  overload:
    'SIM-04 · Post-activation overload\nTakes every live channel to 105% and injects 900 W on CH1, forcing past the critical threshold.\nExpect: the server sheds on its own terms.',
  audit:
    'SIM-02 · Activation request\nSends a real activation request for CH1 through the outlet activation route.\nExpect: the backend admits or denies it from its own projected-load check.',
  shutdown:
    'SIM-06 · Idle timeout cutoff\nReports low-draw channels at 5% of draw and closes their relays so the server sees a genuine idle period.\nExpect: the idle timer runs on the server’s own clock.',
}

export const ENDPOINT_NOTE = 'Choose an action'

type DashboardSimRailProps = {
  onRun: (id: VectorId) => void
  notice: ScenarioNotice | null
  busy: boolean
  /** False when the backend has not answered; nothing can be dispatched. */
  live: boolean
  /** Stable count of completed runs, shown on the idle line. */
  runs: number
  /**
   * Which button was last pressed. Tracked here rather than parsed back out of
   * `notice.text`, because the notice is the SERVER's words about the run — it
   * is never reshaped to carry our own bookkeeping.
   */
  lastRun: VectorId | null
}

export function DashboardSimRail({ onRun, notice, busy, live, runs, lastRun }: DashboardSimRailProps) {
  const tone = !notice ? '' : notice.tone === 'error' ? 'alert' : 'run'
  const last = lastRun ? VECTORS.find((v) => v.id === lastRun) : undefined

  return (
    <section className="mp-card" aria-label="Prescribed test vectors">
      <div className="vec">
        {VECTORS.map((vector) => (
          <button
            key={vector.id}
            type="button"
            onClick={() => onRun(vector.id)}
            title={VECTOR_TIPS[vector.id]}
            aria-label={`${vector.sim}, ${vector.label}`}
            disabled={!live || busy}
          >
            <i style={{ background: vector.color }} />
            {vector.label}
          </button>
        ))}
        <span className="ep num">{busy ? 'Sending…' : ENDPOINT_NOTE}</span>
      </div>

      {/*
        The result box. This is the one place a sentence is allowed, and it is
        built only from what the server returned — rows stored, total watts, and
        the rules the engine raised. The idle line is the reference's own copy.
      */}
      <p className={`out ${tone}`} role="status">
        {busy ? (
          <>
            <b>Sending…</b>
          </>
        ) : notice ? (
          <>
            <b>{`${last?.sim ?? 'Vector'} ran.`}</b>{' '}
            <span className="num">{notice.text}</span>
          </>
        ) : (
          <>
            <b>Ready.</b>
            {runs > 0 && <span className="num"> {`· ${runs} run${runs === 1 ? '' : 's'} this session`}</span>}
          </>
        )}
      </p>
    </section>
  )
}
