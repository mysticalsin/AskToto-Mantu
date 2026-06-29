import { useEffect, useRef, useState } from 'react'
import {
  Sparkles,
  Eye,
  ShieldCheck,
  MessageSquareQuote,
  Copy,
  Check,
  ChevronDown,
  ChevronRight
} from 'lucide-react'
import type { TranscriptLine } from '@shared/ipc'
import type { AnswerState } from '../state'
import { Markdown } from './Markdown'
import { Spinner } from './ui'

function Action({
  icon: Icon,
  label,
  onClick,
  primary
}: {
  icon: typeof Sparkles
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
  listening,
  loading,
  loadingPct,
  error,
  showTranscript,
  onAssist,
  onWhatNext,
  onFactCheck,
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
  onAssist: () => void
  onWhatNext: () => void
  onFactCheck: () => void
  onEnd: () => void
}): JSX.Element {
  const scroller = useRef<HTMLDivElement>(null)
  const [viewTx, setViewTx] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  const showTx = showTranscript || viewTx

  const isViewedScreen = suggestion?.label === 'Viewed screen'
  const EyebrowIcon = isViewedScreen ? Eye : Sparkles
  const eyebrowLabel = suggestion?.label || 'Assist'

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
      {/* Suggestion card */}
      <section aria-live="polite" aria-atomic="false" className="rounded-xl border-l-2 border-[var(--color-accent)] bg-[var(--color-accent-soft)] px-3.5 py-3">
        <div className="mb-1.5 flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink)]">
            <EyebrowIcon size={12} />
            {eyebrowLabel}
          </div>
          <div className="flex items-center gap-1">
            {suggestion?.text && (
              <button
                type="button"
                aria-label={copied ? 'Copied' : 'Copy suggestion'}
                onClick={copyText}
                className="no-drag focus-ring flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-[color:var(--color-ink-2)] hover:bg-white/10 hover:text-[color:var(--color-ink)]"
              >
                {copied ? <Check size={11} className="text-[var(--color-success)]" /> : <Copy size={11} />}
              </button>
            )}
            <button
              type="button"
              aria-label="Assist"
              onClick={onAssist}
              className="no-drag focus-ring flex items-center gap-1.5 rounded-full bg-[var(--color-accent)] px-2.5 py-1 text-[11px] font-medium text-white hover:brightness-110"
            >
              <Sparkles size={11} />
              Assist
            </button>
          </div>
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
              ? 'Press Assist for a read of the conversation, or type a question.'
              : 'Press Listen to start.'}
          </div>
        )}
      </section>

      {/* Secondary action row */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Action icon={MessageSquareQuote} label="What to say next" onClick={onWhatNext} />
        <Action icon={ShieldCheck} label="Fact-check" onClick={onFactCheck} />
      </div>

      {/* Status / transcript */}
      {error ? (
        <div className="text-[13px] text-[var(--color-danger)]">{error}</div>
      ) : showTx ? (
        <section>
          <div className="mb-1.5 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-[color:var(--color-ink-3)]">
              Transcript
              {loading && <span className="normal-case">· loading model…</span>}
            </div>
            {listening && (
              <button
                type="button"
                onClick={() => setViewTx(false)}
                className="no-drag focus-ring flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-[color:var(--color-ink-3)] hover:text-[color:var(--color-ink-2)]"
              >
                Hide transcript <ChevronDown size={11} />
              </button>
            )}
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
        <div className="flex items-center justify-between text-[11px] text-[color:var(--color-ink-3)]">
          <div className="flex items-center gap-2">
            {loading ? (
              <>
                <Spinner size={11} />{' '}
                {loadingPct != null ? `downloading speech model… ${loadingPct}%` : 'loading transcription model…'}
              </>
            ) : (
              <>
                {listening && <span className="rec-dot h-[6px] w-[6px] rounded-full bg-[var(--color-danger)]" />}
                {listening
                  ? `live · ${lines.length} captured`
                  : 'not listening'}
              </>
            )}
          </div>
          {listening && !loading && (
            <button
              type="button"
              onClick={() => setViewTx(true)}
              className="no-drag focus-ring flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:text-[color:var(--color-ink-2)]"
            >
              View transcript <ChevronRight size={11} />
            </button>
          )}
        </div>
      )}
    </div>
  )
}
