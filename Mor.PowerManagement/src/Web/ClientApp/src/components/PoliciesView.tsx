import { useEffect, useMemo, useState } from 'react'
import {
  Binary,
  CheckCircle2,
  CircleAlert,
  GitBranch,
  Lock,
  Power,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Waypoints,
  X,
} from 'lucide-react'
import { fetchPolicies, type PolicyItem } from '../api'
import { FRAMEWORK_SCOPE, FRAMEWORK_TITLE, SITUATIONS } from './policyAdmin'

/**
 * Framework Rules -- the rule repository, in the order the engine actually
 * evaluates it.
 *
 * Terminology note, because this screen used to get it wrong: these are
 * FR-xx *Framework rules*. POL-xx was the earlier identifier for eight of them
 * and survives only as `legacyCode`, shown here as traceability metadata and
 * never as the rule's current name.
 *
 * The ordering on screen is the ordering that matters operationally -- rules
 * fire in ascending precedence, so the first row is the rule that beats every
 * other rule in the same tick. Sorting by rule id instead would be prettier and
 * wrong, so the precedence column is the anchor of every row.
 *
 * Metering copy is deliberately specific about what is measured: an INA226
 * reads the mains total, and an ADS1015 reads the four per-branch sensors.
 * P_branch_i is the measured branch figure, not a share of a single meter.
 */

const actions = [
  {
    code: 'ACT_ALLOW(i)',
    result:
      'Energises branch i: releases the relay coil so the normally-closed contact re-closes, then holds a 500 ms stabilization delay.',
    opens: false,
  },
  {
    code: 'ACT_DENY(i)',
    result:
      'Refuses the request, holds branch i open, and logs insufficient capacity. No relay is closed.',
    opens: true,
  },
  {
    code: 'ACT_SHED(i)',
    result:
      'Cuts branch i to reduce total load and logs the shedding event. On a normally-closed relay this means driving the pin LOW.',
    opens: true,
  },
  {
    code: 'ACT_PRESERVE(i)',
    result:
      'Keeps a high-priority relay unchanged during active shedding — the coil stays released and the contact stays closed.',
    opens: false,
  },
  {
    code: 'ACT_FAULT()',
    result:
      'Drives every relay pin LOW, opens all five contacts, isolates the prototype, and sets the critical lockout flags.',
    opens: true,
  },
  {
    code: 'ACT_DOWNGRADE(i)',
    result: 'Drops an overdue-calibration branch from Critical to High priority. Metering only — no relay moves.',
    opens: false,
  },
  {
    code: 'ACT_LOG()',
    result: 'Writes the rule audit row that every firing emits. Recording only — no relay moves.',
    opens: false,
  },
]

