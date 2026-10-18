import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Bell } from 'lucide-react'
import { EventLogPanel } from './EventLogPanel'
import type { EventLog } from '../types/dashboard'

type NotificationCentreProps = {
  events: EventLog[]
  userKey?: string | null
}

/**
 * The event log, promoted.
 *
 * THE LOG WAS THE TALLEST BLOCK ON THE DASHBOARD AND THE LEAST READ.
 *
 * Measured at 1368px, the "Event log and notifications" section sat permanently
 * in the main flow at 1289x640px — taller than the capacity meter, the channel
 * grid and the fault rail combined, and holding eight rows of historical text
 * at the bottom of a page an operator opens to read live figures. It was
 * permanent, not optional, which is a claim about attention that it had not
 * earned.
 *
 * So it moves into the bar, behind a bell, and becomes something you open
 * rather than something that is in your way. 640px of page comes back, and the
 * dashboard's first screen is the part that changes while you watch it.
 *
 * WHY IT IS NOT A MODAL.
 *
 * This console deliberately refuses to interrupt a monitoring screen. A modal
 * dims the rig behind it, which is precisely the moment an operator is looking
 * away from the rig. So the panel is a sheet anchored to the viewport's right
 * edge, over nothing, dismissible with Escape, a click outside or the close
 * control, and it does not trap focus — the tabs behind it stay tabbable.
 *
 * WHY IT IS PORTALED.
 *
 * `motion.main` animates `y`, and a transformed ancestor becomes the containing
 * block for `position: fixed`. Anchoring the sheet from inside the bar would
 * therefore pin it to the bar's own box the instant the route transition ran,
 * not to the viewport. Rendering it into `document.body` keeps "fixed means the
 * viewport" true regardless of what the shell is animating.
 *
 * WHAT THE BADGE COUNTS.
 *
 * The number of events the API has returned — not an unread count. Nothing in
 * this console tracks what a person has read, so an "unread" badge would be a
 * number with no system behind it, and it would never go down. The badge wears
 * the neutral ink rather than a severity colour because severity now has
 * exactly one home: the list below, where the dot and the word sit together.
 * A second coloured dot in the bar would put the same signal at two different
 * scopes and leave the operator guessing which is current.
 */
const PANEL_ID = 'notification-centre-panel'

