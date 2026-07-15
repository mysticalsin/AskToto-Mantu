import { memo, useEffect, useState } from 'react'
import { Copy, Check, RefreshCw, FileDown, ShieldCheck, ChevronsDown, ThumbsUp, ThumbsDown, Eye, EyeOff } from 'lucide-react'
import { PROVIDERS, type ProviderId } from '@shared/providers'
import { isScreenCapturePermissionError } from '@shared/screen-capture'
import { Markdown } from './Markdown'
import { TextButton } from './ui'
import { useFlash } from '../lib/useFlash'
import { accelLabel } from '../lib/keys'

function Skeleton(): JSX.Element {
  return (
    <div className="flex flex-col gap-2 py-1">
      <div className="shimmer h-3 w-[72%]" />
      <div className="shimmer h-3 w-[90%]" />
      <div className="shimmer h-3 w-[54%]" />
    </div>
  )
}

/** A fact-check verdict: parse a leading "VERDICT: <X>" line; the rest is the bulleted reasoning. */
const VERDICTS: Record<string, { label: string; chip: string }> = {
  TRUE: { label: 'True', chip: 'bg-[var(--color-success)]/15 text-[var(--color-success)] border-[var(--color-success)]/30' },
  FALSE: { label: 'False', chip: 'bg-[var(--color-danger)]/15 text-[var(--color-danger)] border-[var(--color-danger)]/30' },
  MISLEADING: { label: 'Misleading', chip: 'bg-[var(--color-danger)]/10 text-[color:var(--color-danger)] border-[var(--color-danger)]/25' },
  UNVERIFIABLE: { label: 'Unverifiable', chip: 'bg-white/[0.06] text-[color:var(--color-ink-2)] border-[var(--color-hair-soft)]' }
}
function parseVerdict(text: string): { key: string; rest: string } | null {
  const m = text.match(/VERDICT:\s*(TRUE|FALSE|MISLEADING|UNVERIFIABLE)\b/i)
  if (!m) return null
  return { key: m[1].toUpperCase(), rest: text.slice((m.index ?? 0) + m[0].length).replace(/^[\s:.-]*/, '') }
}

/** Turn a raw provider error into one actionable line of recovery coaching (section B failure states). */
function errorHint(error: string): string | null {
  const e = error.toLowerCase()
  if (/rate.?limit|\b429\b|too many request/.test(e)) return 'The provider is rate-limiting you. Wait a moment, or switch providers in Settings.'
  if (/invalid.*(key|api)|incorrect api key|unauthor|\b401\b|expired/.test(e)) return 'Your API key may be invalid or expired. Update it in Settings → AI.'
  if (/timed out|timeout|no response/.test(e)) return 'The model took too long. Retry, or pick a faster tier in Settings → Thinking mode.'
  if (/network|fetch failed|enotfound|econnrefused|getaddrinfo|offline|dns/.test(e)) return 'Looks like a network problem. Check your connection, then retry.'
  if (/quota|insufficient|billing|credit|payment/.test(e)) return 'The provider reports a quota or billing issue. Check your account, or switch providers in Settings.'
  // No hint for the vision/screenshot case: the raw error ("… can't read screenshots. Switch to Claude
  // or GPT in Settings, or ask without a screen capture.") is already complete — a hint duplicates it.
  return null
}

