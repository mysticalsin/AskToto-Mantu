import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Image,
  ArrowUp,
  X,
  Eye,
  EyeOff,
  ChevronUp,
  ChevronDown,
  AudioLines,
  LayoutGrid,
  Minimize2,
  Minus
} from 'lucide-react'
import { MantuMark } from './MantuMark'
import { ModePicker } from './ModePicker'
import { Spinner } from './ui'
import { useWindowDrag } from '../lib/window-drag'
import type { ConversationMode } from '@shared/ipc'

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
  stealth: boolean // true = hidden from screen-share/recording (others can't see it)
  onToggleStealth: () => void
  seconds: number
  panelOpen: boolean
  onTogglePanel: () => void
  focusSignal: number
  /** Active conversation mode + setter (the toolbar grid icon opens a mode popover). */
  mode: ConversationMode
  onSetMode: (m: ConversationMode) => void
  /** When present, the answer/copilot body renders INSIDE the widget, above the input. */
  answer?: ReactNode
}

/** A centered toolbar icon: muted by default, accent-2 when active, danger when flagged. */
function IconTool({
  title,
  onClick,
  active,
  danger,
  children
}: {
  title: string
  onClick: () => void
  active?: boolean
  danger?: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={[
        'no-drag focus-ring grid place-items-center rounded-lg p-1 transition-colors duration-[var(--duration-hover)] active:scale-[0.92]',
        danger && active
          ? 'text-[color:var(--color-danger)]'
          : active
            ? 'text-[color:var(--color-accent-2)]'
            : 'text-[color:var(--color-ink-3)] hover:text-[color:var(--color-ink)]'
      ].join(' ')}
    >
      {children}
    </button>
  )
}

