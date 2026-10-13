import { useEffect, useId, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

type DisclosureProps = {
  /**
   * Accessible name for the region. Not the summary — the summary is what a
   * sighted reader sees, and the two are allowed to differ.
   */
  label: string
  /**
   * The one line that is always on screen. It must SAY that the material
   * exists, not hint at it: this control is the only affordance a reader has
   * that anything is behind it.
   */
  summary: ReactNode
  children: ReactNode
  /**
   * Start expanded, and keep expanding while it stays true.
   *
   * Used where the material IS the state of the page — a latched sensor fault —
   * so burying it behind a click would be the dishonest choice. It is a live
   * prop rather than a mount-time default because the fault arrives with the
   * first snapshot, after this component has already mounted.
   */
  defaultOpen?: boolean
  /** `critical` wears the error rail. Reserved for the fault surfaces. */
  tone?: 'quiet' | 'critical'
  className?: string
}

/**
 * THE CONSOLE'S ONE DISCLOSURE.
 *
 * This console carries a large amount of honesty material: what is on the
 * bench, what is deliberately not measured, which figures are shared readings
 * rather than per-branch ones, and what the device says about itself. All of
 * it is load-bearing — deleting any of it would put a false claim back on
 * screen — and all of it was previously rendered permanently, which made the
 * console read as a wall of caveats instead of a dashboard.
 *
 * So the words are not shortened and not cut. They MOVE behind this control.
 * The rules it keeps:
 *
 *   - One muted summary line, always visible, and it names what is available.
 *     Not "More info". Not an icon with no affordance.
 *   - A real <button>, so Enter and Space work without a key handler, with
 *     aria-expanded and aria-controls so the state is announced rather than
 *     merely drawn.
 *   - Collapsed means unmounted, not CSS-hidden: the prose is genuinely off the
 *     accessibility tree and out of the layout until it is asked for.
 *   - Every word is still compiled into the bundle. Hiding a caveat does not
 *     delete it, and nothing here is generated at runtime.
 *
 * It is deliberately not a modal, not a tooltip and not a hover target. A
 * tooltip cannot be tabbed to, a modal interrupts a monitoring screen an
 * operator is watching rather than reading, and hover hides the only copy of a
 * statement on a page that may be projected.
 */
export function Disclosure({
  label,
  summary,
  children,
  defaultOpen = false,
  tone = 'quiet',
  className = '',
}: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen)
  // Once the reader has made a choice, the page stops overriding it.
  const [touched, setTouched] = useState(false)

  useEffect(() => {
    if (defaultOpen && !touched) setOpen(true)
  }, [defaultOpen, touched])

  const reactId = useId().replace(/:/g, '')
  const panelId = `disclosure-panel-${reactId}`
  const critical = tone === 'critical'

  return (
    <section
      className={`overflow-hidden rounded-lg border bg-surface-container-lowest ${
        critical ? 'border-error-fixed border-l-4' : 'border-outline-variant'
      } ${className}`}
      aria-label={label}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setTouched(true)
          setOpen((current) => !current)
        }}
        className={`flex w-full items-center gap-2 px-space-md py-2.5 text-left transition-colors ${
          critical ? 'text-error hover:brightness-95' : 'text-on-surface-variant hover:text-on-surface'
        }`}
      >
        <ChevronDown
          size={16}
          aria-hidden="true"
          className={`shrink-0 transition-transform motion-reduce:transition-none ${
            open ? 'rotate-180' : '-rotate-90'
          }`}
        />
        <span className="min-w-0 flex-1 font-body-sm text-body-sm">{summary}</span>
        <span className="shrink-0 font-label-sm text-label-sm uppercase">{open ? 'Hide' : 'Show'}</span>
      </button>

      {open && (
        <div
          id={panelId}
          className="flex flex-col gap-space-md border-t border-outline-variant px-space-md py-space-md"
        >
          {children}
        </div>
      )}
    </section>
  )
}