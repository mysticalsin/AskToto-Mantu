import { useMemo } from 'react'
import type { DashboardData, MeetingFeedRow } from '../types/data'
import { bandColor, bandLabel } from '../lib/format'
import { meetingsPerWeek } from '../lib/momentum'

interface Props {
  data: DashboardData
}

/** 'YYYY-MM-DD' → 'Jun 30'. Empty/unparseable dates render as an honest 'Undated', never a fake date. */
function humanizeDate(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr)
  if (!m) return 'Undated'
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/**
 * The meeting feed the dashboard never had: every ingested meeting, newest first, with a thin
 * cadence strip on top. Outer container/scroll pattern copied from StatsView for visual consistency.
 */
export function MeetingsView({ data }: Props) {
  const meetings = data.meetings_feed

  // meetingsPerWeek only reads `.date` — pass the minimal shape rather than the full feed row so this
  // stays structurally valid regardless of how MeetingFeedRow's other fields evolve.
  const density = useMemo(
    () => meetingsPerWeek(meetings.map((m) => ({ date: m.date })), Date.now(), 12),
    [meetings],
  )
  const maxCount = Math.max(0, ...density.buckets.map((b) => b.count))

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <h1 className="text-2xl font-semibold text-white/95">Meetings</h1>
      <p className="mt-1 text-xs text-white/40">
        Every ingested meeting, newest first: {meetings.length} total
        {density.undated > 0 ? `, ${density.undated} undated (excluded from the cadence strip below)` : ''}.
      </p>

      <div className="mt-6 rounded-xl border border-[var(--color-mantu-border)] bg-[var(--color-mantu-surface)] p-4">
        <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-wide text-white/40">
          <span>Meeting cadence: last 12 weeks</span>
          {maxCount > 0 && <span className="text-white/30">peak {maxCount}/wk</span>}
        </div>
        {meetings.length === 0 ? (
          <p className="text-xs italic text-white/30">No meetings ingested yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <svg viewBox="0 0 360 40" width="100%" height="40" preserveAspectRatio="none" className="min-w-[360px]">
              {density.buckets.map((b, i) => {
                const barW = 360 / density.buckets.length
                const h = maxCount > 0 ? (b.count / maxCount) * 32 : 0
                return (
                  <rect
                    key={b.weekStartISO}
                    x={i * barW + barW * 0.15}
                    y={36 - h}
                    width={barW * 0.7}
                    height={b.count > 0 ? Math.max(h, 2) : 0.5}
                    fill="var(--color-mantu-light)"
                    opacity={b.count > 0 ? 0.9 : 0.2}
                  >
                    <title>{`Week of ${b.weekStartISO}: ${b.count} meeting${b.count === 1 ? '' : 's'}`}</title>
                  </rect>
                )
              })}
            </svg>
            <div className="mt-1 flex justify-between text-[10px] text-white/25">
              <span>{humanizeDate(density.buckets[0].weekStartISO)}</span>
              <span>now</span>
            </div>
          </div>
        )}
      </div>

      <div className="mt-6 space-y-2">
        {meetings.length === 0 ? (
          <p className="rounded-xl border border-[var(--color-mantu-border)] bg-[var(--color-mantu-surface)] p-6 text-center text-sm text-white/30">
            No meetings ingested yet.
          </p>
        ) : (
          meetings.map((m) => <MeetingRow key={m.slug} meeting={m} />)
        )}
      </div>
    </div>
  )
}

function MeetingRow({ meeting }: { meeting: MeetingFeedRow }) {
  const topics = meeting.topics ?? []
  const shownTopics = topics.slice(0, 4)
  const extraTopics = topics.length - shownTopics.length
  // Sentiment can be absent (an ungraded/internal meeting) — show a neutral grey dot + honest label
  // instead of an undefined background and a literal title="undefined".
  const hasSentiment = meeting.sentiment != null
  return (
    <div className="flex items-center gap-3 rounded-lg border border-[var(--color-mantu-border)] bg-[var(--color-mantu-surface)] px-4 py-3">
      <span
        className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
        style={{ background: hasSentiment ? bandColor[meeting.sentiment] : 'rgba(255,255,255,0.28)' }}
        title={hasSentiment ? bandLabel[meeting.sentiment] : 'No sentiment recorded'}
      />
      <span className="flex-shrink-0 whitespace-nowrap text-xs text-white/40">{humanizeDate(meeting.date)}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-white/85">{meeting.title24}</span>
      {meeting.account && (
        <span
          className="max-w-[140px] flex-shrink-0 truncate rounded-full bg-white/5 px-2 py-0.5 text-[10px] font-medium text-white/60"
          title={meeting.account}
        >
          {meeting.account}
        </span>
      )}
      {topics.length > 0 && (
        <div className="flex flex-shrink-0 items-center gap-1">
          {shownTopics.map((t) => (
            <span key={t} className="max-w-[100px] truncate rounded-full bg-white/[0.04] px-2 py-0.5 text-[10px] text-white/40">
              {t}
            </span>
          ))}
          {extraTopics > 0 && <span className="text-[10px] text-white/30">+{extraTopics}</span>}
        </div>
      )}
    </div>
  )
}
