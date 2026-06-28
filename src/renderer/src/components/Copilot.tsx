import { useEffect, useRef } from 'react'
import {
  Sparkles,
  Wand2,
  ShieldCheck,
  MessageCircleQuestion,
  MessageSquareQuote,
  FileText
} from 'lucide-react'
import type { ConversationMode, TranscriptLine } from '@shared/ipc'
import type { AnswerState } from '../state'
import { Markdown } from './Markdown'
import { Spinner } from './ui'

const SUGGEST_LABEL: Record<ConversationMode, string> = {
  interview: 'Say this',
  meeting: 'Suggested point',
  sales: 'Next move',
  negotiation: 'Your move',
  presentation: 'Say next',
  support: 'Respond with',
  general: 'Suggestion'
}

function Action({
  icon: Icon,
  label,
  onClick,
  primary
}: {
  icon: typeof Wand2
  label: string
  onClick: () => void
  primary?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={[
        'no-drag focus-ring flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors duration-[var(--duration-hover)]',
        primary
          ? 'bg-[var(--color-accent)] text-white hover:brightness-110'
          : 'bg-white/[0.06] text-[color:var(--color-ink-2)] hover:bg-white/[0.12] hover:text-[color:var(--color-ink)]'
      ].join(' ')}
    >
      <Icon size={13} />
      {label}
    </button>
  )
}

export function Copilot({
  lines,
  suggestion,
  mode,
  listening,
  loading,
  error,
  showTranscript,
  onAnswer,
  onWhatNext,
  onFactCheck,
  onAsk,
  onEnd
}: {
  lines: TranscriptLine[]
  suggestion: AnswerState | null
  mode: ConversationMode
  listening: boolean
  loading: boolean
  error: string | null
  showTranscript: boolean
  onAnswer: () => void
  onWhatNext: () => void
  onFactCheck: () => void
  onAsk: () => void
  onEnd: () => void
}): JSX.Element {
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    // Only stick to the bottom if the user is already near it — don't yank them down while they scroll up
    // to re-read earlier lines mid-meeting.
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 48) el.scrollTop = el.scrollHeight
  }, [lines])

  return (
    <div className="flex flex-col gap-3">
      {/* What to say — the only content shown live */}
      <section aria-live="polite" aria-atomic="false" className="rounded-xl border-l-2 border-[var(--color-accent)] bg-[var(--color-accent-soft)] px-3.5 py-3">
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink)]">
          <Sparkles size={12} />
          {SUGGEST_LABEL[mode]}
        </div>
        {suggestion?.error ? (
          <div className="text-[13px] text-[var(--color-danger)]">{suggestion.error}</div>
        ) : suggestion?.text ? (
          <Markdown>{suggestion.text}</Markdown>
        ) : suggestion?.streaming ? (
          <div className="flex items-center gap-2 text-[13px] text-[color:var(--color-ink-2)]">
            <Spinner size={13} /> thinking…
          </div>
        ) : (
          <div className="text-[13px] text-[color:var(--color-ink-2)]">
            {listening
              ? mode === 'interview'
                ? 'When the interviewer asks something, your answer appears here. Or tap Answer now.'
                : 'Suggestions appear as the conversation develops. Or tap Answer now.'
              : 'Press Listen to start your live copilot.'}
          </div>
        )}
      </section>

      {/* In-meeting actions (Cluely-style) */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Action icon={Wand2} label="Answer now" onClick={onAnswer} primary />
        <Action icon={MessageSquareQuote} label="What to say next" onClick={onWhatNext} />
        <Action icon={ShieldCheck} label="Fact-check" onClick={onFactCheck} />
        <Action icon={MessageCircleQuestion} label="Ask" onClick={onAsk} />
        <Action icon={FileText} label="End & review" onClick={onEnd} />
      </div>

      {/* Status / transcript */}
      {error ? (
        <div className="text-[13px] text-[var(--color-danger)]">{error}</div>
      ) : showTranscript ? (
        <section>
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-[color:var(--color-ink-3)]">
            Transcript
            {loading && <span className="normal-case">· loading model…</span>}
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
      ) : (
        <div className="flex items-center gap-2 text-[11px] text-[color:var(--color-ink-3)]">
          {loading ? (
            <>
              <Spinner size={11} /> loading transcription model…
            </>
          ) : (
            <>
              {listening && <span className="rec-dot h-[6px] w-[6px] rounded-full bg-[var(--color-danger)]" />}
              {listening
                ? `live · ${lines.length} captured · transcript saved for the end`
                : 'not listening'}
            </>
          )}
        </div>
      )}
    </div>
  )
}
