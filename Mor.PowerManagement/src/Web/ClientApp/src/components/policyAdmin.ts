import type { Outlet, Priority } from '../types/dashboard'

/**
 * Shared types and pure helpers for the Framework view and Framework Admin.
 *
 * Kept apart from the views so the components do not have to import from each
 * other -- a shared module has no cycle, whereas view <-> panel imports would.
 */

export type SaveState = 'idle' | 'saving' | 'saved' | 'error'

/**
 * Public name for what this screen was calling "policy".
 *
 * The engine is a demand-response control loop, not a safety device: it
 * reallocates power between outlets under a capacity ceiling. Calling it a
 * "policy" invited the reading that it is an enforcement or protection
 * mechanism, which it is not. The framework name carries the prototype caveat
 * into the same line, because that caveat is the whole point.
 */
export const FRAMEWORK_SCOPE =
  'prototype — does not replace fuses/breakers'

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

/**
 * Build-prioritization tiers.
 *
 * A tier is the operator-facing name for one of the four shed levels. It maps
 * one-to-one onto the Priority enum the backend already stores and the
 * updateOutletPolicy route already accepts, so assigning a tier is a rename of
 * the same write — not a new field, and not a migration.
 *
 * The order is the shed order: Deferrable opens before Important, and Critical
 * is preserved last.
 */
export type TierId = 'Critical' | 'Important' | 'Deferrable' | 'Nonessential'

export const TIER_IDS: TierId[] = ['Critical', 'Important', 'Deferrable', 'Nonessential']

export type TierSpec = {
  id: TierId
  /** The Priority enum value this tier writes. */
  priority: Priority
  /** One line, so the dropdown explains itself without a separate legend. */
  blurb: string
}

export const TIERS: TierSpec[] = [
  { id: 'Critical', priority: 'Critical', blurb: 'Protected last. Shed only as a last resort.' },
  { id: 'Important', priority: 'High', blurb: 'Held unless the limit cannot be met without it.' },
  { id: 'Deferrable', priority: 'Medium', blurb: 'Shed first among the working branches.' },
  { id: 'Nonessential', priority: 'Low', blurb: 'Shed first. Safe to interrupt at any time.' },
]

/** Every tier has its own allowance, including Critical outlets. */
export const TIER_HAS_OWN_CAP: Record<TierId, boolean> = {
  Critical: true,
  Important: true,
  Deferrable: true,
  Nonessential: true,
}

export function tierOf(priority: Priority | undefined): TierId {
  const match = TIERS.find((tier) => tier.priority === priority)
  return match?.id ?? 'Deferrable'
}

export function tierSpec(id: TierId): TierSpec {
  return TIERS.find((tier) => tier.id === id) ?? TIERS[2]
}

export function tierHasCap(id: TierId): boolean {
  return TIER_HAS_OWN_CAP[id]
}

// ---------------------------------------------------------------------------
// Build-prioritization situations
// ---------------------------------------------------------------------------

/** Mirrors ThresholdSet from api.ts, which is the shape the GET returns. */
export type ThresholdsForm = {
  max: number
  warning: number
  critical: number
  standby: number
  standbyIdleMinutes: number
  stabilizationDelayMs: number
}

/** Editable copy of one outlet's policy row. null idle limit means "exempt". */
export type OutletDraft = {
  priority: Priority
  allowanceWatts: number
  schedule: string
  idleLimitMinutes: number | null
}

export const PRIORITIES: Priority[] = ['Low', 'Medium', 'High', 'Critical']

export const PRIORITY_RANK: Record<Priority, number> = { Critical: 4, High: 3, Medium: 2, Low: 1 }

export function draftFrom(outlet: Outlet): OutletDraft {
  return {
    priority: outlet.priority,
    allowanceWatts: outlet.allowance,
    schedule: outlet.schedule,
    idleLimitMinutes: outlet.idleLimit === 'Exempt' ? null : Number.parseInt(outlet.idleLimit, 10),
  }
}

/** NaN-safe normalize, so a half-typed number does not read as "edited". */
function idleValue(minutes: number | null): number | null {
  if (minutes === null) return null
  return Number.isNaN(minutes) ? -1 : minutes
}

export function sameDraft(a: OutletDraft, b: OutletDraft): boolean {
  return (
    a.priority === b.priority &&
    a.allowanceWatts === b.allowanceWatts &&
    a.schedule === b.schedule &&
    idleValue(a.idleLimitMinutes) === idleValue(b.idleLimitMinutes)
  )
}

/**
 * Only the threshold fields the user actually edited.
 *
 * This is what makes the PUT safe: the endpoint is a partial update, so sending
 * one field cannot silently rewrite another that happens to be stale in the form.
 */
export function thresholdDiff(form: ThresholdsForm, base: ThresholdsForm): Record<string, number> {
  const diff: Record<string, number> = {}
  if (form.max !== base.max) diff.maxCapacityWatts = form.max
  if (form.warning !== base.warning) diff.warningThresholdWatts = form.warning
  if (form.critical !== base.critical) diff.criticalThresholdWatts = form.critical
  if (form.standby !== base.standby) diff.standbyThresholdWatts = form.standby
  if (form.standbyIdleMinutes !== base.standbyIdleMinutes) diff.standbyIdleMinutes = form.standbyIdleMinutes
  if (form.stabilizationDelayMs !== base.stabilizationDelayMs) {
    diff.stabilizationDelayMs = form.stabilizationDelayMs
  }
  return diff
}

/**
 * Rail presentation helpers, shared by Channel Inventory and Framework Admin so
 * the two screens cannot disagree about which physical rail a channel is on.
 */
export type RailFilter = 'all' | '220' | '110' | '5'

export const RAIL_FILTERS: Array<{ id: RailFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: '220', label: '220V Mains' },
  { id: '110', label: '110V Step-down' },
  { id: '5', label: '5V USB' },
]

export function railOf(volts: number): Exclude<RailFilter, 'all'> {
  if (volts >= 200) return '220'
  if (volts >= 100) return '110'
  return '5'
}

/** CSS modifier so the rail badge is colour-coded per rail. */
export function railClass(volts: number): string {
  const rail = railOf(volts)
  return rail === '220' ? 'rail-220' : rail === '110' ? 'rail-110' : 'rail-5'
}

/** Short human label, e.g. "220 V mains". */
export function railLabel(volts: number): string {
  const rail = railOf(volts)
  return rail === '220' ? '220 V mains' : rail === '110' ? '110 V step-down' : `${volts} V USB`
}

/** Priority pill colour. Low is shed first, so it reads as the urgent one. */
export function priorityTagClass(priority: Priority | undefined): string {
  switch (priority) {
    case 'Critical':
      return 'tag-blue'
    case 'High':
      return 'tag-green'
    case 'Medium':
      return 'tag-amber'
    default:
      return 'tag-red'
  }
}
