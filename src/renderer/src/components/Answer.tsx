import { useState } from 'react'
import { Copy, Check, RefreshCw, FileDown, ShieldCheck, ChevronsDown } from 'lucide-react'
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
  const header = display ? (
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
    return (
      <div className="fade-up mx-auto max-w-[620px] flex flex-col gap-2">
        {header}
        <div className="rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2.5 text-[13px] text-[var(--color-danger)]">
          {error}
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
