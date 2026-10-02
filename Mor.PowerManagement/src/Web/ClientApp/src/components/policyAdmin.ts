import type { Outlet, Priority } from '../types/dashboard'

/**
 * Shared types and pure helpers for Policy Administration.
 *
 * Kept apart from the view so the three components (view, threshold panel,
 * outlet table) do not have to import from each other -- a shared module has no
 * cycle, whereas view <-> panel imports would.
 */

export type SaveState = 'idle' | 'saving' | 'saved' | 'error'

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
