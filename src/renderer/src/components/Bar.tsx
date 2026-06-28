import { useEffect, useRef } from 'react'
import { Mic, Camera, Settings2, History, ChevronUp, ChevronDown, ArrowUp, Square, X, GripVertical, Minus, Brain, Eye, EyeOff } from 'lucide-react'
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
  stealth: boolean // true = hidden from screen-share/recording (others can't see it)
  onToggleStealth: () => void
  seconds: number
  panelOpen: boolean
  onTogglePanel: () => void
  focusSignal: number
}

export function Bar(props: BarProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const dragRef = useRef<{ x: number; y: number } | null>(null)
  const movedRef = useRef(false)

  useEffect(() => {
    if (props.focusSignal > 0) inputRef.current?.focus()
  }, [props.focusSignal])

  // The bar's empty areas drag natively (-webkit-app-region). The text field can't be a drag region (you
  // need to click into it), which left only a thin strip near the logo grabbable. This adds a JS drag on
  // the input: hold + move past a few pixels → drag the whole window from anywhere; a plain click still
  // focuses it to type. Deltas are in screen pixels, applied by the main process's moveBy().
  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      if (!dragRef.current) return
      const dx = e.screenX - dragRef.current.x
      const dy = e.screenY - dragRef.current.y
      if (!movedRef.current && Math.abs(dx) + Math.abs(dy) < 3) return
      e.preventDefault() // suppress text selection while dragging
      if (!movedRef.current) inputRef.current?.blur() // drop the caret once a drag begins
      movedRef.current = true
      dragRef.current = { x: e.screenX, y: e.screenY }
      void window.toto.windowMoveBy(dx, dy)
    }
    const onUp = (): void => {
      dragRef.current = null
    }
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [])

  return (
    <div
      className={[
        'glass drag flex h-[40px] w-full items-center gap-1 rounded-full pl-2 pr-1.5',
        // When NOT stealth, others can see the overlay in a screen share → ring the bar to make that obvious.
        props.stealth ? '' : 'outline outline-2 outline-offset-2 outline-[var(--color-danger)]'
      ].join(' ')}
    >
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
        onFocus={() => void window.toto.prewarmCapture()} // prime the screenshot cache for an instant vision ask
        onPointerDown={(e) => {
          if (e.button === 0) {
            dragRef.current = { x: e.screenX, y: e.screenY }
            movedRef.current = false
          }
        }}
        onClick={(e) => {
          if (movedRef.current) {
            e.preventDefault() // it was a drag, not a click — keep it from acting like a focus click
            movedRef.current = false
          }
        }}
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
        aria-pressed={props.listening}
        onClick={props.onToggleListen}
        title={props.listening ? 'Stop listening' : 'Start listening'}
        className={[
          'no-drag focus-ring flex h-[30px] items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium transition-[transform,background-color,color] duration-[var(--duration-hover)] ease-[var(--ease-spring)] active:scale-[0.96]',
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
          'no-drag focus-ring flex h-[30px] items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium transition-[transform,background-color,color] duration-[var(--duration-hover)] ease-[var(--ease-spring)] active:scale-[0.96]',
          props.thinking
            ? 'border border-[var(--color-accent)] bg-[var(--color-accent)] text-white'
            : 'text-[color:var(--color-ink-2)] hover:bg-white/10 hover:text-[color:var(--color-ink)]'
        ].join(' ')}
      >
        <Brain size={14} />
        <span>Think</span>
      </button>

      <IconButton title="Capture screen  (⌘⇧S)" onClick={props.onCapture}>
        {props.capturing ? <Spinner size={14} /> : <Camera size={15} />}
      </IconButton>

      {/* Stealth toggle — whether AskToto shows up in screen shares / recordings (what OTHERS see). */}
      <button
        type="button"
        onClick={props.onToggleStealth}
        aria-label="Toggle screen-share visibility"
        aria-pressed={!props.stealth}
        title={
          props.stealth
            ? 'Hidden from screen sharing & recording — others cannot see AskToto. Click to make it visible.'
            : 'VISIBLE in screen sharing & recording — others can see AskToto. Click to hide it.'
        }
        className={[
          'no-drag focus-ring-strong grid h-[30px] w-[30px] place-items-center rounded-full transition-[transform,background-color,color] duration-[var(--duration-hover)] active:scale-[0.9]',
          props.stealth
            ? 'text-[color:var(--color-ink-2)] hover:bg-white/10 hover:text-[color:var(--color-ink)]'
            : 'bg-[var(--color-danger-soft)] text-[color:var(--color-danger)]'
        ].join(' ')}
      >
        {props.stealth ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>

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