export const Answer = memo(function Answer({
  text,
  streaming,
  error,
  captureNotice,
  prompt,
  label,
  kind,
  usedScreen,
  provider,
  onRetry,
  onGoDeeper
}: {
  text: string
  streaming: boolean
  error: string | null
  /** Non-terminal notice that screen capture failed. Private View and transient capture failures may
   *  still have a text/context answer below; a denied screen permission instead waits for the user to
   *  grant access and retry. */
  captureNotice?: string | null
  prompt?: string
  label?: string
  kind?: 'answer' | 'factcheck'
  /** True when this answer was grounded in a screenshot — drives the "Viewed screen" trust chip
   *  independent of the displayed label/question (see state.ts AnswerState.usedScreen). */
  usedScreen?: boolean
  /** Who is answering (from streamMeta) — names the brain in the waiting state instead of an anonymous
   *  spinner ("Asking your Dust agent…"). */
  provider?: ProviderId
  onRetry?: () => void
  onGoDeeper?: () => void
}): JSX.Element {
  const [copied, flashCopied] = useFlash(1500)
  const [copyError, setCopyError] = useState<string | null>(null)
  const [saved, flashSaved] = useFlash(1800)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [rated, setRated] = useState<'up' | 'down' | null>(null)

  // Elapsed-time-aware "Thinking…" message. Some providers (Dust) take ~40-48s to first token — the same
  // static label for that whole window reads as stuck rather than working. Ticks only while the thinking
  // branch (!text && streaming) is actually showing; resets the moment it isn't, so the next request starts
  // from 0 rather than inheriting a stale count.
  const thinking = !text && streaming
  const [thinkingSecs, setThinkingSecs] = useState(0)
  useEffect(() => {
    if (!thinking) {
      setThinkingSecs(0)
      return
    }
    const iv = setInterval(() => setThinkingSecs((s) => s + 1), 1000)
    return () => clearInterval(iv)
  }, [thinking])

  // Record the user's verdict on this answer. Metadata only (rating + kind) → audit log; no content sent.
  const rate = (r: 'up' | 'down'): void => {
    setRated(r)
    void window.toto.answerFeedback({ rating: r, kind: kind ?? 'answer' })
  }

  const saveNote = (): void => {
    if (!text) return
    // Save the user-facing label (the claim/question), NEVER the engineered prompt scaffold + guard line.
    const noteTitle = label || prompt || ''
    window.toto
      .saveNote({ title: noteTitle, mode: 'general', question: noteTitle, answer: text })
      .then(() => {
        flashSaved()
        setSaveError(null)
      })
      .catch((e) => setSaveError(`Save failed: ${e instanceof Error ? e.message : String(e)}`))
  }
  // Show the user-facing label (the claim/question) — NEVER the engineered `prompt` scaffold. For plain
  // asks the typed question IS the prompt, so it falls back to that; engineered callers pass a clean label.
  const display = label ?? prompt
  // "Viewed screen" trust signal: the answer was grounded in a screenshot (state.ts AnswerState.usedScreen,
  // set from req.mode === 'vision' — independent of what's displayed, so a real typed question can show as
  // the header AND still carry this badge). When there's nothing else to show (a blank-Enter screen-ask),
  // the badge stands alone as its own header row; otherwise it's a small eyebrow above the real question.
  const screenContext = !!usedScreen && !display
  const header = screenContext ? (
    <div className="flex w-fit items-center gap-1.5 rounded-full border border-[var(--color-accent)]/30 bg-[var(--color-accent-soft)] px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-ink-2)]">
      <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent-2)] shadow-[0_0_6px_var(--color-accent-2)]" />
      <Eye size={12} /> Viewed screen
    </div>
  ) : display ? (
    <div className="rounded-lg border border-[var(--color-hair-soft)] bg-white/[0.03] px-3 py-2 text-[13px] font-medium text-[color:var(--color-ink)] break-words">
      {kind === 'factcheck' && (
        <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
          <ShieldCheck size={11} /> Fact-check
        </div>
      )}
      {usedScreen && (
        <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
          <Eye size={11} /> Viewed screen
        </div>
      )}
      {display}
    </div>
  ) : null

  // Capture-failure banner. It is amber because it reports a recoverable access/capture condition rather
  // than a model failure. Permission-denied visual asks intentionally stop here until the user retries.
  const notice = captureNotice ? (
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
  ) : null

  const copy = (): void => {
    if (!text) return
    navigator.clipboard
      .writeText(text)
      .then(() => {
        flashCopied()
        setCopyError(null)
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e)
        setCopyError(`Copy failed: ${msg}`)
      })
  }

  const footer = !streaming && (text || error) ? (
    <div className="mt-1 flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <TextButton onClick={copy} disabled={!text}>
          {copied ? <Check size={11} className="text-[var(--color-success)]" /> : <Copy size={11} />}
          {copied ? 'Copied' : 'Copy'}
        </TextButton>
        {text && (
          <TextButton onClick={saveNote} title="Save this answer as a markdown note">
            {saved ? <Check size={11} className="text-[var(--color-success)]" /> : <FileDown size={11} />}
            {saved ? 'Saved' : 'Save note'}
          </TextButton>
        )}
        {onRetry && <TextButton icon={RefreshCw} onClick={onRetry}>Retry</TextButton>}
        {text && onGoDeeper && kind !== 'factcheck' && (
          <TextButton icon={ChevronsDown} onClick={onGoDeeper} title="Re-answer with more depth and detail">Go deeper</TextButton>
        )}
        {text && (
          <div className="ml-auto flex items-center gap-0.5" title="Was this useful?">
            <button
              type="button"
              aria-label="Good answer"
              onClick={() => rate('up')}
              className={[
                'no-drag focus-ring flex items-center rounded-md p-1 transition-colors',
                rated === 'up'
                  ? 'text-[color:var(--color-success)]'
                  : 'text-[color:var(--color-ink-3)] hover:bg-white/10 hover:text-[color:var(--color-ink)]'
              ].join(' ')}
            >
              <ThumbsUp size={11} />
            </button>
            <button
              type="button"
              aria-label="Bad answer"
              onClick={() => rate('down')}
              className={[
                'no-drag focus-ring flex items-center rounded-md p-1 transition-colors',
                rated === 'down'
                  ? 'text-[color:var(--color-danger)]'
                  : 'text-[color:var(--color-ink-3)] hover:bg-white/10 hover:text-[color:var(--color-ink)]'
              ].join(' ')}
            >
              <ThumbsDown size={11} />
            </button>
          </div>
        )}
      </div>
      {saveError && (
        <div role="alert" className="rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-2 py-1 text-[11px] text-[var(--color-danger)]">
          {saveError}
        </div>
      )}
      {copyError && (
        <div role="alert" className="rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-2 py-1 text-[11px] text-[var(--color-danger)]">
          {copyError}
        </div>
      )}
    </div>
  ) : null

  if (error) {
    const hint = errorHint(error)
    return (
      <div className="fade-up mx-auto max-w-[620px] flex flex-col gap-2">
        {header}
        {notice}
        <div role="alert" className="rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2.5 text-[13px] text-[var(--color-danger)] break-words [overflow-wrap:anywhere]">
          {error}
          {hint && (
            <div className="mt-1.5 text-[12px] leading-snug text-[color:var(--color-ink-2)] break-words [overflow-wrap:anywhere]">{hint}</div>
          )}
        </div>
        {footer}
      </div>
    )
  }
  if (thinking) {
    // Reasoning models (e.g. Kimi Code) think before the first token, and Dust specifically can take
    // ~40-48s to first token — past ~8s, swap the static label for an elapsed-time count so a long wait
    // still reads as "working" instead of "stuck". Naming the brain ("Asking your Dust agent…") makes the
    // wait attributable instead of anonymous — users forgive an agent working, not a frozen spinner.
    const who = provider === 'dust' ? 'your Dust agent' : provider ? PROVIDERS[provider]?.label : undefined
    const label =
      thinkingSecs >= 8
        ? `Still working… (${thinkingSecs}s)${who ? ` — ${who} is on it` : ''}`
        : who
          ? `Asking ${who}…`
          : 'Thinking…'
    return (
      <div className="fade-up mx-auto max-w-[620px] flex flex-col gap-2">
        {header}
        {notice}
        <div className="flex items-center gap-1.5 text-[12px] text-[color:var(--color-ink-2)]">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-accent)]" />
          {label}
        </div>
        <Skeleton />
      </div>
    )
  }
  if (!text) {
    return (
      <div className="fade-up mx-auto max-w-[620px] flex flex-col gap-2">
        {header}
        {notice}
        <div className="rounded-lg border border-[var(--color-hair-soft)] bg-white/[0.03] px-3 py-6 text-center text-[13px] text-[color:var(--color-ink-2)]">
          Ask a question or press {accelLabel('CommandOrControl+Shift+S')} to capture your screen.
        </div>
      </div>
    )
  }
  const verdict = kind === 'factcheck' ? parseVerdict(text) : null
  return (
    <div className="fade-up mx-auto max-w-[620px] flex flex-col gap-2">
      {header}
      {notice}
      <div className="develop-in" aria-live="polite" aria-atomic="false" aria-busy={streaming}>
        {verdict ? (
          <div className="flex flex-col gap-2">
            <span
              className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-semibold ${VERDICTS[verdict.key].chip}`}
            >
              {VERDICTS[verdict.key].label}
            </span>
            <Markdown>{verdict.rest}</Markdown>
          </div>
        ) : kind === 'factcheck' && streaming ? (
          // Hide the raw "VERDICT:" scaffold from view until the verdict word streams in and parses.
          <div className="flex items-center gap-1.5 text-[12px] text-[color:var(--color-ink-2)]">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-accent)]" /> Checking…
          </div>
        ) : (
          <Markdown>{text}</Markdown>
        )}
        {streaming && (
          <span className="ml-0.5 inline-block h-[14px] w-[6px] translate-y-[2px] animate-pulse rounded-[1px] bg-[var(--color-accent)] align-middle" />
        )}
      </div>
      {footer}
    </div>
  )
})
