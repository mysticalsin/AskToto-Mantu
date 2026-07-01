import { useEffect, useRef, useState, type ReactNode } from 'react'
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
  Plus,
  Brain,
  FileSearch
} from 'lucide-react'
import { MantuMark } from './MantuMark'
import { ModePicker } from './ModePicker'
import { Spinner } from './ui'
import { useWindowDrag } from '../lib/window-drag'
import { modeLabel } from '@shared/ipc'
import type { ConversationMode, CustomMode } from '@shared/ipc'

/** Single source of truth for toolbar icon stroke — prevents per-icon drift. */
const ICON_STROKE = 1.85

function clock(s: number): string {
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r.toString().padStart(2, '0')}`
}

export interface BarProps {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  onStop: () => void
  busy: boolean
  listening: boolean
  onToggleListen: () => void
  onCapture: () => void
  capturing: boolean
  onSettings: () => void
  onHistory: () => void
  /** Collapse the widget down to the floating control mini-pill. */
  onMinimize: () => void
  /** When true, activates Private view — notes are excluded from shared screens. */
  stealth: boolean
  onToggleStealth: () => void
  seconds: number
  panelOpen: boolean
  onTogglePanel: () => void
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
  /** When set, renders a small inline chip (purple dot + Eye + label) near the input. */
  contextLabel?: string
  /** Needed to resolve a custom mode id to its display label. */
  customModes?: CustomMode[]
  /** When listening, the right column shows a "Transcript" button calling this instead of "History". */
  onTranscript?: () => void
  /** Start a fresh meeting from the bar (ends + saves the current one, then begins a new session). */
  onNewMeeting?: () => void
  /** When true, calling prewarmCapture() on input focus is permitted (pass visionReady && screenAsk). */
  canPrewarm?: boolean
  /** Deep-thinking toggle (settings.thinkingMode === 'always') — forces every answer to the deepest model. */
  thinkingOn?: boolean
  onToggleThinking?: () => void
  /** Spotlight Ref — checks a dedicated Dust agent for sales references on the current use case. */
  onSpotlightRef?: () => void
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
  children
}: {
  title: string
  onClick: () => void
  active?: boolean
  danger?: boolean
  rainbow?: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <div className="group relative inline-flex">
      <button
        type="button"
        aria-label={title}
        onClick={onClick}
        className={[
          'no-drag focus-ring grid place-items-center rounded-[10px] p-1 transition-colors duration-[var(--duration-hover)] active:scale-[0.92]',
          rainbow ? 'rainbow-ring' : '',
          danger && active
            ? 'text-[color:var(--color-danger)]'
            : active
              ? 'text-[color:var(--color-accent-2)]'
              : 'text-[color:var(--color-ink-3)] hover:text-[color:var(--color-ink)]'
        ].join(' ')}
      >
        {children}
      </button>
      <span className="pointer-events-none absolute -top-1.5 left-1/2 z-20 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg bg-black/90 px-2.5 py-1 text-[11px] font-medium text-white opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100">
        {title}
      </span>
    </div>
  )
}

export function Bar(props: BarProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  // Drag the whole window from anywhere on the widget (shared with the control pill). Dragging blurs the
  // input so the caret drops; a press that starts inside the input is excluded so text-selection works.
  const drag = useWindowDrag(() => inputRef.current?.blur())

  useEffect(() => {
    if (props.focusSignal > 0) inputRef.current?.focus()
  }, [props.focusSignal])

  // Mode popover (Cluely-style: click the grid icon, pick a mode right there — no Settings redirect).
  // Two refs because the popover itself renders as a SIBLING of the icon (see below — escaping
  // .aw-widget's overflow:hidden) — outside-click must not close it while a click lands in either.
  const [modeOpen, setModeOpen] = useState(false)
  const modeRef = useRef<HTMLDivElement>(null)
  const modePopoverRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!modeOpen) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (modeRef.current?.contains(t)) return
      if (modePopoverRef.current?.contains(t)) return
      setModeOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [modeOpen])

  // When a body is present the bar EXPANDS into one surface (big input → body → toolbar at the bottom).
  const expanded = !!props.body
  const hasAnswer = props.hasAnswer ?? expanded

  return (
    // The flex-col lets additional in-flow elements grow the window as needed.
    <div className="relative flex w-full flex-col items-stretch gap-1.5">
      <div
        {...drag}
        className={[
          'aw-widget w-full',
          // Working → fast rainbow ring; Private view on → calm slow rainbow contour as the indicator.
          props.busy ? 'rainbow-ring' : props.stealth ? 'aw-hidden-rainbow' : ''
        ].join(' ')}
      >
        {/* Row 1 — hero input + ↵ submit. Grows when expanded so the "ask anything" reads big.
            Padding and font-size transition together for a smooth expand/collapse. */}
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

          {/* Context label chip (e.g. 'Viewed screen') */}
          {props.contextLabel && (
            <span className="flex flex-none items-center gap-1 rounded-full bg-white/[0.05] px-2 py-0.5 text-[11px] text-[color:var(--color-ink-2)]">
              <span className="h-[6px] w-[6px] rounded-full bg-[var(--color-accent)]" />
              <Eye size={11} strokeWidth={ICON_STROKE} />
              {props.contextLabel}
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
              title="Stop"
              aria-label="Stop"
              onClick={props.onStop}
              className="no-drag focus-ring grid h-[38px] w-[46px] place-items-center rounded-[10px] border border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)] text-[color:var(--color-danger)] hover:bg-[var(--color-danger)]/20"
            >
              <X size={18} />
            </button>
          ) : (
            // Hero submit — accent-filled, ~38px. The only aw-fill control in the bar row.
            <button
              type="button"
              title="Ask (↵)"
              aria-label="Ask"
              onClick={props.onSubmit}
              className="aw-fill no-drag focus-ring flex-none grid h-[38px] w-[46px] place-items-center rounded-[10px] text-white transition-colors duration-[var(--duration-hover)]"
            >
              <CornerDownLeft size={15} strokeWidth={ICON_STROKE} />
            </button>
          )}
        </div>

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

        {/* Row 2 — toolbar. 3-column grid (1fr · auto · 1fr) so the center tool cluster stays dead-center.
            When the bar is expanded this row sits at the BOTTOM, under the body: logo left, icons center,
            History / Transcript right. */}
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

          {/* Centered tools — the middle (auto) grid column, dead-center of the bar.
              A fixed-width slot for the timer + pause prevents the cluster from shifting when listening
              starts; Capture / Spotlight Ref / Mode / Deep thinking / Private view always stay in exactly
              the same position, with the divider right before Listen. */}
          <div className="flex items-center justify-center gap-4">
            <IconTool title="Capture screen  (⌘⇧S)" onClick={props.onCapture}>
              {props.capturing ? <Spinner size={19} /> : <Image size={19} strokeWidth={ICON_STROKE} />}
            </IconTool>
            {/* Spotlight Ref — asks a dedicated Dust agent whether Mantu has relevant sales references
                for the use case currently being discussed. Answer renders in the normal Answer panel. */}
            <IconTool title="Spotlight Ref" onClick={() => props.onSpotlightRef?.()}>
              <FileSearch size={19} strokeWidth={ICON_STROKE} />
            </IconTool>
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
            <IconTool
              title={props.stealth ? 'Private view on' : 'Private view off'}
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
            >
              {props.listening ? (
                <span className="rec-dot h-[12px] w-[12px] rounded-full bg-[var(--color-danger)] shadow-[0_0_8px_var(--color-danger)]" />
              ) : (
                <AudioLines size={19} strokeWidth={ICON_STROKE} />
              )}
            </IconTool>
            {/* Fixed-width reserved slot for timer + pause — always present so the cluster never shifts */}
            <div className="flex w-[72px] items-center gap-2">
              {props.listening && (
                <>
                  <span className="tabular-nums text-[12px] font-medium text-[color:var(--color-danger)]">
                    {clock(props.seconds)}
                  </span>
                  {/* Pause button — wired to listen-toggle for now; a true pause state is out of scope. */}
                  <button
                    type="button"
                    title="Pause recording"
                    aria-label="Pause recording"
                    onClick={props.onToggleListen}
                    className="no-drag focus-ring grid place-items-center rounded-[10px] p-1 text-[color:var(--color-ink-3)] transition-colors duration-[var(--duration-hover)] hover:text-[color:var(--color-ink)]"
                  >
                    <Pause size={16} strokeWidth={ICON_STROKE} />
                  </button>
                </>
              )}
            </div>
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
                  title="Show the live transcript"
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
            <IconTool title="Minimize to a small pill" onClick={props.onMinimize}>
              <Minimize2 size={17} strokeWidth={ICON_STROKE} />
            </IconTool>
            {/* Collapse-chevron: plain ghost, not aw-fill. Submit is the only accent-filled control. */}
            <button
              type="button"
              title={props.panelOpen ? 'Collapse' : 'Expand'}
              aria-label={props.panelOpen ? 'Collapse' : 'Expand'}
              onClick={props.onTogglePanel}
              className="no-drag focus-ring grid h-[32px] w-[36px] place-items-center rounded-[10px] text-[color:var(--color-ink-3)] transition-colors duration-[var(--duration-hover)] hover:text-[color:var(--color-ink)]"
            >
              {props.panelOpen ? <ChevronUp size={16} strokeWidth={ICON_STROKE} /> : <ChevronDown size={16} strokeWidth={ICON_STROKE} />}
            </button>
          </div>
        </div>
      </div>

      {/* Mode popover — deliberately a SIBLING of .aw-widget (not nested inside it), because .aw-widget
          has overflow:hidden for its rounded-corner blur backdrop, which would otherwise clip this.
          Centered under the whole bar (good enough visually; the mode icon sits in the center cluster). */}
      {modeOpen && (
        <div
          ref={modePopoverRef}
          className="glass-strong absolute left-1/2 top-full z-20 mt-1.5 -translate-x-1/2 rounded-[14px] p-1.5"
        >
          <ModePicker
            mode={props.mode}
            onChange={(m) => {
              props.onSetMode(m)
              setModeOpen(false)
            }}
            customModes={props.customModes}
            size="sm"
          />
        </div>
      )}
    </div>
  )
}
