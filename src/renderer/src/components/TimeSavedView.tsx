/**
 * Time saved. Settings, Intelligence. DESIGN: docs/design/TIME-SAVED.md
 *
 * Calm, factual. Every number is an estimate. No gauges, no invented percentages.
 * Mantu tokens only (--color-ink, --color-accent-text, glass card).
 */
import { useEffect, useState } from 'react'
import { formatSavedTime } from '@shared/time-saved'
import {
  connectorLabel,
  kindLabel,
  type TimeSavedEvent,
  type TimeSavedEventKind
} from '@shared/time-saved-events'

const KINDS: TimeSavedEventKind[] = ['note-taking', 'second-brain', 'email-summary', 'mcp-push']

const EMPTY_KIND: Record<TimeSavedEventKind, number> = {
  'note-taking': 0,
  'second-brain': 0,
  'email-summary': 0,
  'mcp-push': 0
}

export interface TimeSavedSnapshot {
  savedMinutes: number
  byKind: Record<TimeSavedEventKind, number>
  events: number
  recent: TimeSavedEvent[]
}

function relativeTime(ts: number, now: number): string {
  const delta = Math.max(0, now - ts)
  const min = Math.round(delta / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const hours = Math.round(min / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

export function TimeSavedView({
  meetingWriteupMinutes,
  meetingCount
}: {
  meetingWriteupMinutes?: number
  meetingCount?: number
}): JSX.Element {
  const [snap, setSnap] = useState<TimeSavedSnapshot | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void window.toto
      .timeSavedRead()
      .then((r) => {
        if (!alive) return
        setSnap({
          savedMinutes: r.savedMinutes,
          byKind: { ...EMPTY_KIND, ...r.byKind },
          events: r.events,
          recent: r.recent as TimeSavedEvent[]
        })
      })
      .catch(() => {
        if (alive) setErr('Could not read the time-saved log.')
      })
    return () => {
      alive = false
    }
  }, [])

  const empty = !snap || snap.events === 0
  const now = Date.now()

  return (
    <div className="flex flex-col gap-3">
      <div className="cl-card px-3.5 py-3">
        {err ? (
          <div className="text-[12px] text-[color:var(--cl-destructive)]">{err}</div>
        ) : empty ? (
          <div className="text-[12px] leading-snug text-[color:var(--cl-muted-foreground)]">
            Time saved appears when Métis finishes a note, a recap, or a push you confirm.
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="font-ui text-[24px] font-semibold leading-none tracking-tight text-[color:var(--cl-foreground)]">
                ≈ {formatSavedTime(snap.savedMinutes)}
              </span>
              <span className="text-[11px] text-[color:var(--cl-muted-foreground)]">estimate</span>
            </div>
            <div className="mt-3 flex flex-col gap-1.5 border-t border-[var(--cl-border)] pt-2">
              {KINDS.map((kind) => (
                <div key={kind} className="flex items-center justify-between gap-3 text-[12px]">
                  <span className="text-[color:var(--cl-foreground)]">{kindLabel(kind)}</span>
                  <span className="tabular-nums text-[color:var(--cl-muted-foreground)]">
                    ~{snap.byKind[kind]} min
                  </span>
                </div>
              ))}
            </div>
            {meetingCount && meetingCount > 0 && meetingWriteupMinutes != null ? (
              <div className="mt-2 text-[11px] text-[color:var(--cl-muted-foreground)]">
                From meeting notes, separately: ≈ {formatSavedTime(meetingWriteupMinutes)} across{' '}
                {meetingCount} meeting{meetingCount === 1 ? '' : 's'} (also an estimate).
              </div>
            ) : null}
          </>
        )}
      </div>

      {!empty && snap.recent.length > 0 ? (
        <div className="flex flex-col gap-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-[color:var(--cl-muted-foreground)]">
            Recent
          </div>
          <ul className="flex flex-col gap-1">
            {snap.recent.map((ev, i) => (
              <li
                key={`${ev.kind}-${ev.timestamp}-${i}`}
                className="flex items-center justify-between gap-3 rounded-[10px] border border-[var(--cl-border)] bg-white/[0.02] px-3 py-2"
              >
                <span className="min-w-0 truncate text-[12px] text-[color:var(--cl-foreground)]">
                  {kindLabel(ev.kind)}
                  {ev.connector && ev.connector !== 'none' ? (
                    <span className="text-[color:var(--cl-muted-foreground)]"> · {connectorLabel(ev.connector)}</span>
                  ) : null}
                  <span className="text-[color:var(--cl-muted-foreground)]"> · {relativeTime(ev.timestamp, now)}</span>
                </span>
                <span className="shrink-0 tabular-nums text-[11px] text-[color:var(--cl-muted-foreground)]">
                  ~{ev.estimatedMinutes} min
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="text-[10.5px] leading-snug text-[color:var(--cl-muted-foreground)]">
        Estimates, not a stopwatch. Notes: words / 180 wpm. Second brain: 2 min per captured opportunity,
        cap 15. Email + next steps: 4 min. A confirmed push: 3 min. Nothing is sent unless you confirm.
      </p>
    </div>
  )
}
