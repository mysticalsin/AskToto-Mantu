import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import type { DashboardData } from '../types/data'
import { EmptyState } from '../components/EmptyState'
import {
  buildMeetingConnections,
  connectionKindLabel,
  type ConnectionKind,
  type MeetingConnection
} from '../lib/connections'

interface Props {
  data: DashboardData
}

const KIND_CHIP: Record<ConnectionKind, string> = {
  person: 'bg-sky-500/15 text-sky-200',
  account: 'bg-violet-500/15 text-violet-200',
  deal: 'bg-emerald-500/15 text-emerald-200',
  topic: 'bg-amber-500/15 text-amber-200'
}

function humanizeDate(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr)
  if (!m) return 'Undated'
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function viaHref(row: MeetingConnection): string | null {
  if (row.kind === 'person') return `/people?person=${encodeURIComponent(row.viaSlug)}`
  if (row.kind === 'account') return `/accounts?account=${encodeURIComponent(row.viaSlug)}`
  if (row.kind === 'deal') return `/deals?deal=${encodeURIComponent(row.viaSlug)}`
  return null
}

/**
 * Named, clickable Meeting A ↔ Meeting B rows (MANTU-INTELLIGENCE.md).
 * Drawn from shared people/accounts/deals/topics — not an embedding cloud.
 */
export function ConnectionsView({ data }: Props) {
  const rows = useMemo(
    () =>
      buildMeetingConnections({
        people: data.people,
        accounts: data.accounts,
        deals: data.deals.map((d) => ({
          bid_id: d.bid_id,
          display_name: d.display_name,
          meetings: d.meetings ?? []
        })),
        meetings_feed: data.meetings_feed
      }),
    [data]
  )

  if (data.meetings_feed.length === 0) {
    return (
      <EmptyState
        title="Connections"
        standfirst="Named links between meetings that share a person, account, deal, or topic."
        headline="No meetings ingested yet."
        body="Save or import meetings into your connected brain, then open Update Intelligence. Connections appear once two meetings share a mapped person, account, deal, or topic."
      />
    )
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        title="Connections"
        standfirst="Named links between meetings that share a person, account, deal, or topic."
        headline="No cross-meeting links yet."
        body="You have meetings, but none share a mapped person, account, deal, or topic yet. Record another meeting with the same contact or account, or run Update Intelligence so extractions can join them."
      />
    )
  }

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <h1 className="text-2xl font-semibold text-white/95">Connections</h1>
      <p className="mt-1 text-sm text-white/50">
        Concrete meeting ↔ meeting links from your brain — {rows.length} shown. Click either meeting
        (Meetings feed) or the shared entity.
      </p>

      <div className="mt-6 space-y-2">
        {rows.map((row) => {
          const entityHref = viaHref(row)
          return (
            <div
              key={row.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-mantu-border)] bg-[var(--color-mantu-surface)] px-4 py-3"
            >
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${KIND_CHIP[row.kind]}`}
              >
                {connectionKindLabel(row.kind)}
              </span>
              <Link
                to={`/meetings`}
                state={{ highlight: row.a.slug }}
                className="min-w-0 max-w-[220px] truncate text-sm font-medium text-white/90 hover:text-mantu-light hover:underline"
                title={`${row.a.title} · ${humanizeDate(row.a.date)}`}
              >
                {row.a.title}
              </Link>
              <span className="text-white/35" aria-hidden>
                ↔
              </span>
              <Link
                to={`/meetings`}
                state={{ highlight: row.b.slug }}
                className="min-w-0 max-w-[220px] truncate text-sm font-medium text-white/90 hover:text-mantu-light hover:underline"
                title={`${row.b.title} · ${humanizeDate(row.b.date)}`}
              >
                {row.b.title}
              </Link>
              <span className="text-white/35">via</span>
              {entityHref ? (
                <Link
                  to={entityHref}
                  className="min-w-0 max-w-[180px] truncate text-sm text-mantu-light hover:underline"
                >
                  {row.via}
                </Link>
              ) : (
                <span className="min-w-0 max-w-[180px] truncate text-sm text-white/70">{row.via}</span>
              )}
              <span className="ml-auto text-[11px] text-white/30">
                {humanizeDate(row.a.date)} · {humanizeDate(row.b.date)}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
