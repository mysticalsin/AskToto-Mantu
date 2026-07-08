import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Eye, EyeOff, AudioLines, Copy, Check, AlertTriangle } from 'lucide-react'
import type { TranscriptLine } from '@shared/ipc'
import { isScreenCapturePermissionError } from '@shared/screen-capture'
import type { AnswerState } from '../state'
import { Markdown } from './Markdown'
import { TextButton, Spinner } from './ui'
import { useFlash } from '../lib/useFlash'

// Cap on how many transcript lines render live in the copilot panel — see the comment above transcriptRows.
const TRANSCRIPT_RENDER_LIMIT = 150

/** One transcript bubble. Memoized so appending a new line only mounts/renders the new row — React.memo's
 *  default shallow-prop comparison is enough here because `line` is a stable, never-mutated object once
 *  committed (see listen.ts's commitLine), so every already-rendered row's props are referentially
 *  unchanged and its render is skipped entirely. */
const TranscriptRow = memo(function TranscriptRow({ line }: { line: TranscriptLine }): JSX.Element {
  return (
    <div className={line.speaker === 'you' ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={[
          'max-w-[82%] rounded-[var(--radius-xl)] px-3 py-1.5 text-[13px] leading-snug break-words',
          line.speaker === 'you'
            ? 'bg-[var(--color-accent-soft)] text-[color:var(--color-ink)]'
            : 'bg-white/[0.06] text-[color:var(--color-ink)]'
        ].join(' ')}
      >
        <span className="mr-1.5 text-[10px] font-semibold uppercase text-[color:var(--color-ink-3)]">
          {line.speaker === 'you' ? 'You' : line.speaker === 'them' ? 'Them' : 'Speaker'}
        </span>
        {line.text}
      </div>
    </div>
  )
})

export const Copilot = memo(function Copilot({
  lines,
  suggestion,
  listening,
  loading,
  loadingPct,
  error,
  captureNotice,
  autosaveWarning,
  showTranscript,
  onEnd: _onEnd
}: {
  lines: TranscriptLine[]
  suggestion: AnswerState | null
  mode: string
  listening: boolean
  loading: boolean
  loadingPct: number | null
  error: string | null
  /** Non-terminal notice that screen capture failed (Private View on, permission revoked) while the
   *  suggestion STILL streams from the transcript — shown as an amber strip above the card, not in place
   *  of the answer (mirrors Answer.tsx's captureNotice). */
  captureNotice?: string | null
  /** True after repeated autosave failures during a live meeting — a data-loss warning so the user can
   *  free disk / fix permissions before the meeting ends and the recap save also fails. */
  autosaveWarning?: boolean
  showTranscript: boolean
  onEnd: () => void
}): JSX.Element {
  const scroller = useRef<HTMLDivElement>(null)
  const [copied, flashCopied] = useFlash(1500)

  // The transcript only ever grows — remapping the WHOLE array to JSX on every render (a array-index key,
  // no memoization) meant every parent re-render (e.g. the old 1Hz `seconds` tick) re-diffed the entire
  // history instead of just the newest line. `l.t` (a Date.now() timestamp, set once per line — see
  // shared/ipc.ts TranscriptLine) is a stable identity for an existing line; `-${i}` guards the
  // theoretical case of two lines sharing the same millisecond without weakening the stability for the
  // common case (t never changes for an already-committed line).
  //
  // A long call can accumulate thousands of lines — rendering/diffing all of them live is dead weight
  // once the panel can only ever show a scrollable tail of it. Cap the LIVE render to the most recent
  // TRANSCRIPT_RENDER_LIMIT lines; the full transcript is still saved and viewable in the Review screen.
  const truncated = lines.length > TRANSCRIPT_RENDER_LIMIT
  const transcriptRows = useMemo(() => {
    const start = Math.max(0, lines.length - TRANSCRIPT_RENDER_LIMIT)
    const visible = lines.slice(start)
    // Each row is a memoized TranscriptRow keyed by its stable `t` timestamp plus its ABSOLUTE position in
    // `lines` (see the comment above) — keying by the slice-relative index instead would reshuffle every
    // row's key as the render-limit window slides forward, defeating TranscriptRow's memoization and
    // remounting the whole visible slice on every new line. `start + i` never changes for an
    // already-committed line, so React skips re-rendering every row whose `line` prop is unchanged.
    return visible.map((l, i) => <TranscriptRow key={`${l.t}-${start + i}`} line={l} />)
  }, [lines])

  // Transcript is hidden during the call; the bar's "Transcript" button drives showTranscript on demand.
  const showTx = showTranscript

  // The scroller section only mounts while showTx is true — depending on `lines` alone means opening it
  // mid-call (showTx flipping true with no new line arriving) leaves it scrolled to wherever it happened
  // to mount instead of the bottom. Re-run on showTx too so opening it always jumps to the latest line.
  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines, showTx])

  // Real flag (state.ts AnswerState.usedScreen), not a label string-match — robust even if a future
  // caller passes a different label alongside a screenshot-grounded answer.
  const isViewedScreen = !!suggestion?.usedScreen
  // Card wears accent fill/border only when there is actual content to show
  const cardHasContent = Boolean(suggestion?.text || suggestion?.streaming)

  const copyText = (): void => {
    const txt = suggestion?.text
    if (!txt) return
    navigator.clipboard
      .writeText(txt)
      .then(() => {
        flashCopied()
      })
      .catch(() => {})
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Capture-failure strip. Transcript-only suggestions remain available for transient failures, but
          a screen-permission denial stops the visual request until the user grants access and retries. */}
      {captureNotice && (
        <div
          role="status"
          className="flex flex-col items-start gap-1.5 rounded-lg border border-[var(--color-warn,#fac775)]/30 bg-[var(--color-warn,#fac775)]/10 px-3 py-2 text-[12px] leading-snug text-[color:var(--color-ink-2)] break-words [overflow-wrap:anywhere]"
        >
          <div className="flex items-start gap-1.5">
            <EyeOff size={13} className="mt-0.5 shrink-0 text-[color:var(--color-warn,#fac775)]" />
            <span>{captureNotice}</span>
          </div>
          {isScreenCapturePermissionError(captureNotice) && (
            <button
              type="button"
              onClick={() => void window.toto.openPermissionSettings('screenRecording')}
              className="no-drag focus-ring rounded-full bg-[var(--color-warn,#fac775)]/15 px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-ink)] hover:bg-[var(--color-warn,#fac775)]/25"
            >
              Open Screen Recording settings
            </button>
          )}
        </div>
      )}
      {/* Autosave data-loss warning — stronger (danger) treatment than the capture notice; the meeting is
          still recording but recent minutes may not be persisting. */}
      {autosaveWarning && (
        <div
          role="alert"
          className="flex items-start gap-1.5 rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-3 py-2 text-[12px] leading-snug text-[color:var(--color-danger)] break-words [overflow-wrap:anywhere]"
        >
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>Autosave is failing. Recent minutes may not be saved. Check free disk space and folder permissions.</span>
        </div>
      )}
      {/* Suggestion card — neutral at rest; accent fill/border only when content is present */}
      <section
        aria-live="polite"
        aria-atomic="false"
        className={[
          'rounded-[var(--radius-lg)] border px-3.5 py-3',
          cardHasContent
            ? 'border-[var(--color-accent)]/30 bg-[var(--color-accent-soft)]'
            : 'border-[var(--color-hair)] bg-white/[0.03]'
        ].join(' ')}
      >
        {/* No generic "Copilot" eyebrow — the card speaks for itself. Show only the meaningful "Viewed
            screen" context chip (so the user knows an answer was grounded in a screenshot), a subtle
            "still working" cue when a NEW action is loading while the PREVIOUS answer stays on screen
            (it never gets blanked between clicks — see state.ts's run()), and the copy button. */}
        {(isViewedScreen || suggestion?.text) && (
          <div className={['mb-1.5 flex items-center', isViewedScreen ? 'justify-between' : 'justify-end'].join(' ')}>
            {isViewedScreen && (
              <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink)]">
                <Eye size={12} />
                Viewed screen
              </div>
            )}
            <div className="flex items-center gap-1.5">
              {suggestion?.text && suggestion?.streaming && (
                <span className="flex items-center gap-1 text-[11px] text-[color:var(--color-ink-3)]">
                  <Spinner size={11} /> Updating…
                </span>
              )}
              {suggestion?.text && (
                <TextButton
                  ariaLabel={copied ? 'Copied' : 'Copy suggestion'}
                  onClick={copyText}
                >
                  {copied ? <Check size={11} className="text-[var(--color-success)]" /> : <Copy size={11} />}
                </TextButton>
              )}
            </div>
          </div>
        )}
        {suggestion?.error ? (
          <div className="text-[13px] text-[var(--color-danger)] break-words">{suggestion.error}</div>
        ) : suggestion?.text ? (
          <Markdown>{suggestion.text}</Markdown>
        ) : suggestion?.streaming ? (
          <div className="flex items-center justify-center gap-2 text-[13px] text-[color:var(--color-ink-2)]">
            <Spinner size={13} /> Thinking…
          </div>
        ) : (
          <div className="text-center text-[13px] leading-snug text-[color:var(--color-ink-2)]">
            {listening ? (
              'Pick an action below, or type a question.'
            ) : (
              <>
                Press the{' '}
                <AudioLines size={12} className="inline-block align-middle" />{' '}
                in the toolbar to start listening to your call.
              </>
            )}
          </div>
        )}
      </section>

      {/* Sticky listen error (silence/mic-lost/offline/reconnecting), the model-loading row, and the
          transcript are independent siblings, NOT a mutually-exclusive chain — a sticky error or a
          loading tick must not hide an already-open transcript (matches the captureNotice/autosaveWarning
          siblings above). Markup for each block is unchanged; only the conditions were decoupled. */}
      {error && (
        <div className="flex flex-col gap-1.5 text-[13px] text-[var(--color-danger)] break-words">
          <span>{error}</span>
          {/* Make a screen-capture permission error actionable. On macOS the IPC opens the System
              Settings pane; on Windows it opens the relevant system privacy settings. */}
          {isScreenCapturePermissionError(error) && (
            <button
              type="button"
              onClick={() => void window.toto.openPermissionSettings('screenRecording')}
              className="no-drag focus-ring w-fit rounded-full bg-[var(--color-danger)]/15 px-2.5 py-1 text-[11px] font-semibold text-[var(--color-danger)] hover:bg-[var(--color-danger)]/25"
            >
              Open Screen Recording settings
            </button>
          )}
          {/* Mirrors the Screen-Recording branch above for the mic-denied message (listen.ts's "Couldn't
              start the microphone…" / "Could not start the microphone…" / "mic access") —
              window.toto.openPermissionSettings is already wired for 'microphone' (used in Onboarding). */}
          {/start the microphone|microphone|mic access/i.test(error) && (
            <button
              type="button"
              onClick={() => void window.toto.openPermissionSettings('microphone')}
              className="no-drag focus-ring w-fit rounded-full bg-[var(--color-danger)]/15 px-2.5 py-1 text-[11px] font-semibold text-[var(--color-danger)] hover:bg-[var(--color-danger)]/25"
            >
              Open Microphone settings
            </button>
          )}
        </div>
      )}
      {loading && (
        <div className="flex items-center gap-2 text-[11px] text-[color:var(--color-ink-3)]">
          <Spinner size={11} />
          {loadingPct != null ? `Loading speech model… ${loadingPct}%` : 'Loading transcription model…'}
        </div>
      )}
      {/* Transcript — hidden during the call; shown only when the user opens it (bar → Transcript). */}
      {showTx && (
        <section>
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-[color:var(--color-ink-3)]">
            Transcript
          </div>
          {truncated && (
            <div className="mb-1.5 text-[11px] text-[color:var(--color-ink-3)]">
              Earlier lines are in the Review transcript
            </div>
          )}
          <div
            ref={scroller}
            className="scroll-thin flex max-h-[240px] flex-col gap-1.5 overflow-y-auto pr-1"
          >
            {lines.length === 0 ? (
              <div className="py-2 text-[13px] text-[color:var(--color-ink-2)]">
                {listening ? 'Waiting for speech…' : 'No audio yet.'}
              </div>
            ) : (
              transcriptRows
            )}
          </div>
        </section>
      )}
    </div>
  )
})
