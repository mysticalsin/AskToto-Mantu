import { useEffect, useRef } from 'react'
import { Mic, Camera, Settings2, History, ChevronUp, ChevronDown, ArrowUp, Square, X, GripVertical, Minus, Brain } from 'lucide-react'
import { MantuMark } from './MantuMark'
import { IconButton, Spinner } from './ui'

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
  listenLoading: boolean
  onToggleListen: () => void
  thinking: boolean
  onToggleThink: () => void
  onCapture: () => void
  capturing: boolean
  onSettings: () => void
  onHistory: () => void
  onHide: () => void
  onClose: () => void
  seconds: number
  panelOpen: boolean
  onTogglePanel: () => void
  focusSignal: number
}

export function Bar(props: BarProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (props.focusSignal > 0) inputRef.current?.focus()
  }, [props.focusSignal])

  return (
    <div className="glass drag flex h-[40px] w-full items-center gap-1 rounded-full pl-2 pr-1.5">
      <span
        title="Drag to move (⌘⌥ arrows also work)"
        aria-hidden="true"
        className="drag -mr-0.5 flex cursor-grab items-center text-[color:var(--color-ink-3)] active:cursor-grabbing"
      >
        <GripVertical size={15} />
      </span>
      <div className="flex items-center gap-1.5 pr-1 text-[color:var(--color-ink)]">
        <MantuMark size={20} />
        <span className="font-ui select-none text-[13px] font-medium tracking-tight text-[color:var(--color-ink-2)]">
          AskToto
        </span>
      </div>

      <div className="mx-1 h-5 w-px bg-[var(--color-hair-soft)]" />

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
        placeholder="Ask anything…"
        spellCheck={false}
        aria-label="Ask AskToto anything"
        className="no-drag focus-ring font-body min-w-0 flex-1 rounded-md bg-transparent px-1 py-1 text-[14px] text-[color:var(--color-ink)] placeholder:text-[color:var(--color-ink-2)]"
      />

      {props.busy ? (
        <IconButton title="Stop" onClick={props.onStop} danger>
          <Square size={14} fill="currentColor" />
        </IconButton>
      ) : (
        <IconButton title="Ask (↵)" onClick={props.onSubmit}>
          <ArrowUp size={17} />
        </IconButton>
      )}

      <div className="mx-0.5 h-5 w-px bg-[var(--color-hair-soft)]" />

      {/* Listen / Recording pill */}
      <button
        type="button"
        role="button"
        aria-pressed={props.listening}
        onClick={props.onToggleListen}
        title={props.listening ? 'Stop listening' : 'Start listening'}
        className={[
          'no-drag focus-ring flex h-[30px] items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium transition-colors duration-[var(--duration-hover)] ease-[var(--ease-spring)]',
          props.listening
            ? 'border border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)] text-[color:var(--color-danger)]'
            : 'text-[color:var(--color-ink-2)] hover:bg-white/10 hover:text-[color:var(--color-ink)]'
        ].join(' ')}
      >
        {props.listenLoading ? (
          <Spinner size={13} />
        ) : props.listening ? (
          <span className="rec-dot h-[7px] w-[7px] rounded-full bg-[var(--color-danger)] shadow-[0_0_8px_var(--color-danger)]" />
        ) : (
          <Mic size={14} />
        )}
        <span className="tabular-nums">
          {props.listening ? `Recording ${clock(props.seconds)}` : 'Listen'}
        </span>
      </button>

      {/* Thinking mode — when on, forces the stronger model (e.g. Sonnet); off = smart auto-routing. */}
      <button
        type="button"
        role="switch"
        aria-checked={props.thinking}
        aria-label="Thinking mode"
        onClick={props.onToggleThink}
        title={
          props.thinking
            ? 'Thinking mode ON — answers use the deeper model (e.g. Sonnet)'
            : 'Thinking mode OFF — auto: fast model for simple, deep model for hard/coding'
        }
        className={[
          'no-drag focus-ring flex h-[30px] items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium transition-colors duration-100 ease-[var(--ease-spring)]',
          props.thinking
            ? 'border border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)] text-[color:var(--color-accent)]'
            : 'text-[color:var(--color-ink-2)] hover:bg-white/10 hover:text-[color:var(--color-ink)]'
        ].join(' ')}
      >
        <Brain size={14} />
        <span>Think</span>
      </button>

      <IconButton title="Capture screen  (⌘⇧S)" onClick={props.onCapture}>
        {props.capturing ? <Spinner size={14} /> : <Camera size={15} />}
      </IconButton>

      <IconButton title="Meeting history" onClick={props.onHistory}>
        <History size={15} />
      </IconButton>

      <IconButton title="Settings" onClick={props.onSettings}>
        <Settings2 size={15} />
      </IconButton>

      <IconButton
        title={props.panelOpen ? 'Collapse' : 'Expand'}
        onClick={props.onTogglePanel}
      >
        {props.panelOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </IconButton>

      <IconButton title="Hide  (⌘\\)" onClick={props.onHide}>
        <Minus size={16} />
      </IconButton>

      <IconButton title="Quit AskToto  (⌘Q)" onClick={props.onClose}>
        <X size={16} />
      </IconButton>
    </div>
  )
}
