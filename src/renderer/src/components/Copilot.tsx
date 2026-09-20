import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Eye, EyeOff, AudioLines, Copy, Check, AlertTriangle } from 'lucide-react'
import type { TranscriptLine } from '@shared/ipc'
import { transcriptDisplayName } from '@shared/speaker-names'
import {
  groupTranscriptRows,
  isFollowingTail,
  newLinesLabel,
  transcriptElapsed,
  transcriptMaxHeight,
  type TranscriptRowModel
} from '../lib/transcript-view'
import { isScreenCapturePermissionError, needsAppRelaunchForScreenCapture } from '@shared/screen-capture'
import type { AnswerState } from '../state'
import { Markdown } from './Markdown'
import { TextButton } from './ui'
import { AgentStatus } from './AgentStatus'
import { useFlash } from '../lib/useFlash'

// Cap on how many transcript lines render live in the copilot panel — see the comment above transcriptRows.
const TRANSCRIPT_RENDER_LIMIT = 150

/** One transcript bubble. Memoized so appending a new line only mounts/renders the new row — React.memo's
 *  default shallow-prop comparison is enough here because `line` is a stable object once committed (see
 *  listen.ts's commitLine), so every already-rendered row's props are referentially unchanged and its
 *  render is skipped entirely. Two exceptions, both REPLACE the line with a new object rather than
 *  mutating it in place, so the identity change is exactly what tells this row to re-render: a provisional
 *  "…" placeholder gets swapped for the real committed line (listen.ts's clearProvisional/commitLine), and
 *  a Speaker Intelligence name can attach to an already-committed 'them' line slightly later (listen.ts's
 *  attachSpeakerName, Whisper-engine only). */