export function NotificationCentre({ events, userKey }: NotificationCentreProps) {
  const [open, setOpen] = useState(false)
  const [unread, setUnread] = useState(0)
  const storageKey = `mor.notifications.readThrough.${userKey || 'local'}`
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const notifiedIds = useRef<Set<number> | null>(null)
  const readIds = useRef<Set<number> | null>(null)
  const reduceMotion = useReducedMotion()

  useEffect(() => {
    if (!events.length) return
    const notified = notifiedIds.current
    if (notified === null) {
      notifiedIds.current = new Set(events.map((event) => event.id))
      return
    }
    const fresh = events.filter((event) => !notified.has(event.id))
    for (const event of fresh) notified.add(event.id)
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    for (const event of fresh.filter((item) => item.severity === 'warning' || item.severity === 'critical')) {
      const notification = new Notification(event.title, {
        body: event.detail,
        tag: `mor-power-event-${event.id}`,
      })
      notification.onclick = () => window.focus()
    }
  }, [events])

  async function enableDesktopAlerts() {
    if (typeof Notification === 'undefined') return
    if (Notification.permission === 'default') await Notification.requestPermission()
    setAlertPermission(Notification.permission)
  }

  const [alertPermission, setAlertPermission] = useState(() =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  )

  useEffect(() => {
    if (!events.length) return
    if (readIds.current === null) {
      const saved = window.localStorage.getItem(storageKey)
      if (saved === null) {
        readIds.current = new Set(events.map((event) => event.id))
        window.localStorage.setItem(storageKey, JSON.stringify([...readIds.current]))
        setUnread(0)
        return
      }
      try {
        const parsed: unknown = JSON.parse(saved)
        if (Array.isArray(parsed)) readIds.current = new Set(parsed.filter((id: unknown): id is number => Number.isInteger(id)))
      } catch {
        // Older versions stored a numeric read-through id; migrate it below.
      }
      if (readIds.current === null) {
        const readThrough = Number(saved) || 0
        readIds.current = new Set(events.filter((event) => event.id > 0 && event.id <= readThrough).map((event) => event.id))
      }
    }
    const read = readIds.current
    if (!read) return
    if (open) {
      for (const event of events) read.add(event.id)
      window.localStorage.setItem(storageKey, JSON.stringify([...read].slice(-500)))
      setUnread(0)
      return
    }
    setUnread(events.filter((event) => !read.has(event.id)).length)
  }, [events, storageKey, open])

  function toggle() {
    const nextOpen = !open
    setOpen(nextOpen)
    if (nextOpen && events.length) {
      const read = readIds.current ?? new Set<number>()
      readIds.current = read
      for (const event of events) read.add(event.id)
      window.localStorage.setItem(storageKey, JSON.stringify([...read].slice(-500)))
      setUnread(0)
    }
  }

  useEffect(() => {
    if (!open) return

    // Move focus into the sheet so a keyboard operator lands on the log rather
    // than resuming from wherever the bar was.
    panelRef.current?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
    }

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      setOpen(false)
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open])

  const count = unread
  const label =
    count === 0
      ? 'Event log and notifications — nothing recorded yet'
      : `Notifications — ${count} unread ${count === 1 ? 'event' : 'events'}`

  const sheet = (
    <AnimatePresence>
      {open && (
        <motion.div
          id={PANEL_ID}
          ref={panelRef}
          role="dialog"
          aria-label="Event log and notifications"
          aria-modal="false"
          tabIndex={-1}
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 24 }}
          animate={reduceMotion ? { opacity: 1 } : { opacity: 1, x: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 24 }}
          transition={{ duration: reduceMotion ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] }}
          className="fixed right-0 top-16 z-50 flex max-h-[calc(100dvh-4rem)] w-full flex-col overflow-hidden border-b border-l border-outline-variant bg-background shadow-lg focus:outline-none sm:max-w-[560px]"
        >
          {/* The whole sheet scrolls under its own header, so the close control
              and the event count stay reachable with eight rows of detail
              behind them. */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="flex items-center justify-between gap-3 border-b border-outline-variant bg-surface-container-low px-4 py-2">
              <span className="text-xs text-on-surface-variant">Desktop alerts for warnings and critical events</span>
              <button
                type="button"
                className="ant-btn ant-btn-default"
                onClick={() => void enableDesktopAlerts()}
                disabled={alertPermission === 'granted' || alertPermission === 'denied' || alertPermission === 'unsupported'}
              >
                {alertPermission === 'granted' ? 'Enabled' : alertPermission === 'denied' ? 'Blocked in browser' : alertPermission === 'unsupported' ? 'Unavailable' : 'Enable alerts'}
              </button>
            </div>
            <EventLogPanel events={events} onDismiss={() => setOpen(false)} />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={PANEL_ID}
        aria-label={label}
        title={label}
        onClick={toggle}
        className="relative grid h-10 w-10 shrink-0 place-items-center rounded border border-outline-variant bg-surface-container-low text-on-surface-variant transition-colors hover:border-outline-strong hover:text-on-surface"
      >
        <Bell size={18} aria-hidden="true" />
        {count > 0 && (
          <span
            aria-hidden="true"
            className="absolute -right-1.5 -top-1.5 grid h-5 min-w-[1.25rem] place-items-center rounded-full bg-on-surface px-1 font-metric-value text-[11px] leading-none font-semibold text-background"
          >
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      {/* Portalled: the shell animates `y`, and a transformed ancestor would
          turn this `fixed` sheet into an absolutely-positioned one. */}
      {typeof document !== 'undefined' && createPortal(sheet, document.body)}
    </>
  )
}
