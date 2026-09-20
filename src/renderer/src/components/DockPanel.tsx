import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  AudioLines,
  Brain,
  ChevronLeft,
  ChevronRight,
  CornerDownLeft,
  Eye,
  EyeOff,
  FileSearch,
  Image,
  LayoutGrid,
  Pause,
  Play,
  Square,
  X
} from 'lucide-react'
import { MantuMark } from './MantuMark'
import { ModePicker } from './ModePicker'
import { InlineOrb } from './AgentStatus'
import { ElapsedClock, answerBodyMaxHeight, type BarProps } from './Bar'
import { modeLabel } from '@shared/ipc'
import { accelLabel } from '../lib/keys'
import { BAR_MARK_SIZE_PX } from '../lib/bar-pill-orb'

/**
 * DockPanel — the Ask surface for `dock` chrome (a tall sidecar on the screen edge).
 *
 * Bar cannot be reused here and this is not a style preference: DESIGN.md makes toolbar overlap a
 * SHIP BLOCKER and pins the Bar's production width at 880 with every control an in-flow reserved box.
 * The dock window is 380 wide, so rendering Bar into it is the overlap the contract forbids — which is
 * exactly what it looked like: a horizontal bar squeezed into a vertical hole, controls colliding, the
 * answer crushed into a letterbox.
 *
 * So the dock gets a surface built for its own axis. Three zones, fixed rhythm, nothing competing for
 * horizontal space:
 *
 *   header    — identity, what Métis is doing right now, and the way out. Fixed height.
 *   body      — the answer. flex-1, the only scroller, and by far the biggest zone: a sidecar's whole
 *               advantage over the bar is vertical room, so the answer gets it.
 *   composer  — one tool row, then the ask field. Fixed height, always reachable, never scrolls away.
 *
 * It takes BarProps verbatim. That is deliberate: the type is the parity contract, so a capability
 * added to the bar cannot silently go missing here, and App swaps surfaces without new wiring.
 */

const ICON_STROKE = 1.85
/** One hit target for every tool, so the row is a grid and not a pile of differently-sized buttons. */
const TOOL_HIT_PX = 32

/** The dock's own tool button. Same instant-tooltip idiom as Bar's IconTool, sized for a 380 column. */
const Tool = memo(function Tool({
  title,
  onClick,
  active,
  danger,
  cyanIdle,
  rainbow,
  disabled,
  edgeRight,
  children
}: {
  title: string
  onClick: () => void
  active?: boolean
  danger?: boolean
  cyanIdle?: boolean
  rainbow?: boolean
  disabled?: boolean
  /** Anchors the tooltip to the right so it cannot escape the panel's narrow column. */
  edgeRight?: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={title}
        style={{ width: TOOL_HIT_PX, height: TOOL_HIT_PX }}
        className={[
          'no-drag focus-ring peer grid place-items-center rounded-[10px] transition-colors duration-[var(--duration-hover)] active:scale-[0.92]',
          rainbow ? 'rainbow-ring' : '',
          disabled ? 'cursor-not-allowed opacity-40' : '',
          danger && active ? 'text-[color:var(--color-danger)]'
            : active ? 'text-[color:var(--color-accent-2)]'
            : cyanIdle ? 'text-[color:var(--color-cyan)] hover:brightness-110'
            : 'text-[color:var(--color-ink-3)] hover:text-[color:var(--color-ink)]'
        ].join(' ')}
      >
        {children}
      </button>
      <span
        className={[
          'pointer-events-none absolute -top-1 z-20 -translate-y-full whitespace-nowrap rounded-lg bg-black/90 px-2.5 py-0.5 text-[11px] font-medium text-white opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 peer-focus-visible:opacity-100',
          edgeRight ? 'right-0' : 'left-1/2 -translate-x-1/2'
        ].join(' ')}
      >
        {title}
      </span>
    </span>
  )
})

