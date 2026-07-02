import { X, Mic } from 'lucide-react'
import { MantuMark } from './MantuMark'
import { useWindowDrag } from '../lib/window-drag'

/**
 * Collapsed control mini-pill (Cluely's second window). Shown instead of the full widget when the
 * overlay is minimized: the Mantu mark expands it back, "Hide" fully hides the window (a global
 * hotkey restores it), and the mic toggles Listen. Draggable like the main widget.
 */
export function ControlPill({
  onExpand,
  onHide,
  onToggleListen,
  listening
}: {
  onExpand: () => void
  onHide: () => void
  onToggleListen: () => void
  listening: boolean
}): JSX.Element {
  const drag = useWindowDrag()
  return (
    // data-hug-width: lets useAutoResize report this element's own shrink-to-fit width to the window
    // instead of the wider fixed guess — without it, the window stayed wider than the visible pill and
    // silently swallowed clicks meant for whatever app was behind that invisible margin.
    <div
      {...drag}
      data-hug-width
      className="aw-pill inline-flex items-center gap-2 p-1.5"
    >
      <button
        type="button"
        title="Expand AskToto"
        aria-label="Expand AskToto"
        onClick={onExpand}
        className="no-drag focus-ring block shrink-0 rounded-[8px]"
      >
        <span className="aw-mark-glow block rounded-[8px]">
          <MantuMark size={30} />
        </span>
      </button>
      <button
        type="button"
        onClick={onHide}
        aria-label="Hide AskToto"
        className="no-drag focus-ring flex h-[34px] shrink-0 items-center gap-1.5 rounded-full bg-white/[0.06] px-3.5 text-[13px] font-semibold text-[color:var(--color-ink-2)] hover:bg-white/10 hover:text-[color:var(--color-ink)]"
      >
        <X size={14} /> Hide
      </button>
      <button
        type="button"
        title={listening ? 'End meeting' : 'Start listening'}
        aria-label={listening ? 'End meeting' : 'Start listening'}
        aria-pressed={listening}
        onClick={onToggleListen}
        className={[
          'no-drag focus-ring grid h-[34px] w-[34px] shrink-0 place-items-center rounded-full transition-colors',
          listening
            ? 'bg-[var(--color-danger-soft)] text-[color:var(--color-danger)]'
            : 'bg-white/[0.06] text-[color:var(--color-ink-2)] hover:bg-white/10 hover:text-[color:var(--color-ink)]'
        ].join(' ')}
      >
        {listening ? (
          <span className="rec-dot h-[11px] w-[11px] rounded-full bg-[var(--color-danger)] shadow-[0_0_8px_var(--color-danger)]" />
        ) : (
          <Mic size={16} />
        )}
      </button>
    </div>
  )
}
