import { useEffect, useLayoutEffect, useMemo, useRef, useState, memo, type ReactNode } from 'react'
import {
  Image,
  CornerDownLeft,
  X,
  Eye,
  EyeOff,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  AudioLines,
  LayoutGrid,
  Minimize2,
  FileText,
  Pause,
  Play,
  Square,
  Plus,
  Brain,
  FileSearch
} from 'lucide-react'
import { MantuMark } from './MantuMark'
import { ModePicker } from './ModePicker'
import { Spinner } from './ui'
import { modeLabel } from '@shared/ipc'
import type { ConversationMode, CustomMode } from '@shared/ipc'
import { formatScreenFreshness } from '@shared/perception'
import { accelLabel } from '../lib/keys'

/** Single source of truth for toolbar icon stroke — prevents per-icon drift. */
const ICON_STROKE = 1.85

function clock(s: number): string {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${r.toString().padStart(2, '0')}`
  return `${m}:${r.toString().padStart(2, '0')}`
}

/** Owns its own 1 Hz tick — previously `seconds` lived in App's top-level state and ticked the WHOLE App
 *  tree (including Bar's full ~500-line JSX and whichever body was mounted) once a second for the entire
 *  meeting. Isolating the interval here means the tick only ever re-renders this one <span>. Derives
 *  elapsed time from `startedAt` (a wall-clock timestamp) rather than counting up itself, so it can never
 *  drift from the real meeting duration even if a render is skipped/delayed.
 *
 *  Pause must exclude dead air from the displayed time (the old counter simply stopped incrementing while
 *  paused) — tracked here as accumulated pausedMs, subtracted from the raw wall-clock delta so a long pause
 *  doesn't make the clock jump forward on resume. */
export const ElapsedClock = memo(function ElapsedClock({
  startedAt,
  paused
}: {
  startedAt: number
  paused: boolean
}): JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  const pausedMsRef = useRef(0) // total time already spent paused this meeting
  const pausedAtRef = useRef<number | null>(null) // wall-clock moment the current pause began
  useEffect(() => {
    if (paused) {
      pausedAtRef.current = Date.now()
      return
    }
    if (pausedAtRef.current != null) {
      pausedMsRef.current += Date.now() - pausedAtRef.current
      pausedAtRef.current = null
      setNow(Date.now())
    }
    const iv = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [paused])
  // startedAt changing means a NEW meeting — reset the accumulated pause bookkeeping so it doesn't leak
  // across sessions (a ref, so this can't just be a useState initializer keyed on mount).
  const startedAtRef = useRef(startedAt)
  if (startedAtRef.current !== startedAt) {
    startedAtRef.current = startedAt
    pausedMsRef.current = 0
    pausedAtRef.current = null
  }
  const seconds = Math.max(0, Math.floor((now - startedAt - pausedMsRef.current) / 1000))
  return (
    <span
      className={[
        'tabular-nums text-[12px] font-medium',
        paused ? 'text-[color:var(--color-ink-3)]' : 'text-[color:var(--color-danger)]'
      ].join(' ')}
    >
      {clock(seconds)}
    </span>
  )
})

/** Screen-capture freshness chip ("Seen 0.3s ago") — owns its own 500ms tick, same pattern as
 *  ElapsedClock above. Previously this ticked via App-level state (setInterval + setState in App.tsx),
 *  which re-rendered the ENTIRE App tree (including Bar's ~500-line JSX and whichever body was mounted)
 *  every half second for as long as a screen-grounded answer was showing. Isolating the tick here means
 *  it only ever re-renders this one chip. Renders nothing when capturedAt is null/undefined (no
 *  screen-grounded answer active right now). */
const ScreenFreshnessChip = memo(function ScreenFreshnessChip({
  capturedAt
}: {
  capturedAt?: number | null
}): JSX.Element | null {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (capturedAt == null) return
    const iv = setInterval(() => setTick((t) => t + 1), 500)
    return () => clearInterval(iv)
  }, [capturedAt])
  if (capturedAt == null) return null
  return (
    <span className="flex flex-none items-center gap-1 rounded-full bg-white/[0.05] px-2 py-0.5 text-[11px] text-[color:var(--color-ink-2)]">
      <span className="h-[6px] w-[6px] rounded-full bg-[var(--color-accent)]" />
      <Eye size={11} strokeWidth={ICON_STROKE} />
      {formatScreenFreshness(capturedAt)}
    </span>
  )
})

export interface BarProps {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  onStop: () => void
  busy: boolean
  listening: boolean
  onToggleListen: () => void
  /** True while a listening session is suspended mid-meeting (audio capture paused, nothing torn down). */
  paused: boolean
  /** Pause suspends capture without ending the meeting; Stop (onToggleListen) ends it. Distinct actions. */
  onTogglePause: () => void
  onCapture: () => void
  capturing: boolean
  onSettings: () => void
  onHistory: () => void
  /** Collapse the widget down to the floating control mini-pill. */
  onMinimize: () => void
  /** When true, the AskToto window is hidden from screen capture & sharing (contentProtection). The
   *  eye button toggles this. Separate from Private View (whether AskToto captures the user's screen). */
  stealth: boolean
  onToggleStealth: () => void
  /** Wall-clock start time of the current meeting (Date.now() at startListen) — ElapsedClock derives the
   *  ticking display from this instead of App owning a 1 Hz `seconds` counter. Ignored while !listening. */
  startedAt: number
  panelOpen: boolean
  onTogglePanel: () => void
  /** False when there's no answer/history/settings content behind the bar for the chevron to reveal —
   *  disables it instead of leaving a click that visibly does nothing. */
  canTogglePanel: boolean
  focusSignal: number
  /** Active conversation mode. The grid icon opens an in-bar popover (ModePicker) to switch directly. */
  mode: ConversationMode
  onSetMode: (m: ConversationMode) => void
  /** The answer/copilot body. When present the bar EXPANDS into one surface: big input on top, this body
   *  in the middle, and the toolbar drops to the bottom — no separate panel underneath. */
  body?: ReactNode
  /** An answer/suggestion is open (drives back-arrow, header separator, follow-up placeholder). */
  hasAnswer?: boolean
  /** When set, a ← button appears at the far left of the input row when an answer is open. */
  onBack?: () => void
  /** When set (non-null), renders the screen-freshness chip (purple dot + Eye + "Seen Ns ago") near the
   *  input — the raw capture timestamp; ScreenFreshnessChip owns formatting + its own 500ms tick. */
  screenCapturedAt?: number | null
  /** Needed to resolve a custom mode id to its display label. */
  customModes?: CustomMode[]
  /** When listening, the right column shows a "Transcript" button calling this instead of "History". */
  onTranscript?: () => void
  /** Whether the live transcript panel is currently shown, so the button label reads Hide vs Show. */
  transcriptShown?: boolean
  /** Start a fresh meeting from the bar (ends + saves the current one, then begins a new session). */
  onNewMeeting?: () => void
  /** When true, calling prewarmCapture() on input focus is permitted (pass visionReady && screenAsk). */
  canPrewarm?: boolean
  /** Deep-thinking toggle (settings.thinkingMode === 'always') — forces every answer to the deepest model. */
  thinkingOn?: boolean
  onToggleThinking?: () => void
  /** Spotlight Ref — checks a dedicated Dust agent for sales references on the current use case. */
  onSpotlightRef?: () => void
  /** True only when the Spotlight Ref Dust agent is configured — gates the toolbar icon so non-Dust
   *  users don't hit a guaranteed dead-end. */
  spotlightReady?: boolean
}

/** A centered toolbar icon: muted by default, accent-2 when active, danger when flagged.
 *  rainbow: wraps the button in the same spinning conic-gradient ring used for the busy/stealth states —
 *  for a toggle whose "on" state should read as unmistakably distinct (e.g. Deep thinking).
 *  Tooltip is a custom instant label (Cluely-style — appears immediately on hover, no OS delay) rather
 *  than the native `title` attribute; `aria-label` keeps it accessible to screen readers. */
function IconTool({
  title,
  onClick,
  active,
  danger,
  rainbow,
  cyanIdle,
  ariaHasPopup,
  ariaExpanded,
  edgeRight,
  edgeLeft,
  children
}: {
  title: string
  onClick: () => void
  active?: boolean
  danger?: boolean
  rainbow?: boolean
  // Idle (not-yet-active) color is cyan instead of the shared muted tone — used for the Listen button
  // so "start recording" reads as a distinct, inviting action rather than a neutral toggle.
  cyanIdle?: boolean
  // Set on tools that open a popover/menu (e.g. Mode), so screen readers announce the disclosure state.
  ariaHasPopup?: boolean
  ariaExpanded?: boolean
  // Set on tools that sit close to the widget's right edge, so the tooltip anchors from its right side
  // instead of centering off the trigger (which would otherwise get clipped by the widget's overflow:hidden).
  edgeRight?: boolean
  // Set on tools that sit close to the widget's left edge (e.g. Mode, whose label is user-authored and
  // can run long), so the tooltip anchors from its left side and grows rightward instead of centering
  // off the trigger and getting clipped by the widget's overflow:hidden on the opposite side.
  edgeLeft?: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <div className="group relative inline-flex">
      <button
        type="button"
        aria-label={title}
        aria-haspopup={ariaHasPopup ? 'menu' : undefined}
        aria-expanded={ariaExpanded}
        onClick={onClick}
        className={[
          'no-drag focus-ring peer grid place-items-center rounded-[10px] p-1 transition-colors duration-[var(--duration-hover)] active:scale-[0.92]',
          rainbow ? 'rainbow-ring' : '',
          danger && active
            ? 'text-[color:var(--color-danger)]'
            : active
              ? 'text-[color:var(--color-accent-2)]'
              : cyanIdle
                ? 'text-[color:var(--color-cyan)] hover:brightness-110'
                : 'text-[color:var(--color-ink-3)] hover:text-[color:var(--color-ink)]'
        ].join(' ')}
      >
        {children}
      </button>
      {/* Toolbar row sits directly under the input row with only a hairline border between them (no
          reserved gap) — a negative offset large enough to clear the input row's placeholder text would
          push the tooltip above the widget's own top edge, where the window (hugged tight to content)
          would hard-clip it. Anchoring just below the icon's own top instead keeps the tooltip fully
          on-screen and clear of "Ask anything…" above, at the cost of a couple of px tucked over the
          icon's own padding — invisible in practice since the cursor is already on the icon on hover. */}
      <span
        className={[
          'pointer-events-none absolute top-1.5 z-20 -translate-y-full whitespace-nowrap rounded-lg bg-black/90 px-2.5 py-0.5 text-[11px] font-medium text-white opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 peer-focus-visible:opacity-100',
          edgeRight ? 'right-0' : edgeLeft ? 'left-0' : 'left-1/2 -translate-x-1/2'
        ].join(' ')}
      >
        {title}
      </span>
    </div>
  )
}

export const Bar = memo(function Bar(props: BarProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (props.focusSignal > 0) inputRef.current?.focus()
  }, [props.focusSignal])

  // Mode popover (Cluely-style: click the grid icon, pick a mode right there — no Settings redirect).
  // Two refs because the popover itself renders as a SIBLING of the icon (see below — escaping
  // .aw-widget's overflow:hidden) — outside-click must not close it while a click lands in either.
  const [modeOpen, setModeOpen] = useState(false)
  const modeRef = useRef<HTMLDivElement>(null)
  const modePopoverRef = useRef<HTMLDivElement>(null)
  // The outer wrapper is the popover's actual positioned ancestor (it renders as a sibling of
  // .aw-widget, not inside it) — modeAnchorLeft is computed against this, not the viewport.
  const wrapRef = useRef<HTMLDivElement>(null)
  // Horizontal anchor (px from wrapRef's left edge) for the popover below, measured off modeRef's real
  // position so it originates from the icon that opens it instead of centering under the whole bar.
  const [modeAnchorLeft, setModeAnchorLeft] = useState<number | null>(null)
  useEffect(() => {
    if (!modeOpen) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (modeRef.current?.contains(t)) return
      if (modePopoverRef.current?.contains(t)) return
      setModeOpen(false)
      modeRef.current?.querySelector('button')?.focus()
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // Stop this Escape from reaching App.tsx's window-level handler, which would otherwise also
        // collapse/hide the overlay on top of closing this popover.
        e.stopPropagation()
        setModeOpen(false)
        modeRef.current?.querySelector('button')?.focus()
        return
      }
      // Trap Tab within the open popover (WCAG 2.4.3): a keyboard-only user tabbing off the last item
      // would otherwise land on the page behind the menu. Wrap first↔last while it's open.
      if (e.key === 'Tab') {
        const pop = modePopoverRef.current
        if (!pop) return
        const focusables = Array.from(
          pop.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
          )
        )
        if (!focusables.length) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        const active = document.activeElement as HTMLElement | null
        if (e.shiftKey) {
          if (active === first || !pop.contains(active)) {
            e.preventDefault()
            last.focus()
          }
        } else if (active === last || !pop.contains(active)) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [modeOpen])

  // Move focus into the popover the moment it opens, so Tab order and screen-reader focus start
  // inside the menu instead of staying stranded on the trigger.
  useEffect(() => {
    if (!modeOpen) return
    modePopoverRef.current?.querySelector('button')?.focus()
  }, [modeOpen])

  // Anchor the popover horizontally to the Mode icon's real position rather than the bar's center —
  // useLayoutEffect so this lands before paint (no visible snap from a fallback center position).
  // Clamped against the popover's own measured width so a long custom-mode list can never push it past
  // the bar's edges even though modeRef itself sits well left of center.
  useLayoutEffect(() => {
    if (!modeOpen) return
    const place = (): void => {
      const iconRect = modeRef.current?.getBoundingClientRect()
      const wrapRect = wrapRef.current?.getBoundingClientRect()
      if (!iconRect || !wrapRect) return
      const iconCenter = iconRect.left + iconRect.width / 2 - wrapRect.left
      const half = (modePopoverRef.current?.offsetWidth ?? 0) / 2
      const margin = 8
      setModeAnchorLeft(Math.min(Math.max(iconCenter, half + margin), wrapRect.width - half - margin))
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [modeOpen])

  // When a body is present the bar EXPANDS into one surface (big input → body → toolbar at the bottom).
  const expanded = !!props.body
  const hasAnswer = props.hasAnswer ?? expanded

  // Row 1 and the toolbar row are memoized ELEMENTS: `body` gets a fresh reference on every RAF-batched
  // stream flush (up to 60/sec while an answer streams), which defeats Bar's outer memo — without these,
  // every flush rebuilt and reconciled ~50 chrome elements (9 IconTools, input, pills) whose state never
  // changes mid-stream. Stable element identity here makes React bail out of both subtrees, so a flush
  // only reconciles the body slot. Same isolation philosophy as ScreenFreshnessChip/ElapsedClock above.
  const inputRow = useMemo(
    () => (
        <div
          className={[
            'flex items-center gap-3 px-5 transition-[padding,font-size] duration-[var(--duration-panel)] ease-[var(--ease-spring)]',
            expanded ? 'border-b border-[var(--color-hair-soft)]' : ''
          ].join(' ')}
          style={{ paddingTop: expanded ? 11 : 5, paddingBottom: expanded ? 11 : 5 }}
        >
          {/* Back arrow — far left of the input row when an answer is open and onBack is provided */}
          {hasAnswer && props.onBack && (
            <button
              type="button"
              title="Back"
              aria-label="Back"
              onClick={props.onBack}
              className="no-drag focus-ring flex-none grid place-items-center rounded-[10px] p-1 text-[color:var(--color-ink-3)] transition-colors duration-[var(--duration-hover)] hover:text-[color:var(--color-ink)]"
            >
              <ChevronLeft size={18} strokeWidth={ICON_STROKE} />
            </button>
          )}

          {/* Screen-freshness chip (e.g. 'Seen 0.3s ago') — real screen-capture age; ticks itself every
              500ms (see ScreenFreshnessChip above) so it never reads stale. */}
          <ScreenFreshnessChip capturedAt={props.screenCapturedAt} />

          {/* "Heard live" chip — sibling of the screen-freshness chip above (same pill styling), driven
              directly by the real listening state (props.listening, sourced from useListen()'s live audio
              pipeline) rather than a separate signal. Kept as its own chip instead of merged into
              contextLabel because the two facts are independent: a screen can be stale while audio is
              live, or vice versa — a single chip could only ever show one of them at a time. */}
          {props.listening && (
            <span className="flex flex-none items-center gap-1 rounded-full bg-white/[0.05] px-2 py-0.5 text-[11px] text-[color:var(--color-ink-2)]">
              {props.paused ? (
                <>
                  <Pause size={11} strokeWidth={ICON_STROKE} className="text-[color:var(--color-warn,#fac775)]" />
                  Paused
                </>
              ) : (
                <>
                  <span className="h-[6px] w-[6px] rounded-full bg-[var(--color-danger)]" />
                  <AudioLines size={11} strokeWidth={ICON_STROKE} />
                  Heard live
                </>
              )}
            </span>
          )}

          <input
            ref={inputRef}
            value={props.value}
            onChange={(e) => props.onChange(e.target.value)}
            onFocus={() => { if (props.canPrewarm) void window.toto.prewarmCapture() }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                props.onSubmit()
              }
            }}
            placeholder={
              // State-driven (Cluely-style): a live meeting reframes it around the conversation; after an
              // answer it invites a follow-up; idle it points at the screen.
              props.listening
                ? hasAnswer
                  ? 'Ask a follow-up about the meeting…'
                  : 'Ask anything about the meeting'
                : hasAnswer
                  ? 'Ask a follow-up…'
                  : 'Ask anything about your screen'
            }
            spellCheck={false}
            aria-label="Ask AskToto anything"
            className={[
              // Brighter tier + a drop-shadow on the placeholder (same fix already applied to the
              // QuickActions hint) — "Ask anything…" pops clearly over any desktop, light or dark.
              'no-drag focus-ring font-body min-w-0 flex-1 bg-transparent tracking-[-0.01em] text-[color:var(--color-ink)] placeholder:text-[color:var(--color-ink-2)] placeholder:[text-shadow:0_1px_3px_rgba(0,0,0,0.65)] caret-[var(--color-accent-2)] transition-[font-size] duration-[var(--duration-panel)] ease-[var(--ease-spring)]',
              expanded ? 'text-[18px] font-[450]' : 'text-[15px] font-[450]'
            ].join(' ')}
          />

          {props.busy ? (
            <button
              type="button"
              title={props.listening ? 'Stop & end meeting' : 'Stop'}
              aria-label={props.listening ? 'Stop and end meeting' : 'Stop'}
              // While a meeting is live this is the big, obvious control in the bar — it must end the
              // meeting (same path as the toolbar's rec-dot / Square Stop), not just cancel whatever
              // answer happens to be streaming. Cancelling-only here silently ate the click: the stream
              // stopped, the button reverted to "Ask", and the meeting kept running with no summary.
              // Outside a meeting this button has no "end" concept, so it keeps the plain stream-cancel.
              onClick={props.listening ? props.onToggleListen : props.onStop}
              className="no-drag focus-ring grid h-[38px] w-[46px] place-items-center rounded-[10px] border border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)] text-[color:var(--color-danger)] hover:bg-[var(--color-danger)]/20"
            >
              <X size={18} />
            </button>
          ) : (
            // Hero submit — accent-filled, ~38px. The only aw-fill control in the bar row.
            <button
              type="button"
              title={`Ask (${accelLabel('Return')})`}
              aria-label="Ask"
              onClick={props.onSubmit}
              className="aw-fill no-drag focus-ring flex-none grid h-[38px] w-[46px] place-items-center rounded-[10px] text-white transition-colors duration-[var(--duration-hover)]"
            >
              <CornerDownLeft size={15} strokeWidth={ICON_STROKE} />
            </button>
          )}
        </div>
    ),
    [expanded, hasAnswer, props.onBack, props.screenCapturedAt, props.listening, props.paused, props.value, props.onChange, props.canPrewarm, props.onSubmit, props.busy, props.onToggleListen, props.onStop]
  )

  const toolbarRow = useMemo(
    () => (
        <div className="aw-toolbar grid grid-cols-[1fr_auto_1fr] items-center border-t border-[var(--color-hair-soft)] px-5 py-1">
          {/* The Mantu mark IS the logo → opens Settings. (Quit/Hide live in the tray + hotkeys.) */}
          <button
            type="button"
            title="Settings"
            aria-label="Settings"
            onClick={props.onSettings}
            className="no-drag focus-ring block flex-none justify-self-start rounded-[10px]"
          >
            <span className="aw-mark-glow block rounded-[10px]">
              <MantuMark size={30} />
            </span>
          </button>

          {/* Centered tools — the grid's auto middle track. While listening, the timer/pause/stop slot on
              the right is mirrored by an equal-width spacer on the left, so the icons stay put when a
              meeting starts AND the group's midpoint stays on the window's centerline (a one-sided slot
              dragged the whole cluster ~58px left of center). Idle, neither side renders. */}
          <div className="flex min-w-0 items-center justify-center gap-4">
            {props.listening && <span aria-hidden className="w-[100px] flex-none" />}
            <IconTool title={`Capture screen (${accelLabel('CommandOrControl+Shift+S')})`} onClick={props.onCapture}>
              {props.capturing ? <Spinner size={19} /> : <Image size={19} strokeWidth={ICON_STROKE} />}
            </IconTool>
            {/* Spotlight Ref — asks a dedicated Dust agent whether Mantu has relevant sales references
                for the use case currently being discussed. Answer renders in the normal Answer panel.
                Only shown when its Dust agent is actually configured — otherwise it's a guaranteed
                dead-end (opaque error on click) for every non-Dust user. */}
            {props.spotlightReady && (
              <IconTool title="Spotlight Ref" onClick={() => props.onSpotlightRef?.()}>
                <FileSearch size={19} strokeWidth={ICON_STROKE} />
              </IconTool>
            )}
            {/* Mode — click opens a popover (ModePicker) to switch directly, Cluely-style. The popover
                itself renders OUTSIDE .aw-widget (see below `.aw-widget`'s closing tag) because this
                widget has overflow:hidden for its rounded-corner blur backdrop, which would otherwise
                clip the popover. The tooltip shows the CURRENT mode name (e.g. "General"), matching
                Cluely's own hover behavior, rather than a generic description. */}
            <div ref={modeRef}>
              <IconTool
                title={modeLabel(props.mode, props.customModes)}
                onClick={() => setModeOpen((o) => !o)}
                active={modeOpen}
                ariaHasPopup
                ariaExpanded={modeOpen}
                edgeLeft
              >
                <LayoutGrid size={19} strokeWidth={ICON_STROKE} />
              </IconTool>
            </div>
            {/* Deep thinking — forces every answer to the strongest model (settings.thinkingMode 'always').
                The spinning rainbow ring makes the "on" state unmistakable at a glance. */}
            <IconTool
              title={props.thinkingOn ? 'Deep thinking on' : 'Deep thinking off'}
              onClick={() => props.onToggleThinking?.()}
              active={props.thinkingOn}
              rainbow={props.thinkingOn}
            >
              <Brain size={19} strokeWidth={ICON_STROKE} />
            </IconTool>
            {/* Window visibility on a shared/recorded screen (contentProtection). Hidden by default —
                the invisible-copilot identity — so EyeOff (hidden) is the muted resting state. Eye
                (visible) is the exceptional, attention-worthy state where others CAN see the overlay, so
                it lights with danger as an at-a-glance "you're exposed" cue. Separate from Private View
                (whether AskToto captures YOUR screen), which lives in Settings → Privacy. */}
            <IconTool
              title={props.stealth ? 'Hidden on shared screens — click to make visible' : 'Visible on shared screens — click to hide'}
              onClick={props.onToggleStealth}
              active={!props.stealth}
              danger
            >
              {props.stealth ? <EyeOff size={19} strokeWidth={ICON_STROKE} /> : <Eye size={19} strokeWidth={ICON_STROKE} />}
            </IconTool>
            <span className="h-5 w-px bg-[var(--color-hair-soft)]" />
            <IconTool
              title={props.listening ? 'End meeting & get summary' : 'Start listening'}
              onClick={props.onToggleListen}
              active={props.listening}
              danger
              cyanIdle
            >
              {props.listening ? (
                <span
                  className={[
                    'h-[12px] w-[12px] rounded-full rec-dot',
                    props.paused
                      ? 'bg-[color:var(--color-ink-3)] [animation-play-state:paused]'
                      : 'bg-[var(--color-danger)] shadow-[0_0_8px_var(--color-danger)]'
                  ].join(' ')}
                />
              ) : (
                <AudioLines size={19} strokeWidth={ICON_STROKE} />
              )}
            </IconTool>
            {/* Timer + pause + stop — rendered only while listening, mirrored by the spacer at the
                cluster's other end so the icons between them never move. */}
            {props.listening && (
              <div className="flex w-[100px] flex-none items-center gap-2">
                  <ElapsedClock startedAt={props.startedAt} paused={props.paused} />
                  {/* Pause suspends capture (mic + system audio stay warm, nothing is finalized/saved) —
                      distinct from Stop (the danger dot above), which ends the meeting and saves it. */}
                  <button
                    type="button"
                    title={props.paused ? 'Resume recording' : 'Pause recording'}
                    aria-label={props.paused ? 'Resume recording' : 'Pause recording'}
                    onClick={props.onTogglePause}
                    className="no-drag focus-ring grid place-items-center rounded-[10px] p-1 text-[color:var(--color-ink-3)] transition-colors duration-[var(--duration-hover)] hover:text-[color:var(--color-ink)]"
                  >
                    {props.paused ? (
                      <Play size={16} strokeWidth={ICON_STROKE} />
                    ) : (
                      <Pause size={16} strokeWidth={ICON_STROKE} />
                    )}
                  </button>
                  {/* Stop — ends the meeting (recap + save), identical to the rec-dot above; an explicit
                      square makes "end" discoverable next to Pause instead of hiding behind the dot. */}
                  <button
                    type="button"
                    title="Stop & end meeting"
                    aria-label="Stop and end meeting"
                    onClick={props.onToggleListen}
                    className="no-drag focus-ring grid place-items-center rounded-[10px] p-1 text-[color:var(--color-danger)] transition-colors duration-[var(--duration-hover)] hover:brightness-125"
                  >
                    <Square size={14} strokeWidth={ICON_STROKE} fill="currentColor" />
                  </button>
              </div>
            )}
          </div>

          {/* Right: History/Transcript pill(s) + Minimize-to-pill + collapse-chevron (ghost).
              No separate Hide button — global ⌘\ and tray handle that. */}
          <div className="flex flex-none items-center justify-self-end gap-1.5">
            {/* Live pivot: New meeting + Transcript when listening, History otherwise */}
            {props.listening ? (
              <>
                <button
                  type="button"
                  title="Save this meeting and start a fresh one"
                  onClick={props.onNewMeeting}
                  className="no-drag focus-ring flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-[var(--color-accent-soft)] px-3 py-1.5 text-[13px] font-semibold leading-none text-[color:var(--color-accent)] ring-1 ring-inset ring-[var(--color-accent)]/30 transition-colors duration-[var(--duration-hover)] hover:bg-[var(--color-accent)]/25 hover:ring-[var(--color-accent)]/50"
                >
                  <Plus size={14} strokeWidth={2.5} />
                  New meeting
                </button>
                <button
                  type="button"
                  title={props.transcriptShown ? 'Hide the live transcript' : 'Show the live transcript'}
                  onClick={props.onTranscript}
                  className="no-drag focus-ring mr-0.5 flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-white/[0.05] px-2.5 py-1.5 text-[13px] font-semibold leading-none text-[color:var(--color-ink-2)] transition-colors duration-[var(--duration-hover)] hover:bg-white/[0.1] hover:text-[color:var(--color-ink)]"
                >
                  <FileText size={13} strokeWidth={ICON_STROKE} />
                  Transcript
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={props.onHistory}
                className="no-drag focus-ring mr-0.5 flex items-center gap-1.5 rounded-full bg-white/[0.05] px-3 py-1.5 text-[13px] font-semibold text-[color:var(--color-ink-2)] transition-colors duration-[var(--duration-hover)] hover:bg-white/[0.1] hover:text-[color:var(--color-ink)]"
              >
                History
                <ChevronDown size={13} strokeWidth={ICON_STROKE} />
              </button>
            )}
            <IconTool title="Minimize to a small pill" onClick={props.onMinimize} edgeRight>
              <Minimize2 size={17} strokeWidth={ICON_STROKE} />
            </IconTool>
            {/* Collapse-chevron: plain ghost, not aw-fill. Submit is the only accent-filled control.
                Disabled (not hidden, so the toolbar doesn't jump) when there's nothing behind the bar
                for it to reveal — e.g. idle with no answer/history/settings open. */}
            <button
              type="button"
              title={!props.canTogglePanel ? 'Nothing to expand yet' : props.panelOpen ? 'Collapse' : 'Expand'}
              aria-label={props.panelOpen ? 'Collapse' : 'Expand'}
              aria-disabled={!props.canTogglePanel}
              disabled={!props.canTogglePanel}
              onClick={props.onTogglePanel}
              className={[
                'no-drag focus-ring grid h-[32px] w-[36px] place-items-center rounded-[10px] text-[color:var(--color-ink-3)] transition-colors duration-[var(--duration-hover)]',
                props.canTogglePanel ? 'hover:text-[color:var(--color-ink)]' : 'cursor-not-allowed opacity-40'
              ].join(' ')}
            >
              {props.panelOpen ? <ChevronUp size={16} strokeWidth={ICON_STROKE} /> : <ChevronDown size={16} strokeWidth={ICON_STROKE} />}
            </button>
          </div>
        </div>
    ),
    [props.onSettings, props.listening, props.onCapture, props.capturing, props.spotlightReady, props.onSpotlightRef, props.mode, props.customModes, modeOpen, props.thinkingOn, props.onToggleThinking, props.stealth, props.onToggleStealth, props.onToggleListen, props.paused, props.startedAt, props.onTogglePause, props.onNewMeeting, props.transcriptShown, props.onTranscript, props.onHistory, props.onMinimize, props.canTogglePanel, props.panelOpen, props.onTogglePanel]
  )

  return (
    // The flex-col lets additional in-flow elements grow the window as needed.
    <div ref={wrapRef} className="relative flex w-full flex-col items-stretch gap-1.5">
      <div
        className={[
          'aw-widget w-full',
          // Working → fast rainbow ring; Private view on → calm slow rainbow contour as the indicator.
          props.busy ? 'rainbow-ring' : props.stealth ? 'aw-hidden-rainbow' : ''
        ].join(' ')}
      >
        {/* Row 1 — hero input + ↵ submit (memoized element above). */}
        {inputRow}

        {/* Body — CSS grid-rows 0fr→1fr animates height; opacity fades in sync. Always rendered so
            the transition runs on mount rather than snapping on conditional mount/unmount. */}
        <div
          className="grid overflow-hidden transition-[grid-template-rows,opacity] duration-[var(--duration-panel)] ease-[var(--ease-spring)]"
          style={{
            gridTemplateRows: props.body ? '1fr' : '0fr',
            opacity: props.body ? 1 : 0
          }}
        >
          <div className="min-h-0">
            <div className="aw-body scroll-thin max-h-[76vh] overflow-y-auto px-5 py-3">
              {props.body}
            </div>
          </div>
        </div>

        {/* Row 2 — toolbar (memoized element above, same rationale as Row 1). */}
        {toolbarRow}
      </div>

      {/* Mode popover — deliberately a SIBLING of .aw-widget (not nested inside it), because .aw-widget
          has overflow:hidden for its rounded-corner blur backdrop, which would otherwise clip this.
          Anchored to modeAnchorLeft (the Mode icon's own measured position, see the layout effect
          above) rather than centering under the whole bar, so it opens directly under its trigger. */}
      {modeOpen && (
        <div
          ref={modePopoverRef}
          data-overlay
          className="glass-strong absolute top-full z-20 mt-1.5 -translate-x-1/2 rounded-[14px] p-1.5"
          style={{ left: modeAnchorLeft ?? '50%' }}
        >
          <ModePicker
            mode={props.mode}
            onChange={(m) => {
              props.onSetMode(m)
              setModeOpen(false)
              modeRef.current?.querySelector('button')?.focus()
            }}
            customModes={props.customModes}
            size="sm"
          />
        </div>
      )}
    </div>
  )
})
