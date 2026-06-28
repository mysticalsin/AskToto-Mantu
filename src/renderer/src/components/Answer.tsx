import { useState } from 'react'
import { Copy, Check, RefreshCw, FileDown } from 'lucide-react'
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

export function Answer({
  text,
  streaming,
  error,
  prompt,
  onRetry
}: {
  text: string
  streaming: boolean
  error: string | null
  prompt?: string
  onRetry?: () => void
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const saveNote = (): void => {
    if (!text) return
    window.toto
      .saveNote({ title: prompt || '', mode: 'general', question: prompt || '', answer: text })
      .then(() => {
        setSaved(true)
        setSaveError(null)
        setTimeout(() => setSaved(false), 1800)
      })
      .catch((e) => setSaveError(`Save failed: ${e instanceof Error ? e.message : String(e)}`))
  }
  const header = prompt ? (
    <div className="rounded-lg border border-[var(--color-hair-soft)] bg-white/[0.03] px-3 py-2 text-[13px] font-medium text-[color:var(--color-ink)]">
      {prompt}
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
  return (
    <div className="fade-up mx-auto max-w-[620px] flex flex-col gap-2">
      {header}
      <div aria-live="polite" aria-atomic="false" aria-busy={streaming}>
        <Markdown>{text}</Markdown>
        {streaming && (
          <span className="ml-0.5 inline-block h-[14px] w-[6px] translate-y-[2px] animate-pulse rounded-[1px] bg-[var(--color-accent)] align-middle" />
        )}
      </div>
      {footer}
    </div>
  )
}