export function Bar(props: BarProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const [modeOpen, setModeOpen] = useState(false)
  // Drag the whole window from anywhere on the widget (shared with the control pill). Dragging blurs the
  // input so the caret drops; a press that starts inside the input is excluded so text-selection works.
  const drag = useWindowDrag(() => inputRef.current?.blur())

  useEffect(() => {
    if (props.focusSignal > 0) inputRef.current?.focus()
  }, [props.focusSignal])

  // Escape closes the conversation-mode dropdown. Capture-phase + stopPropagation so it preempts the
  // app's global Escape ladder (which would otherwise collapse the widget instead of closing the menu).
  useEffect(() => {
    if (!modeOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        setModeOpen(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [modeOpen])

  const hasAnswer = !!props.answer

  return (
    // The mode dropdown renders in-flow BELOW the widget (the widget has overflow:hidden + the window
    // hugs its content, so an absolute popover would clip). The flex-col lets it grow the window.
    <div className="relative flex w-full flex-col items-stretch gap-1.5">
      {modeOpen && (
        // Click-away closes the mode dropdown. Behind the dropdown, above the widget.
        <button
          type="button"
          aria-hidden="true"
          tabIndex={-1}
          onClick={() => setModeOpen(false)}
          className="no-drag fixed inset-0 z-20 cursor-default"
        />
      )}

      <div
        {...drag}
        className={[
          'aw-widget w-full',
          props.busy ? 'rainbow-ring' : '',
          props.stealth ? '' : 'outline outline-2 outline-offset-2 outline-[var(--color-danger)]'
        ].join(' ')}
      >
        {/* In-place answer (Answer / Copilot) — expands inside the widget above the input. */}
        {props.answer && <div className="max-h-[46vh] overflow-y-auto px-6 pb-1 pt-4">{props.answer}</div>}

        {/* Row 1 — hero input + ↵ submit */}
        <div
          className="flex items-center gap-4 px-6"
          style={{ paddingTop: hasAnswer ? 6 : 8, paddingBottom: hasAnswer ? 10 : 8 }}
        >
          <input
            ref={inputRef}
            value={props.value}
            onChange={(e) => props.onChange(e.target.value)}
            onFocus={() => void window.toto.prewarmCapture()}
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
              'no-drag focus-ring font-body min-w-0 flex-1 bg-transparent tracking-[-0.01em] text-[color:var(--color-ink)] placeholder:text-[color:var(--color-ink-3)] caret-[var(--color-accent-2)]',
              hasAnswer ? 'text-[15px]' : 'text-[17px] font-[450]'
            ].join(' ')}
          />
          {props.busy ? (
            <button
              type="button"
              title="Stop"
              aria-label="Stop"
              onClick={props.onStop}
              className="no-drag focus-ring grid h-[38px] w-[46px] place-items-center rounded-[12px] border border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)] text-[color:var(--color-danger)] hover:bg-[var(--color-danger)]/20"
            >
              <X size={18} />
            </button>
          ) : (
            <button
              type="button"
              title="Ask (↵)"
              aria-label="Ask"
              onClick={props.onSubmit}
              className="aw-fill no-drag focus-ring grid h-[38px] w-[46px] place-items-center rounded-[12px] text-white hover:brightness-110"
            >
              <ArrowUp size={19} />
            </button>
          )}
        </div>

        {/* Row 2 — toolbar. 3-column grid (1fr · auto · 1fr) so the center tool cluster sits at the TRUE
            horizontal center of the bar regardless of the differing left (logo) / right (History…) widths. */}
        <div className="aw-toolbar grid grid-cols-[1fr_auto_1fr] items-center border-t border-[var(--color-hair-soft)] px-5 py-1.5">
          {/* The Mantu mark IS the logo → opens Settings. (No menu — Quit/Hide live in the tray + hotkeys.) */}
          <button
            type="button"
            title="Settings"
            aria-label="Settings"
            onClick={props.onSettings}
            className="no-drag focus-ring block flex-none justify-self-start rounded-[8px]"
          >
            <span className="aw-mark-glow block rounded-[8px]">
              <MantuMark size={34} />
            </span>
          </button>

          {/* Centered tools — the middle (auto) grid column, dead-center of the bar */}
          <div className="flex items-center justify-center gap-4">
            <IconTool title="Capture screen  (⌘⇧S)" onClick={props.onCapture}>
              {props.capturing ? <Spinner size={21} /> : <Image size={21} strokeWidth={1.85} />}
            </IconTool>
            <IconTool
              title={
                props.stealth
                  ? 'Hidden from screen sharing. Others cannot see AskToto. Click to show.'
                  : 'Visible in screen sharing. Others can see AskToto. Click to hide.'
              }
              onClick={props.onToggleStealth}
              active={!props.stealth}
              danger
            >
              {props.stealth ? <EyeOff size={21} strokeWidth={1.85} /> : <Eye size={21} strokeWidth={1.85} />}
            </IconTool>
            <IconTool title="Conversation mode" onClick={() => setModeOpen((o) => !o)} active={modeOpen}>
              <LayoutGrid size={21} strokeWidth={1.85} />
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
                <AudioLines size={21} strokeWidth={1.85} />
              )}
            </IconTool>
            {props.listening && (
              <span className="tabular-nums text-[12px] font-medium text-[color:var(--color-danger)]">
                {clock(props.seconds)}
              </span>
            )}
          </div>

          {/* Right: History · hide · minimize-to-pill · expand/collapse */}
          <div className="flex flex-none items-center justify-self-end gap-2">
            <button
              type="button"
              onClick={props.onHistory}
              className="no-drag focus-ring mr-0.5 text-[13.5px] font-semibold text-[color:var(--color-ink-2)] hover:text-[color:var(--color-ink)]"
            >
              History
            </button>
            {/* Hide the bar entirely (a global hotkey ⌘\ brings it back). Distinct from minimize-to-pill. */}
            <IconTool title="Hide AskToto  (⌘\\)" onClick={() => void window.toto.hide()}>
              <Minus size={17} strokeWidth={2} />
            </IconTool>
            <IconTool title="Minimize to a small pill" onClick={props.onMinimize}>
              <Minimize2 size={17} strokeWidth={2} />
            </IconTool>
            <button
              type="button"
              title={props.panelOpen ? 'Collapse' : 'Expand'}
              aria-label={props.panelOpen ? 'Collapse' : 'Expand'}
              onClick={props.onTogglePanel}
              className="aw-fill no-drag focus-ring grid h-[32px] w-[36px] place-items-center rounded-[10px] text-white hover:brightness-110"
            >
              {props.panelOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
          </div>
        </div>
      </div>

      {/* Mode picker — in-flow dropdown, centered. */}
      {modeOpen && (
        <div className="aw-menu fade-up z-30 self-center rounded-[12px] p-1.5">
          <ModePicker
            mode={props.mode}
            size="sm"
            onChange={(m) => {
              setModeOpen(false)
              props.onSetMode(m)
            }}
          />
        </div>
      )}
    </div>
  )
}
