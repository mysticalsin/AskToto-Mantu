import { Check, ChevronDown, Copy, FileText } from 'lucide-react'
import type { TranscriptLine } from '@shared/ipc'
import { TextButton } from '../ui'
import { clock, speakerDisplay } from './review-format'

/** The Review screen's transcript disclosure: a one-click "Show Transcript" button while collapsed,
 *  the full speech transcript with a Copy action once opened. Presentational only; Review owns the state. */
export function ReviewTranscript({
  speechLines,
  open,
  onOpenChange,
  copied,
  copyError,
  onCopy
}: {
  speechLines: TranscriptLine[]
  open: boolean
  onOpenChange: (open: boolean) => void
  copied: boolean
  copyError: string | null
  onCopy: () => void
}): JSX.Element {
  if (!open) {
    return (
      // Summary-first: the full transcript is hidden behind a one-click disclosure unless the user has
      // opted in (Settings → showFullTranscriptInReview). The notes above are the payoff.
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        className="no-drag focus-ring flex w-fit items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-medium text-[color:var(--color-ink-3)] hover:bg-white/[0.06] hover:text-[color:var(--color-ink-2)]"
      >
        <FileText size={12} />
        Show Transcript
        <span className="text-[color:var(--color-ink-3)] opacity-60">· {speechLines.length} lines</span>
        <ChevronDown size={12} className="-rotate-90" />
      </button>
    )
  }
  return (
    <section>
      <div className="mb-1.5 flex items-center justify-between">
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className="no-drag focus-ring flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[11px] font-medium uppercase tracking-wide text-[color:var(--color-ink-3)] hover:text-[color:var(--color-ink-2)]"
        >
          <FileText size={12} /> Full transcript · {speechLines.length} lines <ChevronDown size={12} />
        </button>
        <TextButton onClick={onCopy}>
          {copied ? <Check size={11} className="text-[var(--color-success)]" /> : <Copy size={11} />}
          {copied ? 'Copied' : 'Copy'}
        </TextButton>
      </div>
      {copyError && (
        <div className="mb-2 rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-2 py-1 text-[11px] text-[var(--color-danger)]">
          {copyError}
        </div>
      )}
      {/* No inner scroll: the transcript flows in full and the single review panel scrolls as one, so the
        whole Overview + transcript is visible without fighting a nested 300px scroll box. */}
      <div className="flex flex-col gap-2 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] p-3">
        {speechLines.length === 0 ? (
          <div className="text-[13px] text-[color:var(--color-ink-2)]">No transcript captured.</div>
        ) : (
          speechLines.map((l, i) => (
            <div key={i} className="flex gap-2 text-[13px] leading-snug">
              <span className="shrink-0 font-mono text-[10px] text-[color:var(--color-ink-3)]">{clock(l.t)}</span>
              <span
                className={
                  'shrink-0 text-[10px] font-semibold uppercase ' +
                  (l.speaker === 'them' ? 'text-[color:var(--color-ink-2)]' : 'text-[color:var(--color-ink-3)]')
                }
              >
                {speakerDisplay(l)}
              </span>
              <span className="min-w-0 flex-1 break-words text-[color:var(--color-ink)]">{l.text}</span>
            </div>
          ))
        )}
      </div>
    </section>
  )
}
