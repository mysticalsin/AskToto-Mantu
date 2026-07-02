import { X, Mic, Pause, Play, Square } from 'lucide-react'
import { MantuMark } from './MantuMark'
import { ElapsedClock } from './Bar'
import { useWindowDrag } from '../lib/window-drag'

/**
 * Collapsed control mini-pill (Cluely's second window). Shown instead of the full widget when the
 * overlay is minimized: the Mantu mark expands it back, the ghost ✕ fully hides the window (a global
 * hotkey restores it), and the mic starts Listen. While recording, the pill carries the live timer +
 * pause/stop so the meeting stays controllable — and visibly alive — without expanding. Draggable
 * like the main widget.
 */
export function ControlPill({
  onExpand,
  onHide,
  onToggleListen,
  onTogglePause,
  listening,
  paused,
  startedAt
}: {
  onExpand: () => void
  onHide: () => void
  onToggleListen: () => void
  onTogglePause: () => void
  listening: boolean
  paused: boolean
  startedAt: number
}): JSX.Element {
  const drag = useWindowDrag()
  return (
    // data-hug-width: lets useAutoResize report this element's own shrink-to-fit width to the window
    // instead of the wider fixed guess — without it, the window stayed wider than the visible pill and
    // silently swallowed clicks meant for whatever app was behind that invisible margin.
    <div {...drag} data-hug-width className="aw-pill inline-flex items-center gap-2 p-1.5">
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
      {listening ? (
        <>
          <span
            className={[
              'h-[9px] w-[9px] shrink-0 rounded-full',
              paused
                ? 'bg-[color:var(--color-ink-3)]'
                : 'rec-dot bg-[var(--color-danger)] shadow-[0_0_8px_var(--color-danger)]'
            ].join(' ')}
          />
          <ElapsedClock startedAt={startedAt} paused={paused} />
          <button
            type="button"
            title={paused ? 'Resume recording' : 'Pause recording'}
            aria-label={paused ? 'Resume recording' : 'Pause recording'}
            onClick={onTogglePause}
            className="no-drag focus-ring grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full text-[color:var(--color-ink-2)] transition-colors hover:bg-white/10 hover:text-[color:var(--color-ink)]"
          >
            {paused ? <Play size={15} /> : <Pause size={15} />}
          </button>
          <button
            type="button"
            title="Stop & end meeting"
            aria-label="Stop and end meeting"
            onClick={onToggleListen}
            className="no-drag focus-ring grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full text-[color:var(--color-danger)] transition-colors hover:bg-[var(--color-danger-soft)]"
          >
            <Square size={13} fill="currentColor" />
          </button>
        </>
      ) : (
        <button
          type="button"
          title="Start listening"
          aria-label="Start listening"
          onClick={onToggleListen}
          className="no-drag focus-ring grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full bg-white/[0.06] text-[color:var(--color-ink-2)] transition-colors hover:bg-white/10 hover:text-[color:var(--color-ink)]"
        >
          <Mic size={16} />
        </button>
      )}
      <span className="h-[16px] w-px shrink-0 bg-white/10" />
      <button
        type="button"
        onClick={onHide}
        title="Hide AskToto"
        aria-label="Hide AskToto"
        className="no-drag focus-ring grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full text-[color:var(--color-ink-3)] transition-colors hover:bg-white/10 hover:text-[color:var(--color-ink)]"
      >
        <X size={14} />
      </button>
    </div>
  )
}
