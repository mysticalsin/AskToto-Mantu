import { useEffect, useId, useRef, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import type { VoiceChordToken } from '@shared/voice-actions-settings'
import {
  RECORD_MIN_HOLD_MS,
  canonicalChord,
  chordChips,
  chordNotes,
  chordSpoken,
  tokenForKeyCode,
  validateChord,
  type ChordRecorderPlatform
} from '@shared/voice/chord-recorder'

const CHIP =
  'inline-flex items-center rounded border border-[var(--cl-border)] bg-[var(--cl-card)] px-1.5 text-[11px] font-medium text-[color:var(--cl-foreground)]'
const TEXT_BUTTON =
  'no-drag cl-focus rounded-md px-2 py-1 text-[11px] hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50'

/** The held keys as chips ("Right ⌘"). Read-only; also used by the Keyboard shortcuts list. */
export function ChordChips({
  tokens,
  platform,
  id
}: {
  tokens: readonly VoiceChordToken[]
  platform: ChordRecorderPlatform
  id?: string
}): JSX.Element {
  return (
    <span id={id} className="flex flex-wrap items-center gap-0.5">
      {chordChips(tokens, platform).map((chip) => (
        <span key={chip} className={CHIP}>
          {chip}
        </span>
      ))}
    </span>
  )
}

type Feedback = { kind: 'error' | 'hint'; text: string }

/**
 * The hold-to-talk chord recorder (V06). The accelerator recorder in Shortcuts.tsx rejects lone modifiers, and a
 * lone modifier (Right Command) is the default chord, so this one records modifier keys only: it collects the union
 * of the modifiers held, and when every key is up it commits that set if it was held for at least 400 ms and passes
 * `validateChord`. A refusal is explained inline next to the field and recording continues, so the next try is one
 * hold away. Escape cancels; Tab is never trapped (a blur ends recording); any other key is refused with a sentence.
 * While recording, `onRecordingChange(true)` lets the owner pause the global hold so holding Right Command here does
 * not also start a voice turn.
 */
export function HoldChordRecorder({
  tokens,
  defaultTokens,
  platform,
  disabled = false,
  onCommit,
  onRecordingChange
}: {
  tokens: readonly VoiceChordToken[]
  defaultTokens: readonly VoiceChordToken[]
  platform: ChordRecorderPlatform
  disabled?: boolean
  onCommit: (tokens: VoiceChordToken[]) => void
  onRecordingChange?: (recording: boolean) => void
}): JSX.Element {
  const [recording, setRecording] = useState(false)
  const [live, setLive] = useState<VoiceChordToken[]>([])
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const held = useRef(new Set<VoiceChordToken>())
  const union = useRef(new Set<VoiceChordToken>())
  const heldSince = useRef<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  // True when recording ended by a keypress (Escape or a commit), so focus returns to the trigger. A blur that
  // ended it already put focus where the person chose.
  const returnFocus = useRef(false)
  // Set the moment recording ends, so the blur some browsers fire as the input unmounts cannot undo returnFocus.
  const active = useRef(false)
  const chipsId = useId()
  const noteId = useId()
  const notifyRef = useRef(onRecordingChange)
  notifyRef.current = onRecordingChange

  useEffect(() => {
    if (recording) {
      inputRef.current?.focus()
      return
    }
    if (!returnFocus.current) return
    returnFocus.current = false
    triggerRef.current?.focus()
  }, [recording])

  // Tell the owner when recording opens and closes, and always on unmount (a closed tab must release the pause).
  useEffect(() => {
    if (!recording) return
    notifyRef.current?.(true)
    return () => notifyRef.current?.(false)
  }, [recording])

  const reset = (): void => {
    held.current.clear()
    union.current.clear()
    heldSince.current = null
    setLive([])
  }

  const stop = (restoreFocus: boolean): void => {
    reset()
    setFeedback(null)
    returnFocus.current = restoreFocus
    active.current = false
    setRecording(false)
  }

  const start = (): void => {
    reset()
    setFeedback(null)
    active.current = true
    setRecording(true)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    // Tab keeps moving focus (No Keyboard Trap); the blur it causes ends recording.
    if (event.key === 'Tab') return
    event.preventDefault()
    // Escape is the advertised way out. Stop it here: it would otherwise also close the whole Settings panel.
    event.stopPropagation()
    if (event.key === 'Escape') {
      stop(true)
      return
    }
    const token = tokenForKeyCode(event.code)
    if (token === null) {
      reset()
      const example = chordChips(defaultTokens, platform).join(' ')
      setFeedback({
        kind: 'error',
        text: `Only modifier keys work here. Hold ${example} or another modifier on its own.`
      })
      return
    }
    if (event.repeat) return
    if (held.current.size === 0 && union.current.size === 0) heldSince.current = performance.now()
    held.current.add(token)
    union.current.add(token)
    setFeedback(null)
    setLive(canonicalChord(union.current))
  }

  const onKeyUp = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    const token = tokenForKeyCode(event.code)
    if (token === null) return
    event.preventDefault()
    event.stopPropagation()
    held.current.delete(token)
    if (held.current.size > 0 || union.current.size === 0) return
    const chosen = canonicalChord(union.current)
    const heldFor = heldSince.current === null ? 0 : performance.now() - heldSince.current
    reset()
    if (heldFor < RECORD_MIN_HOLD_MS) {
      setFeedback({ kind: 'hint', text: 'Hold the keys a little longer, then let go.' })
      return
    }
    const verdict = validateChord(chosen, platform)
    if (!verdict.ok) {
      setFeedback({ kind: 'error', text: verdict.message })
      return
    }
    onCommit(chosen)
    stop(true)
  }

  const notes = chordNotes(tokens, platform)
  const isDefault = canonicalChord(tokens).join() === canonicalChord(defaultTokens).join()
  const spoken = chordSpoken(tokens, platform)

  return (
    <div className="flex min-w-0 flex-col gap-1" data-voice-chord-recorder={recording ? 'recording' : 'idle'}>
      <div className="flex items-start justify-between gap-3 px-1 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] text-[color:var(--cl-foreground)]">Hold to talk</div>
          <div className="mt-0.5 text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
            {recording ? 'Hold the keys you want, then let go.' : 'Hold the shortcut, speak, then let go.'}
          </div>
        </div>
        {recording ? (
          <div className="flex min-w-0 shrink-0 flex-col items-end gap-1">
            <input
              ref={inputRef}
              type="text"
              readOnly
              value={live.length > 0 ? chordChips(live, platform).join(' ') : 'Recording…'}
              onKeyDown={onKeyDown}
              onKeyUp={onKeyUp}
              onBlur={() => active.current && stop(false)}
              aria-label="Hold to talk shortcut"
              aria-describedby={noteId}
              title="Hold the keys you want, then let go"
              className="no-drag cl-input font-ui w-[168px] cursor-pointer select-none border-[var(--cl-primary)] bg-[var(--cl-primary-soft)] px-2 py-1 text-[12px] text-[color:var(--cl-primary)] outline-none ring-1 ring-[var(--cl-primary)] transition-colors"
            />
            <span className="text-[11px] text-[color:var(--cl-muted-foreground)]">Esc cancels · Tab moves on</span>
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-1.5">
            <ChordChips tokens={tokens} platform={platform} id={chipsId} />
            <button
              ref={triggerRef}
              type="button"
              disabled={disabled}
              onClick={start}
              aria-describedby={chipsId}
              aria-label={`Change hold to talk shortcut, now ${spoken}`}
              className={`${TEXT_BUTTON} text-[color:var(--cl-primary)]`}
            >
              Change…
            </button>
            {!isDefault && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => onCommit(canonicalChord(defaultTokens))}
                className={`${TEXT_BUTTON} text-[color:var(--cl-muted-foreground)] hover:text-[color:var(--cl-foreground)]`}
              >
                Restore default
              </button>
            )}
          </div>
        )}
      </div>
      {/* Always mounted so a refusal is announced when it appears. */}
      <div id={noteId} aria-live="polite" className="px-1">
        {feedback && (
          <p
            className={[
              'm-0 flex items-start gap-1.5 text-[11px] leading-snug',
              feedback.kind === 'error'
                ? 'text-[color:var(--cl-destructive)]'
                : 'text-[color:var(--cl-muted-foreground)]'
            ].join(' ')}
          >
            {feedback.kind === 'error' && <AlertCircle size={12} className="mt-px shrink-0" aria-hidden />}
            <span>{feedback.text}</span>
          </p>
        )}
      </div>
      {!recording &&
        notes.map((note) => (
          <p key={note} className="m-0 px-1 text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
            {note}
          </p>
        ))}
    </div>
  )
}