const fallbackPolicies: PolicyItem[] = [
  {
    id: 'FR-01',
    name: 'Hardware Fault Isolation',
    condition: 'S_fault is TRUE for 3 consecutive ticks',
    action: 'ACT_FAULT()',
    legacyCode: 'POL-01',
    ruleFamily: 'Safety/Interlock',
    precedence: 10,
    enabled: true,
  },
  {
    id: 'FR-02',
    name: 'Voltage Window Protection',
    condition: 'Branch voltage outside 198-264 V (220 V class) for 2 consecutive ticks',
    action: 'ACT_SHED(i) + latch',
    legacyCode: null,
    ruleFamily: 'Safety/Interlock',
    precedence: 20,
    enabled: true,
  },
  {
    id: 'FR-03',
    name: 'Branch Overcurrent Protection',
    condition: 'I_branch exceeds 1.25 x rated amps for 2 consecutive ticks',
    action: 'ACT_SHED(i) + latch',
    legacyCode: null,
    ruleFamily: 'Safety/Interlock',
    precedence: 30,
    enabled: true,
  },
  {
    id: 'FR-04',
    name: 'Pre-Activation Assessment',
    condition: 'Request(i) and P_total + Allowance(i) is at or below P_limit',
    action: 'ACT_ALLOW(i)',
    legacyCode: 'POL-02',
    ruleFamily: 'PreActivation',
    precedence: 40,
    enabled: true,
  },
  {
    id: 'FR-05',
    name: 'Pre-Activation Denial',
    condition: 'Request(i) and P_total + Allowance(i) exceeds P_limit, or branch is latched',
    action: 'ACT_DENY(i)',
    legacyCode: 'POL-03',
    ruleFamily: 'PreActivation',
    precedence: 50,
    enabled: true,
  },
  {
    id: 'FR-06',
    name: 'Post-Activation Verification',
    condition: '500 ms after activation and P_total exceeds P_limit',
    action: 'ACT_SHED(i) - newest activation first',
    legacyCode: 'POL-04',
    ruleFamily: 'PostActivation',
    precedence: 60,
    enabled: true,
  },
  {
    id: 'FR-07',
    name: 'Load Shedding Level 1',
    condition: 'P_total exceeds P_limit for low-priority energized outlets',
    action: 'ACT_SHED(i)',
    legacyCode: 'POL-05',
    ruleFamily: 'DemandSide',
    precedence: 70,
    enabled: true,
  },
  {
    id: 'FR-08',
    name: 'Load Shedding Level 2',
    condition: 'Overload remains after low-priority shedding',
    action: 'ACT_SHED(i) for medium priority',
    legacyCode: 'POL-06',
    ruleFamily: 'DemandSide',
    precedence: 80,
    enabled: true,
  },
  {
    id: 'FR-09',
    name: 'Priority Preservation',
    condition: 'High or Critical outlet is active during shedding',
    action: 'ACT_PRESERVE(i)',
    legacyCode: 'POL-07',
    ruleFamily: 'DemandSide',
    precedence: 90,
    enabled: true,
  },
  {
    id: 'FR-10',
    name: 'Standby Load Management',
    condition: 'P_branch_i stays below the 80 W standby threshold for 30 minutes',
    action: 'ACT_SHED(i)',
    legacyCode: 'POL-08',
    ruleFamily: 'Idle',
    precedence: 100,
    enabled: true,
  },
  {
    id: 'FR-11',
    name: 'Calibration Due Downgrade',
    condition: 'CalibrationDueAt is in the past for the branch instrument class',
    action: 'ACT_DOWNGRADE(i)',
    legacyCode: null,
    ruleFamily: 'Measurement',
    precedence: 110,
    enabled: true,
  },
  {
    id: 'FR-12',
    name: 'Rule Audit Trail',
    condition: 'Any rule fires',
    action: 'ACT_LOG()',
    legacyCode: null,
    ruleFamily: 'Audit',
    precedence: 120,
    enabled: true,
  },
]

const contextVariables = [
  ['P_limit', 'Configured operating limit for the prototype extension (1200 W on the testing rig)'],
  ['P_total', 'Aggregate measured load: the INA226 mains total plus the reported USB rail'],
  [
    'P_branch_i',
    'Per-outlet load, read on that branch’s own ADS1015 analogue channel (CH1-CH4)',
  ],
  ['O_priority_i', 'Outlet priority index used for selective response order'],
  ['O_relay_i', 'Relay state reported by the ESP32 output channel (GPIO 10-14)'],
  ['S_fault', 'Sensor or communication health flag covering the I2C devices on GPIO 8/9'],
] as const

/**
 * Colour discipline: family names are categories, not verdicts, so they are
 * plain muted text and the row carries no coloured border. Safety/Interlock is
 * the single exception — it is the family that actually opens a contact on a
 * fault, so its rule id is allowed to be the loud row in an otherwise quiet
 * table. Everything else on this screen earns its hierarchy from whitespace,
 * hairlines and type weight.
 */
function isSafetyFamily(family: string): boolean {
  return family === 'Safety/Interlock'
}

/**
 * The shared table-header step. `.ant-table-header` in ant.css sets body-md;
 * this pins the same 14px run to the title-md token so every column head in the
 * console is named by the same step rather than inheriting whichever parent
 * happened to set it.
 */
const TH = 'px-3 py-2.5 font-title-md text-title-md font-semibold'

