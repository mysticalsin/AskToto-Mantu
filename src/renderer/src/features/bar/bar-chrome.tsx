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
  FileText,
  Pause,
  Play,
  Square,
  Brain,
  FileSearch
} from 'lucide-react'
import { MantuMark } from '../../components/MantuMark'
import { ModePicker } from '../../components/ModePicker'
import { InlineOrb } from '../../components/AgentStatus'
import { modeLabel, type ConversationMode, type CustomMode } from '@shared/ipc'
import { formatScreenFreshness } from '@shared/perception'
import { accelLabel } from '../../lib/keys'
import type { CaptureDegraded, CaptureHealth, RecognizerStatus } from '../../lib/listen'
import { ObsidianOrb } from '../../components/ObsidianOrb'
import { JarvisOrbButton } from '../../components/JarvisOrbButton'
import { BAR_MARK_SIZE_PX, type OrbMood } from '../../lib/bar-pill-orb'
import { overlayUsesJarvisOrb, type OverlayOrbStyle } from '@shared/overlay-orb'

/** Single source of truth for toolbar icon stroke — prevents per-icon drift. */
export const ICON_STROKE = 1.85

const BAR_CHROME_PX = 96 // input row + toolbar + the padding around the body (BAR_HEIGHT is 84 idle)
const ANSWER_BODY_MIN_PX = 320 // usable floor on a short display; see the ceiling arithmetic below

/** Max height of the in-bar answer body, in px, derived from the DISPLAY rather than the viewport.
 *
 *  This used to be `max-h-[76vh]`, and `vh` resolves against the overlay's own window — whose height is
 *  itself produced by this content: useAutoResize measures the content root, pushes it over IPC, and
 *  main's resizeTo sets the window to it (state.ts / main/index.ts). So the cap was a function of its own
 *  output. H = chrome + 0.76·H settles at H = chrome/0.24, which pinned the window near 360-384px — the
 *  SAME height on a 3840x2160 monitor as on a 1366x768 laptop, ~275px of readable answer either way — and
 *  ratcheted there over several native resizes, because each grow raised the viewport and so raised the
 *  cap again. A screen-derived pixel cap is not a function of the window height, so the loop closes in one
 *  step and the reading area finally scales with the monitor, the way the sibling Panel surface already
 *  does. Read per render (never frozen at module load) so it tracks the display the overlay was moved to,
 *  same as Panel.tsx's panelMaxHeight.
 *
 *  The 76% is kept deliberately — it is now 76% of the SCREEN instead of of itself, so this always-on-top
 *  overlay stays compact over whatever the user is doing rather than filling their display. Since
 *  0.76·avail - chrome + chrome <= avail - 48 holds for any display taller than 200px, the resulting
 *  window also never fights main's `workArea.height - 48` clamp; the floor is likewise below that ceiling
 *  for any display taller than 464px. */
export function answerBodyMaxHeight(
  availHeight: number | undefined = typeof window !== 'undefined' ? window.screen?.availHeight : undefined
): number {
  if (!availHeight || !Number.isFinite(availHeight)) return ANSWER_BODY_MIN_PX
  return Math.max(ANSWER_BODY_MIN_PX, Math.round(availHeight * 0.76) - BAR_CHROME_PX)
}

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
 *  Pause time is supplied by the meeting owner, so parking/remounting this clock cannot erase it. */
export const ElapsedClock = memo(function ElapsedClock({
  startedAt,
  paused,
  pausedMs,
  pausedAt
}: {
  startedAt: number
  paused: boolean
  pausedMs: number
  pausedAt: number | null
}): JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (paused) return
    setNow(Date.now())
    const iv = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [paused, startedAt])
  const elapsedUntil = paused && pausedAt !== null ? pausedAt : now
  const seconds = Math.max(0, Math.floor((elapsedUntil - startedAt - pausedMs) / 1000))
  return (
    <span
      className={[
        'inline-block min-w-[5ch] tabular-nums text-[12px] font-medium',
        paused ? 'text-[color:var(--color-ink-3)]' : 'text-[color:var(--color-danger)]'
      ].join(' ')}
    >
      {clock(seconds)}
    </span>
  )
})

