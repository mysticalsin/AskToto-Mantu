import { useEffect, useRef, useState } from 'react'
import { AlertCircle, AlignLeft, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Camera, CircleCheck, Eye, FileSearch, Lightbulb, MessageSquare, MessageSquareQuote, Mic, RotateCcw, Settings2, type LucideIcon } from 'lucide-react'
import type { HotkeyAction, PublicSettings, ShortcutFailure } from '@shared/ipc'
import { DEFAULT_SHORTCUTS, HOTKEY_ACTIONS } from '@shared/ipc'
import { displayAccelerator } from '../../lib/keys'

const SHORTCUT_LABELS: Record<HotkeyAction, string> = {
  ask: 'Ask (global)',
  hide: 'Show / hide',
  capture: 'Capture screen',
  factcheck: 'Fact-check',
  'toggle-listen': 'Toggle Listen',
  'metis-command': 'Summon Métis command',
  reset: 'New / reset',
  whatnext: 'What to say next',
  explain: 'Explain',
  summarize: 'Summarize screen',
  'spotlight-ref': 'Spotlight Ref',
  'scroll-up': 'Move up',
  'scroll-down': 'Move down',
  'scroll-left': 'Move left',
  'scroll-right': 'Move right',
  settings: 'Open settings',
  agenda: "Today's agenda" // tray-only action; not listed in HOTKEY_ACTIONS so it renders no shortcut row
}

type ShortcutGroup = 'General' | 'Window'

const SHORTCUT_GROUPS: Record<HotkeyAction, ShortcutGroup> = {
  ask: 'General',
  hide: 'General',
  reset: 'General',
  settings: 'General',
  'toggle-listen': 'General',
  'metis-command': 'General',
  capture: 'General',
  factcheck: 'General',
  whatnext: 'General',
  explain: 'General',
  summarize: 'General',
  'spotlight-ref': 'General',
  'scroll-up': 'Window',
  'scroll-down': 'Window',
  'scroll-left': 'Window',
  'scroll-right': 'Window',
  agenda: 'General'
}

const SHORTCUT_ICONS: Partial<Record<HotkeyAction, LucideIcon>> = {
  ask: MessageSquare,
  hide: Eye,
  reset: RotateCcw,
  settings: Settings2,
  'toggle-listen': Mic,
  capture: Camera,
  factcheck: CircleCheck,
  whatnext: MessageSquareQuote,
  explain: Lightbulb,
  summarize: AlignLeft,
  'spotlight-ref': FileSearch,
  'scroll-up': ArrowUp,
  'scroll-down': ArrowDown,
  'scroll-left': ArrowLeft,
  'scroll-right': ArrowRight
}


// Maps a KeyboardEvent key value to the Electron accelerator token.
// Lone modifiers, PrintScreen, etc. are not valid as the main key.
const LONE_MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'OS', 'AltGraph', 'CapsLock'])

export function keyEventToAccelerator(e: React.KeyboardEvent<HTMLInputElement>): string | null {
  const key = e.key
  if (LONE_MODIFIERS.has(key)) return null // lone modifier — not a complete combo

  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')

  // Must have at least one modifier — bare keys would conflict with typing
  if (parts.length === 0) return null

  // Normalise the main key to Electron accelerator notation
  let main = key
  if (key === ' ') main = 'Space'
  else if (key === 'Enter') main = 'Return'
  else if (key === 'ArrowUp') main = 'Up'
  else if (key === 'ArrowDown') main = 'Down'
  else if (key === 'ArrowLeft') main = 'Left'
  else if (key === 'ArrowRight') main = 'Right'
  else if (key === 'Escape') main = 'Escape'
  else if (key === 'Backspace') main = 'Backspace'
  else if (key === 'Delete') main = 'Delete'
  else if (key.length === 1) main = key.toUpperCase() // A-Z, 0-9, punctuation
  // Function keys (F1-F24), PageUp/PageDown, Home, End, Insert — pass through as-is

  parts.push(main)
  return parts.join('+')
}

function KeyChips({ accelerator }: { accelerator: string }): JSX.Element {
  if (!accelerator) {
    return <span className="text-[11px] text-[color:var(--cl-muted-foreground)]">Click to record</span>
  }
  const parts = displayAccelerator(accelerator).split('+')
  return (
    <span className="flex flex-wrap items-center gap-0.5">
      {parts.map((part, i) => (
        <span key={i} className="inline-flex items-center rounded border border-[var(--cl-border)] bg-[var(--cl-card)] px-1.5 text-[11px] font-medium text-[color:var(--cl-foreground)]">
          {part}
        </span>
      ))}
    </span>
  )
}