const TranscriptRow = memo(function TranscriptRow({
  row,
  youLabel,
  firstT
}: {
  row: TranscriptRowModel
  youLabel?: string | null
  firstT?: number
}): JSX.Element {
  const { line, startsGroup, endsGroup } = row
  const mine = line.speaker === 'you'
  const label = transcriptDisplayName(line, { youLabel })
  const at = startsGroup ? transcriptElapsed(line.t, firstT) : null
  return (
    <div
      className={[
        'flex flex-col',
        mine ? 'items-end' : 'items-start',
        // Space BETWEEN people, not between every sentence. A run by one speaker reads as one turn.
        startsGroup ? 'mt-2.5 first:mt-0' : 'mt-0.5'
      ].join(' ')}
    >
      {startsGroup && (
        <div
          className={[
            'mb-1 flex items-baseline gap-1.5 px-1 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]',
            mine ? 'flex-row-reverse' : ''
          ].join(' ')}
        >
          <span>{label}</span>
          {at && <span className="font-medium tabular-nums opacity-70">{at}</span>}
        </div>
      )}
      <div
        className={[
          'max-w-[88%] px-3 py-2 text-[13.5px] leading-[1.45] break-words [overflow-wrap:anywhere]',
          // Flatten only the corner on the speaker's own side, and only on the last bubble of the run:
          // that is what makes a group read as one turn with a tail rather than a stack of lozenges.
          mine
            ? 'rounded-[var(--radius-xl)] bg-[var(--color-accent-soft)] text-[color:var(--color-ink)]'
            : 'rounded-[var(--radius-xl)] bg-white/[0.06] text-[color:var(--color-ink)]',
          endsGroup ? (mine ? 'rounded-br-[6px]' : 'rounded-bl-[6px]') : '',
          // ASR quality (1B.2b) — a provisional line is a "…" placeholder for a window still decoding
          // (shared/ipc.ts TranscriptLineSchema.provisional). Fade it so it reads as pending, never as a
          // final transcribed line. It is replaced, not restyled, once the real text commits.
          line.provisional ? 'opacity-40' : ''
        ].join(' ')}
      >
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
  youLabel,
  onEnd: _onEnd
}: {
  lines: TranscriptLine[]
  suggestion: AnswerState | null
  mode: string
  listening: boolean
  loading: boolean
  loadingPct: number | null
  error: string | null
  /** Mic-side label from profile.name when set; honest "You" fallback when empty. */
  youLabel?: string | null
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
    // Grouping is computed over the VISIBLE slice, so the first row of the window always carries its
    // speaker label even when the run it belongs to started before the render limit.
    const firstT = visible[0]?.t
    return groupTranscriptRows(visible).map((row) => (
      <TranscriptRow
        key={`${row.line.t}-${start + row.index}`}
        row={row}
        youLabel={youLabel}
        firstT={firstT}
      />
    ))
  }, [lines, youLabel])

  // Transcript is hidden during the call; the bar's "Transcript" button drives showTranscript on demand.
  const showTx = showTranscript

  // The scroller section only mounts while showTx is true — depending on `lines` alone means opening it
  // mid-call (showTx flipping true with no new line arriving) leaves it scrolled to wherever it happened
  // to mount instead of the bottom. Re-run on showTx too so opening it always jumps to the latest line.
  // Opening the transcript always lands on the latest line. After that, an arriving line only moves the
  // view if the reader is still at the bottom: scrolling up to re-read something and being yanked back
  // by the next sentence made the transcript impossible to check mid-call. Lines that arrive while the
  // reader is up in the history are counted and offered as a pill instead.
  const [behindBy, setBehindBy] = useState(0)
  const lastCountRef = useRef(lines.length)

  useEffect(() => {
    const el = scroller.current
    if (!el || !showTx) return
    el.scrollTop = el.scrollHeight
    setBehindBy(0)
    lastCountRef.current = lines.length
    // Only on open: `lines` is deliberately absent so this does not re-run per arriving line.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showTx])

  useEffect(() => {
    const el = scroller.current
    if (!el || !showTx) return
    const arrived = Math.max(0, lines.length - lastCountRef.current)
    lastCountRef.current = lines.length
    if (isFollowingTail(el)) {
      el.scrollTop = el.scrollHeight
      setBehindBy(0)
    } else if (arrived > 0) {
      setBehindBy((n) => n + arrived)
    }
  }, [lines, showTx])

  const jumpToLatest = useCallback(() => {
    const el = scroller.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    setBehindBy(0)
  }, [])

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
          {isScreenCapturePermissionError(captureNotice) &&
            (needsAppRelaunchForScreenCapture(captureNotice) ? (
              <button
                type="button"
                onClick={() => void window.toto.relaunch()}
                className="no-drag focus-ring rounded-full bg-[var(--color-warn,#fac775)]/15 px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-ink)] hover:bg-[var(--color-warn,#fac775)]/25"
              >
                Restart Métis
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void window.toto.openPermissionSettings('screenRecording')}
                className="no-drag focus-ring rounded-full bg-[var(--color-warn,#fac775)]/15 px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-ink)] hover:bg-[var(--color-warn,#fac775)]/25"
              >
                Open Screen Recording settings
              </button>
            ))}
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
                <AgentStatus kind="working" size="inline" caption />
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
          <AgentStatus kind="thinking" size="hero" />
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
          {isScreenCapturePermissionError(error) &&
            (needsAppRelaunchForScreenCapture(error) ? (
              <button
                type="button"
                onClick={() => void window.toto.relaunch()}
                className="no-drag focus-ring w-fit rounded-full bg-[var(--color-danger)]/15 px-2.5 py-1 text-[11px] font-semibold text-[var(--color-danger)] hover:bg-[var(--color-danger)]/25"
              >
                Restart Métis
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void window.toto.openPermissionSettings('screenRecording')}
                className="no-drag focus-ring w-fit rounded-full bg-[var(--color-danger)]/15 px-2.5 py-1 text-[11px] font-semibold text-[var(--color-danger)] hover:bg-[var(--color-danger)]/25"
              >
                Open Screen Recording settings
              </button>
            ))}
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
        <AgentStatus
          kind="loading-model"
          size="inline"
          caption
          percent={loadingPct}
        />
      )}
      {/* Transcript — hidden during the call; shown only when the user opens it (bar → Transcript). */}
      {showTx && (
        <section className="flex min-h-0 flex-col">
          <div className="mb-1.5 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-[color:var(--color-ink-3)]">
            <span>Transcript</span>
            {listening && (
              <span className="flex items-center gap-1 normal-case tracking-normal text-[color:var(--color-ink-3)]">
                <span className="rec-dot" />
                live
              </span>
            )}
            <span className="flex-1" />
            {lines.length > 0 && (
              <span className="font-medium tabular-nums normal-case tracking-normal opacity-70">
                {lines.length} {lines.length === 1 ? 'line' : 'lines'}
              </span>
            )}
          </div>
          {truncated && (
            <div className="mb-1.5 text-[11px] text-[color:var(--color-ink-3)]">
              Earlier lines are in the Review transcript
            </div>
          )}
          {/* relative: the jump-to-latest pill floats over the tail of the scroller rather than
              displacing it, so arriving lines never shift the text the reader is looking at. */}
          <div className="relative min-h-0">
            <div
              ref={scroller}
              className="scroll-thin flex flex-col overflow-y-auto pr-1"
              style={{ maxHeight: transcriptMaxHeight() }}
            >
              {lines.length === 0 ? (
                <div className="py-3 text-[13px] text-[color:var(--color-ink-2)]">
                  {listening ? 'Waiting for speech…' : 'No audio yet.'}
                </div>
              ) : (
                transcriptRows
              )}
            </div>
            {behindBy > 0 && (
              <button
                type="button"
                onClick={jumpToLatest}
                aria-label={`Jump to latest, ${newLinesLabel(behindBy)}`}
                className="dock-pill-in no-drag focus-ring glass-chip absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full px-3 py-1 text-[11px] font-semibold text-[color:var(--color-ink)] shadow-lg transition-[background-color,transform] duration-[var(--duration-hover)] hover:brightness-110 active:scale-[0.97]"
              >
                {newLinesLabel(behindBy)} ↓
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  )
})