export const DockPanel = memo(function DockPanel(props: BarProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [modeOpen, setModeOpen] = useState(false)
  // Drives the edge fade. Measured rather than assumed: masking a short answer's last line reads as a
  // rendering fault, so the mask only applies once the content genuinely overflows.
  const [overflowing, setOverflowing] = useState(false)

  useEffect(() => {
    if (props.focusSignal > 0) inputRef.current?.focus()
  }, [props.focusSignal])

  // Escape closes the mode sheet without reaching App's window-level Escape, which would collapse the
  // whole overlay — the same stopPropagation contract the Bar's popover has.
  useEffect(() => {
    if (!modeOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setModeOpen(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [modeOpen])

  const hasAnswer = props.hasAnswer ?? !!props.body
  const listening = props.listening

  // Re-measure on every body change (a streaming answer grows line by line) and on resize. ResizeObserver
  // rather than a scroll listener: overflow changes when the CONTENT changes, not when the reader moves.
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const measure = (): void => setOverflowing(el.scrollHeight > el.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    for (const child of Array.from(el.children)) ro.observe(child)
    return () => ro.disconnect()
  }, [props.body])

  // Chrome rows are memo'd ELEMENTS, not components: `body` gets a new reference up to 60x/sec while an
  // answer streams, and without this every control in the panel reconciles on each of those frames.
  const header = useMemo(
    () => (
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-hair-soft)] px-3 py-2.5">
        {hasAnswer && props.onBack ? (
          <button
            type="button"
            onClick={props.onBack}
            aria-label="Back"
            className="no-drag focus-ring grid h-7 w-7 place-items-center rounded-[9px] text-[color:var(--color-ink-3)] transition-colors hover:text-[color:var(--color-ink)]"
          >
            <ChevronLeft size={17} strokeWidth={ICON_STROKE} />
          </button>
        ) : (
          <button
            type="button"
            onClick={props.onSettings}
            aria-label="Open settings"
            className="aw-bar-mark no-drag focus-ring"
          >
            <span className="aw-bar-mark__disk aw-mark-glow">
              <MantuMark size={BAR_MARK_SIZE_PX} round />
            </span>
          </button>
        )}

        {/* The one line that says what Métis is doing. In the bar this competed with six controls for
            horizontal room; here it owns the row. */}
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[color:var(--color-ink-2)]">
          {listening ? (props.paused ? 'Paused' : 'Listening') : props.busy ? 'Thinking' : 'Métis'}
        </span>

        {props.canTogglePanel && (
          <Tool title={props.panelOpen ? 'Collapse' : 'Expand'} onClick={props.onTogglePanel} edgeRight>
            <ChevronRight
              size={17}
              strokeWidth={ICON_STROKE}
              className={props.panelOpen ? '' : 'rotate-180'}
            />
          </Tool>
        )}
      </div>
    ),
    [hasAnswer, props.onBack, props.onSettings, listening, props.paused, props.busy, props.canTogglePanel, props.panelOpen, props.onTogglePanel]
  )

  // Listening gets its own full-width strip rather than being wedged between toolbar icons. A meeting in
  // progress is the most important state this surface has; it should not have to share a row.
  const liveStrip = useMemo(
    () =>
      listening ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-hair-soft)] bg-[var(--color-danger-soft)] px-3 py-1.5">
          <span className={props.paused ? 'h-2 w-2 rounded-full bg-[var(--color-warn)]' : 'rec-dot'} />
          <span className="flex-1 text-[12px] font-semibold tabular-nums text-[color:var(--color-ink)]">
            <ElapsedClock startedAt={props.startedAt} paused={props.paused} />
          </span>
          {props.captureDegraded && (
            <span className="rounded-full bg-[var(--color-warn)]/15 px-2 py-0.5 text-[10px] font-semibold text-[color:var(--color-warn)]">
              {props.captureDegraded.side === 'them' ? 'Mic only' : 'No mic'}
            </span>
          )}
          <Tool title={props.paused ? 'Resume' : 'Pause'} onClick={props.onTogglePause}>
            {props.paused ? <Play size={16} strokeWidth={ICON_STROKE} /> : <Pause size={16} strokeWidth={ICON_STROKE} />}
          </Tool>
          <Tool title="Stop meeting" onClick={props.onToggleListen} danger active edgeRight>
            <Square size={15} strokeWidth={ICON_STROKE} />
          </Tool>
        </div>
      ) : null,
    [listening, props.paused, props.startedAt, props.captureDegraded, props.onTogglePause, props.onToggleListen]
  )

  const tools = useMemo(
    () => (
      <div className="flex shrink-0 items-center gap-1 px-2 pt-2">
        <Tool title={`Capture screen (${props.captureAccel})`} onClick={props.onCapture} active={props.capturing}>
          {props.capturing ? <InlineOrb kind="working" /> : <Image size={18} strokeWidth={ICON_STROKE} />}
        </Tool>
        {props.onSpotlightRef && (
          <Tool title="Spotlight reference" onClick={props.onSpotlightRef} active={props.spotlightReady}>
            <FileSearch size={18} strokeWidth={ICON_STROKE} />
          </Tool>
        )}
        <Tool title={`Mode: ${modeLabel(props.mode, props.customModes)}`} onClick={() => setModeOpen((v) => !v)} active={modeOpen}>
          <LayoutGrid size={18} strokeWidth={ICON_STROKE} />
        </Tool>
        {props.onToggleThinking && (
          <Tool title="Deep thinking" onClick={props.onToggleThinking} active={props.thinkingOn} rainbow={props.thinkingOn}>
            <Brain size={18} strokeWidth={ICON_STROKE} />
          </Tool>
        )}
        <Tool
          title={props.stealth ? 'Hidden from screen share' : 'Visible in screen share'}
          onClick={props.onToggleStealth}
          disabled={props.stealthLocked}
          danger
          active={props.stealth}
        >
          {props.stealth ? <EyeOff size={18} strokeWidth={ICON_STROKE} /> : <Eye size={18} strokeWidth={ICON_STROKE} />}
        </Tool>

        <span className="mx-0.5 h-5 w-px bg-[var(--color-hair-soft)]" />

        {!listening && (
          <Tool title="Start meeting" onClick={props.onToggleListen} cyanIdle>
            <AudioLines size={18} strokeWidth={ICON_STROKE} />
          </Tool>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={props.onHistory}
          className="no-drag focus-ring rounded-full bg-white/[0.05] px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-ink-2)] transition-colors duration-[var(--duration-hover)] hover:bg-white/[0.1] hover:text-[color:var(--color-ink)]"
        >
          {props.onTranscript && listening ? 'Transcript' : 'History'}
        </button>
      </div>
    ),
    [
      props.captureAccel, props.onCapture, props.capturing, props.onSpotlightRef, props.spotlightReady,
      props.mode, props.customModes, modeOpen, props.onToggleThinking, props.thinkingOn, props.stealth,
      props.onToggleStealth, props.stealthLocked, listening, props.onToggleListen, props.onHistory,
      props.onTranscript
    ]
  )

  const composer = useMemo(
    () => (
      <div className="flex shrink-0 items-end gap-2 px-3 pb-3 pt-2">
        <input
          ref={inputRef}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              props.onSubmit()
            }
          }}
          spellCheck={false}
          aria-label="Ask Métis anything"
          placeholder={listening ? 'Ask about this meeting' : hasAnswer ? 'Ask a follow-up' : 'Ask Métis anything'}
          className="no-drag focus-ring font-body min-w-0 flex-1 rounded-[10px] border border-[var(--color-hair-soft)] bg-black/20 px-3 py-2 text-[14px] font-[450] tracking-[-0.01em] text-[color:var(--color-ink)] caret-[var(--color-accent-2)] placeholder:text-[color:var(--color-ink-3)]"
        />
        <button
          type="button"
          onClick={props.busy ? props.onStop : props.onSubmit}
          aria-label={props.busy ? 'Stop' : 'Ask'}
          title={props.busy ? 'Stop' : `Ask (${accelLabel('Return')})`}
          className={[
            'no-drag focus-ring grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[10px] transition-colors duration-[var(--duration-hover)]',
            props.busy
              ? 'border border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)] text-[color:var(--color-danger)]'
              : 'aw-fill text-white'
          ].join(' ')}
        >
          {props.busy ? <X size={17} strokeWidth={ICON_STROKE} /> : <CornerDownLeft size={17} strokeWidth={ICON_STROKE} />}
        </button>
      </div>
    ),
    [props.value, props.onChange, props.onSubmit, props.onStop, props.busy, listening, hasAnswer]
  )

  return (
    <div className="dock-panel aw-widget flex h-full min-h-0 w-full flex-col">
      {header}
      {liveStrip}

      {/* The only scroller. min-h-0 is load-bearing: without it a long answer pushes the composer off
          the bottom of a fixed-height window instead of scrolling inside this zone. */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={bodyRef}
          data-overflowing={overflowing ? '1' : '0'}
          className="dock-panel__scroll aw-body scroll-thin h-full overflow-y-auto px-3 py-2.5"
          style={{ maxHeight: answerBodyMaxHeight() }}
        >
          {props.body ?? (
            <p className="m-0 px-1 pt-1 text-[12px] leading-relaxed text-[color:var(--color-ink-3)]">
              {listening
                ? 'Listening. Ask anything about this meeting and the answer lands here.'
                : 'Ask a question, capture the screen, or start a meeting. Answers open in this panel.'}
            </p>
          )}
        </div>

        {/* Mode opens INSIDE the panel, not as an absolutely-positioned popover: the dock window is a
            fixed size owned by main, so a popover escaping the surface would simply be clipped. */}
        {modeOpen && (
          <div className="absolute inset-0 z-20 flex flex-col bg-[var(--glass-fill-strong)] backdrop-blur-sm">
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">Mode</span>
              <Tool title="Close" onClick={() => setModeOpen(false)} edgeRight>
                <X size={16} strokeWidth={ICON_STROKE} />
              </Tool>
            </div>
            <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              <ModePicker
                mode={props.mode}
                onChange={(m) => {
                  props.onSetMode(m as BarProps['mode'])
                  setModeOpen(false)
                }}
                customModes={props.customModes}
                size="sm"
              />
            </div>
          </div>
        )}
      </div>

      {tools}
      {composer}
    </div>
  )
})