function KeyRecorder({
  value,
  onChange
}: {
  value: string
  // Returns a conflict message to display inline (and block the change) or null once the accelerator
  // was accepted and committed.
  onChange: (v: string) => string | null
}): JSX.Element {
  const [recording, setRecording] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const [conflictMsg, setConflictMsg] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  // True when recording ended by keypress (cancel or commit) rather than because focus had already moved
  // away. The input unmounts either way, so without this focus falls to <body> and a keyboard user restarts
  // from the top of a nine-tab Settings panel.
  const returnFocus = useRef(false)

  // Auto-focus the capture input when recording starts; hand focus back to the row's trigger when a
  // keypress ends it, so the keyboard user stays where they were.
  useEffect(() => {
    if (recording) {
      inputRef.current?.focus()
      return
    }
    if (!returnFocus.current) return
    returnFocus.current = false
    triggerRef.current?.focus()
  }, [recording])

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    // Tab stays sequential-focus navigation. Cancelling it here made the recorder a keyboard trap
    // (WCAG 2.1.2, No Keyboard Trap): Tab did nothing, and Shift+Tab did not escape but RECORDED, binding
    // reverse-tab as an OS-global hotkey. Let the browser move focus — the resulting blur ends recording.
    if (e.key === 'Tab') return
    e.preventDefault()
    // Escape is the advertised way out (the hint under the field says so), so it stops here. Left to bubble
    // it also reaches App's window-level Escape handler, which closes the entire Settings panel — an exit
    // that throws away the user's place is not an exit.
    e.stopPropagation()
    if (e.key === 'Escape') {
      returnFocus.current = true
      setRecording(false)
      setPreview(null)
      setConflictMsg(null)
      return
    }
    const acc = keyEventToAccelerator(e)
    if (acc === null) {
      setPreview(null)
      return
    }
    const err = onChange(acc)
    if (err) {
      // Blocked by a collision with another action's binding — stay in recording mode so the user can
      // immediately try a different combination, and name what it collided with.
      setPreview(acc)
      setConflictMsg(err)
      return
    }
    setConflictMsg(null)
    setPreview(acc)
    setTimeout(() => {
      returnFocus.current = true
      setRecording(false)
      setPreview(null)
    }, 120)
  }

  const onBlur = (): void => {
    // Focus has already gone somewhere the user chose (Tab, or a click) — pulling it back to the trigger
    // would fight them.
    returnFocus.current = false
    setRecording(false)
    setPreview(null)
    setConflictMsg(null)
  }

  if (recording) {
    return (
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <input
          ref={inputRef}
          type="text"
          readOnly
          value={preview !== null ? displayAccelerator(preview) : 'Recording… press keys'}
          onBlur={onBlur}
          onKeyDown={onKeyDown}
          title="Press your desired key combination"
          className="no-drag cl-input font-ui min-w-0 flex-1 cursor-pointer select-none px-2 py-1 text-[12px] border-[var(--cl-primary)] bg-[var(--cl-primary-soft)] text-[color:var(--cl-primary)] outline-none ring-1 ring-[var(--cl-primary)] transition-colors"
        />
        <span className="text-[11px] text-[color:var(--cl-muted-foreground)]">
          Press Esc to cancel · Tab to move on
        </span>
        {conflictMsg && (
          <span className="text-[11px] text-[color:var(--cl-destructive)]">{conflictMsg}</span>
        )}
      </div>
    )
  }

  return (
    <button
      ref={triggerRef}
      type="button"
      onClick={() => setRecording(true)}
      title="Click then press your desired key combination"
      className="no-drag cl-focus cl-input min-w-0 flex-1 cursor-pointer px-2 py-1 text-left transition-colors hover:bg-white/[0.04]"
    >
      <KeyChips accelerator={value} />
    </button>
  )
}

