import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import type { DashboardData, MeetingFeedRow } from '../types/data'
import { bandColor, bandLabel } from '../lib/format'
import { meetingsPerWeek } from '../lib/momentum'
import { slug } from '../lib/slug'
import { WeeklyBars } from '../components/charts'

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

  // Real account node ids from the same graph the Relationships tab renders — an account badge only
  // becomes a link when a matching node genuinely exists, otherwise it stays the plain text it is today.
  const accountNodeIds = useMemo(
    () => new Set(data.account_graph.nodes.filter((n) => n.type === 'account').map((n) => n.id)),
    [data.account_graph.nodes],
  )

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <h1 className="text-2xl font-semibold text-white/95">Meetings</h1>
      <p className="mt-1 text-xs text-white/40">
        Every ingested meeting, newest first: {meetings.length} total
        {density.undated > 0 ? `, ${density.undated} undated (excluded from the cadence strip below)` : ''}.
      </p>

      <div className="intel-glass mt-6 p-4">
        <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-wide text-white/40">
          <span>Meeting cadence: last 12 weeks</span>
          {maxCount > 0 && <span className="text-white/30">peak {maxCount}/wk</span>}
        </div>
        {meetings.length === 0 ? (
          <p className="text-xs text-white/40">No meetings ingested yet.</p>
        ) : (
          <WeeklyBars buckets={density.buckets} />
        )}
      </div>

      <div className="mt-6 space-y-2">
        {meetings.length === 0 ? (
          <p className="intel-glass p-6 text-center text-sm text-white/40">
            No meetings ingested yet.
          </p>
        ) : (
          meetings.map((m) => <MeetingRow key={m.slug} meeting={m} accountNodeIds={accountNodeIds} />)
        )}
      </div>
    </div>
  )
}

function MeetingRow({ meeting, accountNodeIds }: { meeting: MeetingFeedRow; accountNodeIds: Set<string> }) {
  const topics = meeting.topics ?? []
  const shownTopics = topics.slice(0, 4)
  const extraTopics = topics.length - shownTopics.length
  // Sentiment can be absent (an ungraded/internal meeting) — show a neutral grey dot + honest label
  // instead of an undefined background and a literal title="undefined".
  const hasSentiment = meeting.sentiment != null
  // Deep-link contract: `account:<slug>` matches the id convention minted at ingest (ingest.ts) and
  // carried through unchanged in account_graph.nodes — only link when that exact node exists.
  const accountNodeId = meeting.account ? `account:${slug(meeting.account)}` : null
  const accountIsLinkable = accountNodeId !== null && accountNodeIds.has(accountNodeId)
  const accountBadgeClass =
    'max-w-[140px] flex-shrink-0 truncate rounded-full bg-white/5 px-2 py-0.5 text-[10px] font-medium text-white/60'
  return (
    <div className="meeting-row flex items-center gap-3 rounded-lg border border-[var(--color-mantu-border)] bg-[var(--color-mantu-surface)] px-4 py-3">
      <span
        className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
        style={{ background: hasSentiment ? bandColor[meeting.sentiment] : 'rgba(255,255,255,0.28)' }}
        title={hasSentiment ? bandLabel[meeting.sentiment] : 'No sentiment recorded'}
      />
      <span className="flex-shrink-0 whitespace-nowrap text-xs text-white/40">{humanizeDate(meeting.date)}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-white/85">{meeting.title24}</span>
      {meeting.account && accountIsLinkable && (
        <Link
          to={`/graph?focus=${accountNodeId}`}
          title={`Open ${meeting.account} in Relationships`}
          className={`${accountBadgeClass} transition-colors hover:bg-mantu/25 hover:text-white/85`}
        >
          {meeting.account}
        </Link>
      )}
      {meeting.account && !accountIsLinkable && (
        <span className={accountBadgeClass} title={meeting.account}>
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