export function PoliciesView() {
  // Live FR-01..FR-12 from the backend; static copy stays as offline fallback.
  const [policies, setPolicies] = useState<PolicyItem[]>(fallbackPolicies)
  // The banner has to say which copy is on screen — an unreachable backend must
  // not be presented as live rule state.
  const [source, setSource] = useState<'fallback' | 'live'>('fallback')

  const [family, setFamily] = useState<string>('all')
  const [query, setQuery] = useState('')

  useEffect(() => {
    fetchPolicies()
      .then((rules) => {
        if (Array.isArray(rules) && rules.length > 0) {
          setPolicies(rules)
          setSource('live')
        }
      })
      .catch(() => undefined)
  }, [])

  // Ascending precedence IS the evaluation order. Sorting by id would read
  // better and describe a machine that does not exist.
  const ordered = useMemo(
    () => [...policies].sort((a, b) => a.precedence - b.precedence),
    [policies],
  )

  const familyCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const rule of ordered) counts.set(rule.ruleFamily, (counts.get(rule.ruleFamily) ?? 0) + 1)
    return counts
  }, [ordered])

  const families = useMemo(() => {
    // Safety/Interlock first, then the rest in the order they first appear in
    // the precedence sequence — a stable, meaningful order rather than A-Z.
    const seen = ordered.map((rule) => rule.ruleFamily)
    const rest = seen.filter((name) => name !== 'Safety/Interlock')
    return ['Safety/Interlock', ...rest.filter((name, index) => rest.indexOf(name) === index)]
  }, [ordered])

  const normalizedQuery = query.trim().toLowerCase()

  const visibleRules = useMemo(() => {
    return ordered.filter((rule) => {
      if (family !== 'all' && rule.ruleFamily !== family) return false
      if (!normalizedQuery) return true
      return `${rule.id} ${rule.legacyCode ?? ''} ${rule.name} ${rule.condition} ${rule.action} ${rule.ruleFamily}`
        .toLowerCase()
        .includes(normalizedQuery)
    })
  }, [ordered, family, normalizedQuery])

  const filtersActive = family !== 'all' || normalizedQuery.length > 0

  const latchingCount = ordered.filter((rule) => rule.action.includes('latch')).length
  const legacyCount = ordered.filter((rule) => rule.legacyCode !== null).length
  const enabledCount = ordered.filter((rule) => rule.enabled).length

  // Which rules actually invoke each action, read off the live rule set rather
  // than restated by hand. `opens` is the safety-relevant part: those actions
  // drive a relay pin LOW and open a normally-closed contact.
  const actionUsage = useMemo(() => {
    const usage = new Map<string, string[]>()
    for (const action of actions) usage.set(action.code, [])
    for (const rule of ordered) {
      for (const action of actions) {
        if (rule.action.startsWith(action.code)) {
          usage.get(action.code)?.push(rule.id)
        }
      }
    }
    return usage
  }, [ordered])

  return (
    <section className="design-main" aria-label="Framework">
      {/* --- Breadcrumb ------------------------------------------------------ */}
      <nav aria-label="Breadcrumb" className="mb-space-sm flex items-center gap-space-sm">
        <span className="font-body-sm text-body-sm text-on-surface-variant">Console</span>
        <span className="font-body-sm text-body-sm text-outline-variant" aria-hidden>
          /
        </span>
        <strong className="font-body-sm text-body-sm font-semibold text-on-surface">Framework</strong>
      </nav>

      {/* --- Page head ------------------------------------------------------- */}
      <header className="mb-space-lg flex flex-col gap-space-md lg:flex-row lg:items-end lg:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="font-headline-md text-headline-md text-on-surface">
            {FRAMEWORK_TITLE}
          </h1>
          {/* The scope caveat rides the title, not a footnote. A reader who
              takes only the heading must still see that this is a prototype
              and not a substitute for the fuse and the breaker. */}
          <p className="font-body-md text-body-md text-on-surface-variant">
            <span className="font-semibold text-on-surface">({FRAMEWORK_SCOPE})</span>
          </p>
          <p className="max-w-3xl font-body-sm text-body-sm text-on-surface-variant">
            The complete rule set the ESP32 evaluates once per tick, in the order it evaluates it.
            FR-xx is the current identifier; the earlier POL-xx codes are retained for traceability only.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-x-space-lg gap-y-1 font-body-sm text-body-sm text-on-surface-variant">
          <span className="inline-flex items-center gap-1.5 font-semibold">
            {/* Live source is the ordinary case, not a verdict, so it wears the
                neutral dot rather than the shared `ant-dot-normal` green. */}
            <span
              className={`ant-dot ${source === 'live' ? 'bg-outline-variant' : 'ant-dot-warning'}`}
              aria-hidden
            />
            {source === 'live' ? 'Live' : 'Offline copy'}
            {source === 'live' && (
              <span className="font-metric-value text-metric-value">· GET /Dashboard/policies</span>
            )}
          </span>
          <span>
            <span className="font-metric-value text-metric-value">
              {`${enabledCount}/${ordered.length}`}
            </span>{' '}
            enabled
          </span>
        </div>
      </header>

      {/* --- Build-prioritization situations ---------------------------------
          Placed above the rule matrix because it is what a panelist asks first:
          "what actually happens when it trips?" The matrix below is the
          mechanism; these four are the outcomes it produces.

          These cards are descriptions, not controls. Each names the Dashboard
          vector that produces it; the buttons that actually dispatch the real
          ingest and activation routes live on that view, so nothing here can
          claim a run it did not make. */}
      <section className="ant-card mb-space-lg overflow-hidden" aria-labelledby="situations-heading">
        <div className="ant-card-header flex-col items-stretch lg:flex-row lg:items-center">
          <div className="flex flex-wrap items-center gap-2">
            <Waypoints size={20} className="text-on-surface-variant" aria-hidden />
            <h2 id="situations-heading" className="font-title-lg text-title-lg font-semibold text-on-surface">
              Build-prioritization situations
            </h2>
            <code className="rounded bg-surface-container px-2 py-0.5 font-metric-value text-metric-value text-on-surface-variant">
              {`${SITUATIONS.length} situations`}
            </code>
          </div>
          <span className="font-body-sm text-body-sm text-on-surface-variant">
            Run each on the Dashboard vectors
          </span>
        </div>

        <div className="ant-card-body grid grid-cols-1 gap-space-md sm:grid-cols-2 xl:grid-cols-4">
          {SITUATIONS.map((situation) => (
            <article
              key={situation.id}
              className="flex flex-col gap-space-sm rounded-lg border border-outline-variant bg-surface-container-low p-space-md"
              aria-label={`Situation ${situation.n}, ${situation.title}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="font-metric-value text-metric-value font-semibold text-outline">
                    {String(situation.n).padStart(2, '0')}
                  </span>
                  <h3 className="min-w-0 font-title-md text-title-md font-semibold text-on-surface">
                    {situation.title}
                  </h3>
                </div>
                <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                  <span
                    className={`ant-dot ${
                      situation.tone === 'critical'
                        ? 'ant-dot-critical'
                        : situation.tone === 'warning'
                          ? 'ant-dot-warning'
                          : 'bg-outline-variant'
                    }`}
                    aria-hidden
                  />
                  <span className="font-metric-value text-metric-value text-on-surface-variant">
                    {situation.bandLabel}
                  </span>
                </span>
              </div>

              <dl className="flex flex-col gap-1 font-code text-code">
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-outline">When</dt>
                  <dd className="min-w-0 truncate text-right text-on-surface-variant" title={situation.condition}>
                    {situation.condition}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-outline">Rule</dt>
                  <dd className="font-metric-value text-metric-value text-on-surface">{situation.frame}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-outline">Vector</dt>
                  <dd className="font-metric-value text-metric-value text-on-surface">{situation.sim}</dd>
                </div>
              </dl>

              <p className="font-body-sm text-body-sm text-on-surface-variant">{situation.expected}</p>

              <code
                className="mt-auto block min-w-0 truncate rounded bg-surface-container-lowest px-space-sm py-1 font-code text-code text-outline"
                title={situation.endpoint}
              >
                {situation.endpoint}
              </code>
            </article>
          ))}
        </div>
      </section>

      {/* --- Rule matrix ----------------------------------------------------- */}
      <section className="ant-card mb-space-lg overflow-hidden" aria-labelledby="rule-matrix-heading">
        <div className="ant-card-header flex-col items-stretch lg:flex-row lg:items-center">
          <div className="flex flex-wrap items-center gap-2">
            <Waypoints size={20} className="text-on-surface-variant" aria-hidden />
            <h2
              id="rule-matrix-heading"
              className="font-title-lg text-title-lg font-semibold text-on-surface"
            >
              Framework execution matrix
            </h2>
            <code className="rounded bg-surface-container px-2 py-0.5 font-metric-value text-metric-value text-on-surface-variant">
              FR-01 … FR-12 · ascending precedence
            </code>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-space-sm">
            <div className="ant-segmented overflow-x-auto" role="group" aria-label="Filter rules by family">
              <button
                type="button"
                aria-pressed={family === 'all'}
                onClick={() => setFamily('all')}
                className={`ant-segmented-item ${
                  family === 'all' ? 'ant-segmented-item-active text-primary font-semibold' : ''
                }`}
              >
                {`All families (${ordered.length})`}
              </button>
              {families.map((name) => (
                <button
                  key={name}
                  type="button"
                  aria-pressed={family === name}
                  onClick={() => setFamily(name)}
                  className={`ant-segmented-item ${
                    family === name ? 'ant-segmented-item-active text-primary font-semibold' : ''
                  }`}
                >
                  {`${name} (${familyCounts.get(name) ?? 0})`}
                </button>
              ))}
            </div>
            <div className="relative flex min-w-[200px] items-center">
              <Search
                size={16}
                aria-hidden
                className="pointer-events-none absolute left-2.5 text-on-surface-variant"
              />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter rules…"
                aria-label="Search framework rules"
                className="ant-input pl-8 font-body-sm text-body-sm"
              />
            </div>
            {filtersActive && (
              <button
                type="button"
                className="ant-btn ant-btn-default"
                onClick={() => {
                  setFamily('all')
                  setQuery('')
                }}
              >
                <X size={16} aria-hidden />
                Clear
              </button>
            )}
          </div>
        </div>

        {visibleRules.length === 0 ? (
          <div className="ant-card-body flex flex-col items-start gap-space-md">
            <div className="flex items-center gap-space-sm">
              <span className="ant-dot ant-dot-warning" aria-hidden />
              <h3 className="font-title-lg text-title-lg text-on-surface">No rules match</h3>
            </div>
            <p className="font-body-md text-body-md text-on-surface-variant">
              Nothing in the{' '}
              <span className="font-metric-value text-metric-value">{ordered.length}</span>-rule set
              matches{' '}
              {normalizedQuery ? (
                <span className="font-body-sm text-body-sm">&ldquo;{query.trim()}&rdquo;</span>
              ) : (
                <span className="font-body-sm text-body-sm">{family}</span>
              )}
              . Clear the filters to read the whole evaluation order.
            </p>
            <button
              type="button"
              className="ant-btn ant-btn-primary"
              onClick={() => {
                setFamily('all')
                setQuery('')
              }}
            >
              <X size={16} aria-hidden />
              Clear filters
            </button>
          </div>
        ) : (
          <div className="w-full overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead className="ant-table-header">
                <tr>
                  <th scope="col" className={`w-20 ${TH} text-right`}>
                    Precedence
                  </th>
                  <th scope="col" className={`min-w-[220px] ${TH}`}>
                    Framework rule
                  </th>
                  <th scope="col" className={`min-w-[150px] ${TH}`}>
                    Family
                  </th>
                  <th scope="col" className={`min-w-[300px] ${TH}`}>
                    Condition
                  </th>
                  <th scope="col" className={`min-w-[220px] ${TH}`}>
                    Action
                  </th>
                  <th scope="col" className={TH}>
                    State
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleRules.map((rule) => {
                  const safety = isSafetyFamily(rule.ruleFamily)
                  return (
                    <tr key={rule.id} className="ant-table-row">
                      <td className="px-3 py-2.5 align-middle">
                        <span className="ant-table-num font-semibold text-on-surface">{rule.precedence}</span>
                      </td>

                      <td className="px-3 py-2.5 align-middle">
                        <div className="flex flex-col">
                          <span className="flex items-baseline gap-2">
                            <span
                              className={`font-metric-value text-metric-value font-semibold ${
                                safety ? 'text-error' : 'text-on-surface'
                              }`}
                            >
                              {rule.id}
                            </span>
                            <span className="font-title-md text-title-md text-on-surface">{rule.name}</span>
                          </span>
                          {rule.legacyCode && (
                            <span
                              className="font-metric-value text-metric-value text-outline"
                              title="Superseded identifier, kept for traceability against earlier drafts"
                            >
                              {`legacy ${rule.legacyCode}`}
                            </span>
                          )}
                        </div>
                      </td>

                      <td className="px-3 py-2.5 align-middle">
                        <span className="font-body-sm text-body-sm text-on-surface-variant">{rule.ruleFamily}</span>
                      </td>

                      <td className="px-3 py-2.5 align-middle">
                        <span className="font-metric-value text-metric-value text-on-surface-variant">
                          {rule.condition}
                        </span>
                      </td>

                      <td className="px-3 py-2.5 align-middle">
                        <span className="inline-flex items-center gap-2">
                          <code className="rounded bg-surface-container px-2 py-0.5 font-metric-value text-metric-value text-on-surface">
                            {rule.action}
                          </code>
                          {/* Latching is a property of the rule, not a status of
                              the system, so it reads as a qualifier beside the
                              action code rather than a filled chip. */}
                          {rule.action.includes('latch') && (
                            <span className="font-label-sm text-label-sm uppercase text-on-surface-variant">
                              latches
                            </span>
                          )}
                        </span>
                      </td>

                      <td className="px-3 py-2.5 align-middle">
                        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                          {/* Enabled is the default state, so it is neutral grey;
                              green would make the ordinary case the loudest one. */}
                          <span
                            className={`ant-dot ${rule.enabled ? 'bg-outline-variant' : 'ant-dot-warning'}`}
                            aria-hidden
                          />
                          <span className="font-body-sm text-body-sm text-on-surface-variant">
                            {rule.enabled ? 'Enabled' : 'Disabled'}
                          </span>
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Summary strip: the counts an operator actually asks about. */}
        <div className="flex flex-col gap-space-sm bg-surface-container-low px-space-lg py-space-md xl:flex-row xl:items-center xl:justify-between">
          <div className="flex flex-wrap items-center gap-space-lg">
            <span className="flex items-baseline gap-1.5">
              <span className="font-title-md text-title-md text-on-surface-variant">Rules loaded</span>
              <span className="font-metric-display text-metric-display font-semibold text-on-surface">
                {visibleRules.length}
              </span>
              <span className="font-metric-value text-metric-value text-outline">/ {ordered.length}</span>
            </span>
            <span className="rounded bg-surface-container px-2.5 py-1 font-body-sm text-body-sm text-on-surface-variant">
              <span className="font-semibold text-error">
                <span className="font-metric-value text-metric-value">{latchingCount}</span> latch
              </span>
              <span className="text-outline"> · </span>
              <span>FR-01 to FR-03 need acknowledgement</span>
            </span>
            <span className="rounded bg-surface-container px-2.5 py-1 font-body-sm text-body-sm text-on-surface-variant">
              <span className="font-semibold text-on-surface">
                <span className="font-metric-value text-metric-value">{legacyCount}</span> with a legacy
                code
              </span>
              <span className="text-outline"> · </span>
              <span>POL-xx, superseded by FR-xx</span>
            </span>
          </div>
          <span className="font-body-sm text-body-sm text-on-surface-variant">
            Lowest precedence fires first. FR-07 to FR-09 never shed a High or Critical branch.
          </span>
        </div>
      </section>

      {/* --- Action space ---------------------------------------------------- */}
      <section className="ant-card mb-space-lg overflow-hidden" aria-labelledby="action-space-heading">
        <div className="ant-card-header">
          <div className="flex flex-wrap items-center gap-2">
            <Lock size={20} className="text-on-surface-variant" aria-hidden />
            <h2
              id="action-space-heading"
              className="font-title-lg text-title-lg font-semibold text-on-surface"
            >
              Action space
            </h2>
            <span className="font-body-sm text-body-sm text-on-surface-variant">
              <span className="font-metric-value text-metric-value">7</span> discrete commands
            </span>
          </div>
          <p className="max-w-md font-body-sm text-body-sm text-on-surface-variant">
            A rule can only produce one of these. Nothing else reaches the relay driver.
          </p>
        </div>

        <div className="ant-card-body grid grid-cols-1 gap-space-md md:grid-cols-2 xl:grid-cols-3">
          {actions.map((action) => {
            const usedBy = actionUsage.get(action.code) ?? []
            return (
              <article
                key={action.code}
                className={`flex flex-col gap-2 rounded-md border p-space-md ${
                  action.opens ? 'border-outline-variant border-l-2 border-l-error' : 'border-outline-variant'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {/* The action code is a command name, not a live control, so it
                      wears the neutral surface tone rather than the primary
                      reserved for things the operator can act on. */}
                  <code className="rounded bg-surface-container px-2 py-1 font-metric-value text-metric-value font-semibold text-on-surface">
                    {action.code}
                  </code>
                  {action.opens ? (
                    <span className="inline-flex items-center gap-1.5 font-label-sm text-label-sm uppercase text-error">
                      <span className="ant-dot ant-dot-critical" aria-hidden />
                      Opens contact
                    </span>
                  ) : (
                    <span className="font-label-sm text-label-sm uppercase text-on-surface-variant">
                      No relay motion
                    </span>
                  )}
                </div>
                <p className="font-body-sm text-body-sm text-on-surface-variant">{action.result}</p>
                <p className="mt-auto font-metric-value text-metric-value text-outline">
                  {usedBy.length === 0
                    ? 'Not currently referenced by any rule'
                    : `Invoked by ${usedBy.join(', ')}`}
                </p>
              </article>
            )
          })}
        </div>
      </section>

      {/* --- Context variables ----------------------------------------------- */}
      <section className="ant-card mb-space-lg overflow-hidden" aria-labelledby="context-heading">
        <div className="ant-card-header">
          <div className="flex flex-wrap items-center gap-2">
            <Binary size={20} className="text-on-surface-variant" aria-hidden />
            <h2
              id="context-heading"
              className="font-title-lg text-title-lg font-semibold text-on-surface"
            >
              Context variables
            </h2>
            <span className="font-body-sm text-body-sm text-on-surface-variant">Measured inputs</span>
          </div>
          <p className="max-w-md font-body-sm text-body-sm text-on-surface-variant">
            Every condition above reads from this set and nothing else.
          </p>
        </div>

        <div className="ant-card-body grid grid-cols-1 gap-space-md md:grid-cols-2 xl:grid-cols-3">
          {contextVariables.map(([name, description]) => (
            <article key={name} className="rounded-md border border-outline-variant p-space-md">
              <code className="rounded bg-surface-container px-2 py-0.5 font-metric-value text-metric-value font-semibold text-on-surface">
                {name}
              </code>
              <p className="mt-1.5 font-body-sm text-body-sm text-on-surface-variant">{description}</p>
            </article>
          ))}
        </div>
      </section>

      {/* --- Notes ----------------------------------------------------------- */}
      <div className="grid grid-cols-1 gap-space-md lg:grid-cols-3">
        <article className="ant-card">
          <div className="ant-card-body flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <GitBranch size={18} className="text-on-surface-variant" aria-hidden />
              <h2 className="font-title-lg text-title-lg font-semibold text-on-surface">
                How the loop runs
              </h2>
            </div>
            <p className="font-body-md text-body-md text-on-surface-variant">
              The ESP32 synchronises outlet states, polls the INA226 over I²C for its DC bus and shunt readings, and polls the ADS1015
              on the branch sensors, evaluates the rules above in ascending precedence, and executes one
              deterministic relay action. Activation is always pre-check, then a 500 ms stabilization
              delay, then post-activation verification — and a standby channel is still connected and
              still counted as an active load.
            </p>
          </div>
        </article>

        <article className="ant-card">
          <div className="ant-card-body flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <CheckCircle2 size={18} className="text-on-surface-variant" aria-hidden />
              <h2 className="font-title-lg text-title-lg font-semibold text-on-surface">
                Precedence is the contract
              </h2>
            </div>
            <p className="font-body-md text-body-md text-on-surface-variant">
              In any tick, the lowest-numbered rule that fires for a branch wins, and the rest are not
              consulted for that branch. FR-01 to FR-03 latch and require acknowledgement before the
              branch can be activated again.
            </p>
          </div>
        </article>

        <article className="ant-card">
          <div className="ant-card-body flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <CircleAlert size={18} className="text-error" aria-hidden />
              <h2 className="font-title-lg text-title-lg font-semibold text-on-surface">
                These rules are not protection
              </h2>
            </div>
            <p className="font-body-md text-body-md text-on-surface-variant">
              The rule set defines prototype control behaviour only. It does not interrupt fault
              current. Physical protection still depends on properly rated fuses, wiring, terminals,
              enclosure design, and qualified review.
            </p>
          </div>
        </article>
      </div>

      <div className="mt-space-md flex flex-wrap items-center gap-space-md font-body-sm text-body-sm text-outline">
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck size={13} aria-hidden />
          Framework rules, not policies — POL-xx codes are superseded identifiers.
        </span>
        <span className="inline-flex items-center gap-1.5">
          <SlidersHorizontal size={13} aria-hidden />
          Editing and enabling rules happen on the Framework Admin screen; this view is read-only.
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Power size={13} aria-hidden />
          Actions that open a contact drive the relay pin LOW — the contacts are normally closed.
        </span>
      </div>
    </section>
  )
}