/** A capture this old is no longer "fresh" enough to vouch for — past this, the chip hides itself
 *  rather than sit there reading "Seen 300s ago" for the rest of the meeting. */
const SCREEN_FRESHNESS_MAX_AGE_MS = 60_000

/** Screen-capture freshness chip ("Seen 0.3s ago") — owns its own 500ms tick, same pattern as
 *  ElapsedClock above. Previously this ticked via App-level state (setInterval + setState in App.tsx),
 *  which re-rendered the ENTIRE App tree (including Bar's ~500-line JSX and whichever body was mounted)
 *  every half second for as long as a screen-grounded answer was showing. Isolating the tick here means
 *  it only ever re-renders this one chip. Renders nothing when capturedAt is null/undefined (no
 *  screen-grounded answer active right now) OR once the capture has aged past SCREEN_FRESHNESS_MAX_AGE_MS
 *  — it reappears the instant a NEW capture lands, since `stale` is re-derived from the fresh capturedAt
 *  prop + Date.now() on every render, not counted up independently. */
export const ScreenFreshnessChip = memo(function ScreenFreshnessChip({
  capturedAt
}: {
  capturedAt?: number | null
}): JSX.Element | null {
  const [, setTick] = useState(0)
  const stale = capturedAt == null || Date.now() - capturedAt > SCREEN_FRESHNESS_MAX_AGE_MS
  useEffect(() => {
    if (capturedAt == null) return
    // Once stale, further ticking would only ever re-confirm "still nothing to show" — the chip is
    // already unmounted below — so the interval stops here instead of ticking uselessly for the rest
    // of the meeting. A fresh capturedAt (new capture) re-runs this effect and starts a new interval.
    if (stale) return
    const iv = setInterval(() => setTick((t) => t + 1), 500)
    return () => clearInterval(iv)
  }, [capturedAt, stale])
  if (stale) return null
  return (
    <span className="flex flex-none items-center gap-1 rounded-full bg-white/[0.05] px-2 py-0.5 text-[11px] text-[color:var(--color-ink-2)]">
      <span className="h-[6px] w-[6px] rounded-full bg-[var(--color-accent)]" />
      <Eye size={11} strokeWidth={ICON_STROKE} />
      {/* tabular-nums + a min-width reserve enough stable space for the widest state ("Seen 0.3s ago") so
          the once-a-second re-render (now/0.3s/59s ago, etc.) never nudges this chip's width and causes
          the toolbar around it to micro-reflow. */}
      <span className="inline-block min-w-[13ch] tabular-nums">{formatScreenFreshness(capturedAt)}</span>
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
  /** Non-null while a requested capture side isn't being heard (mic-only / no-mic session) — flips the
   *  "Heard live" chip to an amber "Mic only"/"No mic" state so the degradation stays visible in the
   *  persistent chrome instead of only inside the (collapsible) Copilot body. See lib/listen.ts. */
  captureDegraded?: CaptureDegraded | null
  /** Safe live microphone status from the actual meeting capture track, not the Settings preflight meter. */
  captureHealth?: CaptureHealth | null
  /** Low-priority cue after bounded connected-mic silence; capture degradation always takes precedence. */
  noSpeechWarning?: boolean
  /** Renderer-local actual recognizer/model and safe language mode. */
  recognizerStatus?: RecognizerStatus | null
  /** Pause suspends capture without ending the meeting; Stop (onToggleListen) ends it. Distinct actions. */
  onTogglePause: () => void
  onCapture: () => void
  capturing: boolean
  /** The LIVE, resolved screen-capture accelerator (settings.shortcuts.capture, or the shipped default) —
   *  passed down from App so the Capture tooltip never shows a stale/hardcoded binding once the user
   *  rebinds or clears it in Settings → Shortcuts. */
  captureAccel: string
  onSettings: () => void
  onHistory: () => void
  /** Collapse the widget down to the floating control mini-pill. Bar layout only. */
  onMinimize: () => void
  /** Hide and Island must not show minimize-to-circle. Default true for isolated Bar tests. */
  canMinimize?: boolean
  /** Color language for the docked Bar circle. Idle purple unless a live signal is on the bar. */
  orbMood?: OrbMood
  /** Bar rest look. Circle rest minimizes. The docked circle is always Jarvis particles. */
  orbStyle?: OverlayOrbStyle
  /** When true, the Métis window is hidden from screen capture & sharing (contentProtection). The
   *  eye button toggles this. Separate from Private View (whether Métis captures the user's screen). */
  stealth: boolean
  onToggleStealth: () => void
  /** True when IT has locked `contentProtection` (Settings' managedKeys) — the Private-view icon renders
   *  inert (disabled + a "managed" tooltip) instead of a click that silently does nothing. */
  stealthLocked?: boolean
  /** Wall-clock start time of the current meeting (Date.now() at startListen) — ElapsedClock derives the
   *  ticking display from this instead of App owning a 1 Hz `seconds` counter. Ignored while !listening. */
  startedAt: number
  /** Paused duration and current pause boundary owned by the meeting, surviving dock remounts. */
  pausedMs?: number
  pausedAt?: number | null
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
  /** Start a fresh meeting (ends + saves the current one). Not rendered on the listening
   *  toolbar row — that row is already a meeting. Review / History / after Stop keep the action. */
  onNewMeeting?: () => void
  /** When true, calling prewarmCapture() on input focus is permitted (pass visionReady && screenAsk). */
  canPrewarm?: boolean
  /** Deep-thinking toggle (settings.thinkingMode === 'always') — forces every answer to the deepest model. */
  thinkingOn?: boolean
  onToggleThinking?: () => void
  /** Spotlight Ref — checks a dedicated Dust agent for sales references on the current use case. */
  onSpotlightRef?: () => void
  /** True only when the Spotlight Ref Dust agent is configured. The control stays visible when false
   *  so the feature remains discoverable; its label and existing unavailable path explain setup. */
  spotlightReady?: boolean
}

/** A centered toolbar icon: muted by default, accent-2 when active, danger when flagged.
 *  rainbow: wraps the button in the same spinning conic-gradient ring used for the busy/stealth states —
 *  for a toggle whose "on" state should read as unmistakably distinct (e.g. Deep thinking).
 *  Tooltip is a custom instant label (Cluely-style — appears immediately on hover, no OS delay) rather
 *  than the native `title` attribute; `aria-label` keeps it accessible to screen readers. */
export function IconTool({
  title,
  onClick,
  onMouseEnter,
  onMouseDown,
  active,
  danger,
  rainbow,
  cyanIdle,
  ariaHasPopup,
  ariaExpanded,
  edgeRight,
  edgeLeft,
  disabled,
  children
}: {
  title: string
  onClick: () => void
  /** Optional hover hook — used by the Capture tool to pre-warm the OS capture pipeline at the one
   *  moment screen intent is actually signalled (MQA-236: never on text-input focus). */
  onMouseEnter?: () => void
  /** Optional press hook — re-arms capture prewarm so a click >TTL after hover still shares the
   *  in-flight single-flight capture instead of paying a cold desktopCapturer round trip. */
  onMouseDown?: () => void
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
  // Locked by managed config (e.g. IT-enforced Private view) — native `disabled` makes the click an inert
  // no-op; the tooltip (on the surrounding .group div, not the button itself) still shows on hover so the
  // "managed" reason stays visible instead of the control just silently doing nothing.
  disabled?: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <div className="group relative inline-flex">
      <button
        type="button"
        aria-label={title}
        aria-haspopup={ariaHasPopup ? 'menu' : undefined}
        aria-expanded={ariaExpanded}
        disabled={disabled}
        onClick={onClick}
        onMouseEnter={onMouseEnter}
        onMouseDown={onMouseDown}
        className={[
          'no-drag focus-ring peer grid place-items-center rounded-[10px] p-1 transition-colors duration-[var(--duration-hover)] active:scale-[0.92]',
          rainbow ? 'rainbow-ring' : '',
          disabled ? 'cursor-not-allowed opacity-40' : '',
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
