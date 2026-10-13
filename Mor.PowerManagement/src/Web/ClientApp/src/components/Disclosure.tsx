import { useId, useState, type ReactNode } from 'react'
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
 *   - ONE MUTED SUMMARY LINE, ALWAYS VISIBLE, AND IT NAMES WHAT IS AVAILABLE.
 *     Not "More info". Not an icon with no affordance.
 *   - A real <button>, so Enter and Space work without a key handler, with
 *     aria-expanded and aria-controls so the state is announced rather than
 *     merely drawn.
 *   - Collapsed means unmounted, not CSS-hidden: the prose is genuinely off the
 *     accessibility tree and out of the layout until it is asked for.
 *   - Every word is still compiled into the bundle. Hiding a caveat does not
 *     delete it, and nothing here is generated at runtime.
 *
 * EVERY DISCLOSURE IN THIS CONSOLE STARTS CLOSED. There is no `defaultOpen`
 * prop, and its absence is deliberate rather than an oversight.
 *
 * There used to be one, wired to the latched sensor fault, on the reasoning
 * that a fault "is the state of the page, so burying it behind a click would be
 * the dishonest choice". It was measured and it was wrong: because the fault is
 * almost always latched, `aria-expanded="true"` on first paint was not an
 * edge case but the normal state, and every panel that used the prop shipped
 * its full prose open. The Telemetry provenance record alone held the section
 * at 1289x677px with four identical paragraphs in it. A control that is almost
 * always open is not a disclosure; it is a slower section.
 *
 * The fault itself is still the loudest thing on the screen. It is loud in the
 * rail and in the status pill, which are not optional and are never collapsed.
 * What sits behind a disclosure is the reasoning ABOUT the fault — which part
 * to look at, why the device says it is isolated — and an operator reads that
 * once, on purpose. Removing the prop rather than clearing the three call
 * sites means the state cannot come back by accident.
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
  tone = 'quiet',
  className = '',
}: DisclosureProps) {
  const [open, setOpen] = useState(false)

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
        onClick={() => setOpen((current) => !current)}
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