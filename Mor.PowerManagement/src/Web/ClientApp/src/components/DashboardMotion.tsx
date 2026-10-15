import { useEffect, useRef, useState } from 'react'

/**
 * Motion tokens for the live dashboard.
 *
 * Animation budget, deliberately capped. The ui-ux-pro-max rule set is explicit
 * that "too many animations cause distraction and motion sickness" and that a
 * view should "animate 1-2 key elements maximum". This dashboard therefore runs
 * exactly two CONTINUOUS animations — the streaming dot in the header and the
 * rail's live marker — and treats the value flash as event-driven: it fires on
 * an actual change and stops, so it cannot become ambient motion.
 *
 * Both keyframes animate `transform` and `opacity` ONLY, never width/height/
 * top/left. Those properties force layout on every frame, and at 1 Hz on a
 * panel that is already re-rendering that is the difference between a smooth
 * readout and a janky one.
 */
const MOTION_CSS = `
@keyframes dash-flash {
  0%   { transform: scale(1.06); opacity: 0.5; }
  100% { transform: scale(1);    opacity: 0; }
}
@keyframes dash-pulse {
  0%   { transform: scale(1);   opacity: 0.65; }
  70%  { transform: scale(2.4); opacity: 0; }
  100% { transform: scale(2.4); opacity: 0; }
}

/*
 * Reduced motion is enforced here rather than per call-site, so a new animation
 * cannot ship without inheriting the guard. The data still updates; only the
 * movement is removed.
 */
@media (prefers-reduced-motion: reduce) {
  .dash-flash, .dash-pulse { animation: none !important; }
}
`

/** Renders the keyframes once. Mounted by Dashboard; every child relies on them. */
export function DashboardMotion() {
  return <style>{MOTION_CSS}</style>
}

/**
 * True for a short window after `value` changes, so the caller can flash.
 *
 * Built to the "cancellable state transitions" rule: rapid changes may
 * interrupt an in-flight transition, so this never depends on `animationend` or
 * `transitionend` for correctness. The displayed number always comes straight
 * from props; this flag is decoration only, and the timer is cleared on every
 * re-trigger so the flash always ends settled rather than stranded on.
 */
export function useValueFlash(value: number): boolean {
  const [flash, setFlash] = useState(false)
  const previous = useRef(value)

  useEffect(() => {
    if (previous.current === value) return
    previous.current = value
    setFlash(true)

    const timer = window.setTimeout(() => setFlash(false), 480)
    return () => window.clearTimeout(timer)
  }, [value])

  return flash
}

/** Shared class names so the flash geometry is identical on every readout. */
export const FLASH_OVERLAY = 'dash-flash animate-[dash-flash_480ms_ease-out]'
export const PULSE_RING = 'dash-pulse animate-[dash-pulse_1800ms_ease-out_infinite]'