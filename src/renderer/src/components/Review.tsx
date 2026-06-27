import { useEffect, useMemo, useState } from 'react'
import { Copy, Check, FileText, ListTree, FolderOpen, Save, RotateCcw } from 'lucide-react'
import type { TranscriptLine } from '@shared/ipc'
import type { AnswerState } from '../state'
import { Markdown } from './Markdown'
import { Spinner } from './ui'

function clock(t: number): string {
  try {
    return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return ''
  }
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function Review({
  recap,
  lines,
  savedPath,
  saveError,
  saveAttempts,
  maxSaveAttempts,
  startedAt,
  onOpenFolder,
  onSave,
  onDone
}: {
  recap: AnswerState | null
  lines: TranscriptLine[]
  savedPath: string | null
  saveError: string | null
  saveAttempts?: number
  maxSaveAttempts?: number
  startedAt?: number
  onOpenFolder: () => void
  onSave?: () => void
  onDone?: () => void
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const plain = useMemo(
    () =>
      lines
        .map((l) => `[${clock(l.t)}] ${l.speaker === 'them' ? 'Them' : 'You'}: ${l.text}`)
        .join('\n'),
    [lines]
  )

  const durationSec = useMemo(() => {
    if (lines.length > 1) {
      const times = lines.map((l) => l.t)
      return Math.floor((Math.max(...times) - Math.min(...times)) / 1000)
    }
    if (startedAt) return Math.floor((now - startedAt) / 1000)
    return 0
  }, [lines, startedAt, now])

  const participants = useMemo(() => new Set(lines.map((l) => l.speaker)).size, [lines])

  const [copyError, setCopyError] = useState<string | null>(null)

  const copy = (): void => {
    navigator.clipboard
      .writeText(plain)
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

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 text-[11px] text-[color:var(--color-ink-2)]">
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-white/[0.06] px-2 py-0.5">Duration {formatDuration(durationSec)}</span>
          <span className="rounded-full bg-white/[0.06] px-2 py-0.5">
            {participants} participant{participants === 1 ? '' : 's'}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {onSave && (
            <button
              type="button"
              onClick={onSave}
              disabled={lines.length === 0 || !!savedPath}
              className="no-drag focus-ring flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-[color:var(--color-ink-2)] hover:bg-white/10 hover:text-[color:var(--color-ink)] disabled:opacity-40"
            >
              <Save size={11} /> Save
            </button>
          )}
          {onDone && (
            <button
              type="button"
              onClick={onDone}
              className="no-drag focus-ring flex items-center gap-1 rounded-md bg-[var(--color-accent)] px-2 py-1 text-[11px] font-medium text-white hover:opacity-90"
            >
              <RotateCcw size={11} /> New meeting
            </button>
          )}
        </div>
      </div>

      {saveError && !savedPath && (
        <div className="rounded-xl border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-[12px] text-[var(--color-danger)]">
          <div>Couldn't save the transcript: {saveError}</div>
          {saveAttempts !== undefined && maxSaveAttempts !== undefined && saveAttempts > 0 && (
            <div className="mt-1 text-[11px] opacity-80">
              Retrying… attempt {Math.min(saveAttempts, maxSaveAttempts)} / {maxSaveAttempts}
            </div>
          )}
        </div>
      )}
      {savedPath && (
        <button
          type="button"
          aria-label="Open saved transcript folder"
          onClick={onOpenFolder}
          className="no-drag focus-ring flex items-center gap-2 rounded-xl border border-[var(--color-success)]/30 bg-[var(--color-success)]/10 px-3 py-2 text-left text-[12px] hover:bg-[var(--color-success)]/16"
        >
          <FolderOpen size={14} className="text-[var(--color-success)]" />
          <span className="flex-1 text-[color:var(--color-ink-2)]">
            Saved to your meetings folder for Dust follow-up.
          </span>
          <span className="font-medium text-[var(--color-success)]">Open</span>
        </button>
      )}

      <section aria-live="polite" aria-atomic="false">
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-accent)]">
          <ListTree size={12} /> Meeting notes
        </div>
        {recap?.error ? (
          <div className="text-[13px] text-[var(--color-danger)]">{recap.error}</div>
        ) : recap?.text ? (
          <Markdown>{recap.text}</Markdown>
        ) : !recap && lines.length === 0 ? (
          <div className="text-[13px] text-[color:var(--color-ink-2)]">
            No speech was captured this session.
          </div>
        ) : (
          <div className="flex items-center gap-2 py-1 text-[13px] text-[color:var(--color-ink-2)]">
            <Spinner size={13} /> writing detailed notes…
          </div>
        )}
      </section>

      <section>
        <div className="mb-1.5 flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-[color:var(--color-ink-3)]">
            <FileText size={12} /> Full transcript · {lines.length} lines
          </div>
          <button
            type="button"
            aria-label={copied ? 'Copied transcript' : 'Copy transcript'}
            onClick={copy}
            className="no-drag focus-ring flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-[color:var(--color-ink-2)] hover:bg-white/10 hover:text-[color:var(--color-ink)]"
          >
            {copied ? <Check size={11} className="text-[var(--color-success)]" /> : <Copy size={11} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        {copyError && (
          <div className="mb-2 rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-2 py-1 text-[11px] text-[var(--color-danger)]">
            {copyError}
          </div>
        )}
        <div className="scroll-thin flex max-h-[300px] flex-col gap-2 overflow-y-auto rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] p-3">
          {lines.length === 0 ? (
            <div className="text-[13px] text-[color:var(--color-ink-2)]">No transcript captured.</div>
          ) : (
            lines.map((l, i) => (
              <div key={i} className="flex gap-2 text-[13px] leading-snug">
                <span className="shrink-0 font-mono text-[10px] text-[color:var(--color-ink-3)]">
                  {clock(l.t)}
                </span>
                <span
                  className={
                    'shrink-0 text-[10px] font-semibold uppercase ' +
                    (l.speaker === 'them'
                      ? 'text-[color:var(--color-ink-2)]'
                      : 'text-[var(--color-accent)]')
                  }
                >
                  {l.speaker === 'them' ? 'Them' : 'You'}
                </span>
                <span className="text-[color:var(--color-ink)]">{l.text}</span>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  )
}