export function Shortcuts({
  settings,
  patch
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
}): JSX.Element {
  const user = settings.shortcuts ?? {}
  // Bindings main could NOT register globally (another app or the OS already owns the combo — Electron
  // fails silently, so without this the row looks bound but the key does nothing). Keyed on
  // settings.shortcuts rather than a manual refetch-after-save: patch() only updates settings once the
  // settingsSet handler has already re-run registerShortcuts(), so this effect fires on mount AND after
  // every save, always reading the post-registration failure list.
  const [failures, setFailures] = useState<ShortcutFailure[]>([])
  useEffect(() => {
    let cancelled = false
    void window.toto.getShortcutFailures().then((f) => {
      if (!cancelled) setFailures(f)
    })
    return () => {
      cancelled = true
    }
  }, [settings.shortcuts])
  const reset = (action: HotkeyAction): void => {
    const next = { ...user }
    next[action] = DEFAULT_SHORTCUTS[action] ?? ''
    patch({ shortcuts: next })
  }
  // An action's currently-resolved binding — its own override, or the shipped default.
  const resolvedShortcut = (a: HotkeyAction): string => user[a] ?? DEFAULT_SHORTCUTS[a] ?? ''
  // Rebinding one action must never silently steal another's hotkey (Electron's registerShortcuts()
  // just rebinds duplicates to whichever registers last, with no error), so validate against every
  // other action's resolved binding before committing. Returns a conflict message to surface inline
  // (and blocks the save) instead of committing, or null once the value is safely persisted.
  const set = (action: HotkeyAction, value: string): string | null => {
    if (value) {
      const other = HOTKEY_ACTIONS.find((a) => a !== action && resolvedShortcut(a) === value)
      if (other) return `Already used by ${SHORTCUT_LABELS[other]}.`
    }
    patch({ shortcuts: { ...user, [action]: value } })
    return null
  }

  const groups: ShortcutGroup[] = ['General', 'Window']

  return (
    <div className="flex flex-col gap-4">
      {failures.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-[var(--cl-destructive)]/30 bg-[var(--cl-destructive)]/5 px-3 py-2.5">
          <div className="flex items-start gap-1.5 text-[11px] leading-snug text-[color:var(--cl-destructive)]">
            <AlertCircle size={13} className="mt-px shrink-0" />
            <span>
              {failures.length === 1 ? "This shortcut couldn't" : "These shortcuts couldn't"} be
              registered. Either another app already owns the combo, or it is a navigation key Métis will
              not take over globally. Rebind {failures.length === 1 ? 'it' : 'them'} below.
            </span>
          </div>
          {failures.map((f) => (
            <div key={f.action} className="flex items-center gap-2 pl-5 text-[11px] text-[color:var(--cl-muted-foreground)]">
              <span className="min-w-[110px]">{SHORTCUT_LABELS[f.action as HotkeyAction] ?? f.action}</span>
              <KeyChips accelerator={f.accel} />
            </div>
          ))}
        </div>
      )}
      {groups.map((group) => {
        const actions = HOTKEY_ACTIONS.filter((a) => SHORTCUT_GROUPS[a] === group)
        if (actions.length === 0) return null
        return (
          <div key={group} className="flex flex-col gap-1">
            <div className="cl-eyebrow mb-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--cl-muted-foreground)]">
              {group}
            </div>
            {actions.map((action) => {
              const current = user[action] ?? DEFAULT_SHORTCUTS[action] ?? ''
              const isDefault = current === (DEFAULT_SHORTCUTS[action] ?? '')
              const Icon = SHORTCUT_ICONS[action]
              return (
                <div key={action} className="flex items-center justify-between gap-3 px-1 py-1.5 text-[13px]">
                  <span className="flex min-w-[140px] items-center gap-1.5 text-[12px] text-[color:var(--cl-muted-foreground)]">
                    {Icon && <Icon size={14} className="shrink-0" />}
                    {SHORTCUT_LABELS[action]}
                  </span>
                  <div className="flex flex-1 items-center gap-2">
                    <KeyRecorder value={current} onChange={(v) => set(action, v)} />
                    <button
                      type="button"
                      onClick={() => set(action, '')}
                      className="no-drag cl-focus rounded-md px-2 py-1 text-[11px] text-[color:var(--cl-muted-foreground)] hover:bg-white/[0.06] hover:text-[color:var(--cl-foreground)]"
                    >
                      Clear
                    </button>
                    {!isDefault && (
                      <button
                        type="button"
                        onClick={() => reset(action)}
                        className="no-drag cl-focus rounded-md px-2 py-1 text-[11px] text-[color:var(--cl-primary)] hover:bg-white/[0.06]"
                      >
                        Reset
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )
      })}
      <div className="text-[11px] leading-relaxed text-[color:var(--cl-muted-foreground)]">
        Click a shortcut field and press your desired key combination. Changes apply immediately.
      </div>
    </div>
  )
}
