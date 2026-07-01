import { useEffect, useRef, useState } from 'react'
import { Eye, Mic, Copy, Check } from 'lucide-react'
import type { TranscriptLine } from '@shared/ipc'
import type { AnswerState } from '../state'
import { Markdown } from './Markdown'
import { TextButton, Spinner } from './ui'

export function Copilot({
  lines,
  suggestion,
  listening,
  loading,
  loadingPct,
  error,
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
  showTranscript: boolean
  onEnd: () => void
}): JSX.Element {
  const scroller = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  // Transcript is hidden during the call; the bar's "Transcript" button drives showTranscript on demand.
  const showTx = showTranscript

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
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }

  return (
    <div className="flex flex-col gap-3">
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
          <div className="text-[13px] text-[var(--color-danger)]">{suggestion.error}</div>
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
                <Mic size={12} className="inline-block align-middle" />{' '}
                in the toolbar to start listening to your call.
              </>
            )}
          </div>
        )}
      </section>

      {/* Transcript — hidden during the call; shown only when the user opens it (bar → Transcript). A
          small loading line appears while the speech model warms up; no live "N captured" footer. */}
      {error ? (
        <div className="text-[13px] text-[var(--color-danger)]">{error}</div>
      ) : loading ? (
        <div className="flex items-center gap-2 text-[11px] text-[color:var(--color-ink-3)]">
          <Spinner size={11} />
          {loadingPct != null ? `Loading speech model… ${loadingPct}%` : 'Loading transcription model…'}
        </div>
      ) : showTx ? (
        <section>
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-[color:var(--color-ink-3)]">
            Transcript
          </div>
          <div
            ref={scroller}
            className="scroll-thin flex max-h-[240px] flex-col gap-1.5 overflow-y-auto pr-1"
          >
            {lines.length === 0 ? (
              <div className="py-2 text-[13px] text-[color:var(--color-ink-2)]">
                {listening ? 'Waiting for speech…' : 'No audio yet.'}
              </div>
            ) : (
              lines.map((l, i) => (
                <div key={i} className={l.speaker === 'you' ? 'flex justify-end' : 'flex justify-start'}>
                  <div
                    className={[
                      'max-w-[82%] rounded-[var(--radius-xl)] px-3 py-1.5 text-[13px] leading-snug',
                      l.speaker === 'you'
                        ? 'bg-[var(--color-accent-soft)] text-[color:var(--color-ink)]'
                        : 'bg-white/[0.06] text-[color:var(--color-ink)]'
                    ].join(' ')}
                  >
                    <span className="mr-1.5 text-[10px] font-semibold uppercase text-[color:var(--color-ink-3)]">
                      {l.speaker === 'you' ? 'You' : 'Them'}
                    </span>
                    {l.text}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      ) : null}
    </div>
  )
}
