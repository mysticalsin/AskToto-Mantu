import { useState } from 'react'
import { Copy, Check, RefreshCw, FileDown, ShieldCheck, ChevronsDown, ThumbsUp, ThumbsDown, Eye } from 'lucide-react'
import { Markdown } from './Markdown'

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
  MISLEADING: { label: 'Misleading', chip: 'bg-amber-400/15 text-amber-400 border-amber-400/30' },
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
  if (/invalid.*(key|api)|incorrect api key|unauthor|\b401\b|expired/.test(e)) return 'Your API key may be invalid or expired. Update it in Settings → Your AI.'
  if (/timed out|timeout|no response/.test(e)) return 'The model took too long. Retry, or pick a faster tier in Settings → Thinking mode.'
  if (/network|fetch failed|enotfound|econnrefused|getaddrinfo|offline|dns/.test(e)) return 'Looks like a network problem. Check your connection, then retry.'
  if (/quota|insufficient|billing|credit|payment/.test(e)) return 'The provider reports a quota or billing issue. Check your account, or switch providers in Settings.'
  if (/can.?t read screen|vision|screenshot/.test(e)) return "This provider can't read screens. Switch to Claude or GPT in Settings."
  return null
}

export function Answer({
  text,
  streaming,
  error,
  prompt,
  label,
  kind,
  onRetry,
  onGoDeeper
}: {
  text: string
  streaming: boolean
  error: string | null
  prompt?: string
  label?: string
  kind?: 'answer' | 'factcheck'
  onRetry?: () => void
  onGoDeeper?: () => void
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [rated, setRated] = useState<'up' | 'down' | null>(null)

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
        setSaved(true)
        setSaveError(null)
        setTimeout(() => setSaved(false), 1800)
      })
      .catch((e) => setSaveError(`Save failed: ${e instanceof Error ? e.message : String(e)}`))
  }
  // Show the user-facing label (the claim/question) — NEVER the engineered `prompt` scaffold. For plain
  // asks the typed question IS the prompt, so it falls back to that; engineered callers pass a clean label.
  const display = label ?? prompt
  // "Viewed screen" context chip — the trust signal: it tells the user the answer was grounded in what
  // was on their screen (the screen-ask path tags the answer with this label). A live purple dot + Eye.
  const screenContext = label === 'Viewed screen'
  const header = screenContext ? (
    <div className="flex w-fit items-center gap-1.5 rounded-full border border-[var(--color-accent)]/30 bg-[var(--color-accent-soft)] px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-ink-2)]">
      <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent-2)] shadow-[0_0_6px_var(--color-accent-2)]" />
      <Eye size={12} /> Viewed screen
    </div>
  ) : display ? (
    <div className="rounded-lg border border-[var(--color-hair-soft)] bg-white/[0.03] px-3 py-2 text-[13px] font-medium text-[color:var(--color-ink)]">
      {kind === 'factcheck' && (
        <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
          <ShieldCheck size={11} /> Fact-check
        </div>
      )}
      {display}
    </div>
  ) : null

  const copy = (): void => {
    if (!text) return
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true)
        setCopyError(null)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e)
        setCopyError(`Copy failed: ${msg}`)
      })
  }

  const footer = !streaming && (text || error) ? (
    <div className="mt-1 flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={copy}
          disabled={!text}
          className="no-drag focus-ring flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-[color:var(--color-ink-2)] hover:bg-white/10 hover:text-[color:var(--color-ink)] disabled:opacity-40"
        >
          {copied ? <Check size={11} className="text-[var(--color-success)]" /> : <Copy size={11} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
        {text && (
          <button
            type="button"
            onClick={saveNote}
            title="Save this answer as a markdown note"
            className="no-drag focus-ring flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-[color:var(--color-ink-2)] hover:bg-white/10 hover:text-[color:var(--color-ink)]"
          >
            {saved ? <Check size={11} className="text-[var(--color-success)]" /> : <FileDown size={11} />}
            {saved ? 'Saved' : 'Save note'}
          </button>
        )}
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="no-drag focus-ring flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-[color:var(--color-ink-2)] hover:bg-white/10 hover:text-[color:var(--color-ink)]"
          >
            <RefreshCw size={11} /> Retry
          </button>
        )}
        {text && onGoDeeper && kind !== 'factcheck' && (
          <button
            type="button"
            onClick={onGoDeeper}
            title="Re-answer with more depth and detail"
            className="no-drag focus-ring flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-[color:var(--color-ink-2)] hover:bg-white/10 hover:text-[color:var(--color-ink)]"
          >
            <ChevronsDown size={11} /> Go deeper
          </button>
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
        <div className="rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-2 py-1 text-[11px] text-[var(--color-danger)]">
          {saveError}
        </div>
      )}
      {copyError && (
        <div className="rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-2 py-1 text-[11px] text-[var(--color-danger)]">
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
        <div className="rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2.5 text-[13px] text-[var(--color-danger)]">
          {error}
          {hint && (
            <div className="mt-1.5 text-[12px] leading-snug text-[color:var(--color-ink-2)]">{hint}</div>
          )}
        </div>
        {footer}
      </div>
    )
  }
  if (!text && streaming) {
    return (
      <div className="fade-up mx-auto max-w-[620px] flex flex-col gap-2">
        {header}
        {/* Reasoning models (e.g. Kimi Code) think before the first token — show it's working, not stuck. */}
        <div className="flex items-center gap-1.5 text-[12px] text-[color:var(--color-ink-2)]">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-accent)]" />
          Thinking…
        </div>
        <Skeleton />
      </div>
    )
  }
  if (!text) {
    return (
      <div className="fade-up mx-auto max-w-[620px] flex flex-col gap-2">
        {header}
        <div className="rounded-lg border border-[var(--color-hair-soft)] bg-white/[0.03] px-3 py-6 text-center text-[13px] text-[color:var(--color-ink-2)]">
          Ask a question or press ⌘⇧S to capture your screen.
        </div>
      </div>
    )
  }
  const verdict = kind === 'factcheck' ? parseVerdict(text) : null
  return (
    <div className="fade-up mx-auto max-w-[620px] flex flex-col gap-2">
      {header}
      <div aria-live="polite" aria-atomic="false" aria-busy={streaming}>
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
}
