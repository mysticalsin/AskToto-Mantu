import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  Brain,
  Building2,
  CalendarCheck,
  CalendarClock,
  CalendarX,
  ExternalLink,
  HelpCircle,
  Minus,
  RefreshCw,
  TrendingUp,
  Users
} from 'lucide-react'
import type { BrainRead, BrainStatus, Band, DealEntity, LedgerCommitment } from '@shared/brain'
import type { MeetingSummary } from '@shared/ipc'
import { MantuMark } from './MantuMark'
import { Spinner } from './ui'

/**
 * Mantu Intelligence — the second-brain dashboard over the meeting knowledge store (.brain/).
 * Two layers, mirroring the store's own epistemics:
 *   FACTUAL — meetings volume, people, accounts by sector, everything traceable to a transcript.
 *   PREDICTIVE — deal win-likelihood bands + velocity signals, always qualitative (never invented
 *   percentages) and always carrying the evidence line the judgement was grounded in.
 * Charts follow the dataviz discipline: single-hue bars for magnitude, status colors only for state
 * (with icon + label, never color alone), thin marks, text in ink tokens.
 */

// 'mixed' status amber — contrast ≥3:1 on the dark glass surface (validated); success/danger reuse
// the app's semantic tokens so the dashboard stays inside the frozen visual language.
const MIXED_COLOR = '#e0af68'

const BAND_META: Record<Band, { label: string; color: string; Icon: typeof TrendingUp }> = {
  good: { label: 'On track', color: 'var(--color-success)', Icon: TrendingUp },
  mixed: { label: 'Mixed read', color: MIXED_COLOR, Icon: Minus },
  concerning: { label: 'At risk', color: 'var(--color-danger)', Icon: AlertTriangle }
}

const VELOCITY_META = {
  'hard-calendar-gate': { label: 'Dated next step', color: 'var(--color-success)', Icon: CalendarCheck },
  'soft-organizational-gate': { label: 'Soft intent', color: MIXED_COLOR, Icon: CalendarClock },
  'no-hard-date-found': { label: 'No date', color: 'var(--color-ink-3)', Icon: CalendarX }
} as const

/** ISO-week (Mon-anchored) start for a date, as a ms timestamp. */
function weekStart(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  const day = (d.getDay() + 6) % 7 // Mon=0 … Sun=6
  d.setDate(d.getDate() - day)
  return d.getTime()
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const WEEKS_SHOWN = 12

function StatTile({ value, label }: { value: number | string; label: string }): JSX.Element {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-2 py-2.5">
      <div className="font-ui text-[20px] font-semibold leading-none tracking-tight text-[color:var(--color-ink)]">
        {value}
      </div>
      <div className="text-[10px] font-medium uppercase tracking-wide text-[color:var(--color-ink-3)]">{label}</div>
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
      {children}
    </div>
  )
}

function Chip({
  label,
  color,
  Icon,
  title
}: {
  label: string
  color: string
  Icon: typeof TrendingUp
  title?: string
}): JSX.Element {
  return (
    <span
      title={title}
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-white/[0.05] px-2 py-0.5 text-[10px] font-semibold"
      style={{ color }}
    >
      <Icon size={11} strokeWidth={2.2} />
      {label}
    </span>
  )
}

/** Meetings-per-week bars: single hue, thin marks, rounded data ends, native tooltips per bar. */
function WeeklyBars({ meetings }: { meetings: MeetingSummary[] }): JSX.Element {
  const { weeks, max } = useMemo(() => {
    const now = weekStart(Date.now())
    const counts = new Map<number, number>()
    for (const m of meetings) {
      const ms = Date.parse(m.date)
      if (isNaN(ms)) continue
      const w = weekStart(ms)
      if (w > now || w < now - (WEEKS_SHOWN - 1) * WEEK_MS) continue
      counts.set(w, (counts.get(w) || 0) + 1)
    }
    const weeks = Array.from({ length: WEEKS_SHOWN }, (_, i) => {
      const w = now - (WEEKS_SHOWN - 1 - i) * WEEK_MS
      return { w, n: counts.get(w) || 0 }
    })
    return { weeks, max: Math.max(1, ...weeks.map((x) => x.n)) }
  }, [meetings])

  const W = 480
  const H = 64
  const gap = 6
  const bw = (W - gap * (WEEKS_SHOWN - 1)) / WEEKS_SHOWN
  const fmt = (w: number): string =>
    new Date(w).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-[64px] w-full" role="img" aria-label="Meetings per week">
        {weeks.map(({ w, n }, i) => {
          const h = n === 0 ? 2 : Math.max(4, (n / max) * (H - 14))
          const x = i * (bw + gap)
          return (
            <g key={w}>
              <rect
                x={x}
                y={H - h}
                width={bw}
                height={h}
                rx={n === 0 ? 1 : 4}
                fill={n === 0 ? 'rgba(255,255,255,0.08)' : 'var(--color-accent-2)'}
              >
                <title>{`Week of ${fmt(w)}: ${n} meeting${n === 1 ? '' : 's'}`}</title>
              </rect>
              {/* Selective direct labels: only the busiest week and the current week carry a number. */}
              {n > 0 && (n === max || i === WEEKS_SHOWN - 1) && (
                <text
                  x={x + bw / 2}
                  y={H - h - 4}
                  textAnchor="middle"
                  className="fill-[color:var(--color-ink-2)]"
                  fontSize={10}
                  fontWeight={600}
                >
                  {n}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <div className="mt-0.5 flex justify-between text-[9px] text-[color:var(--color-ink-3)]">
        <span>{fmt(weeks[0].w)}</span>
        <span>this week</span>
      </div>
    </div>
  )
}

/** Horizontal magnitude bars (accounts per sector) — label left, single-hue track, count right. */
function SectorBars({ sectors }: { sectors: { sector: string; n: number }[] }): JSX.Element {
  const max = Math.max(1, ...sectors.map((s) => s.n))
  return (
    <div className="flex flex-col gap-1.5">
      {sectors.map(({ sector, n }) => (
        <div key={sector} className="flex items-center gap-2" title={`${sector}: ${n} account${n === 1 ? '' : 's'}`}>
          <div className="w-32 shrink-0 truncate text-right text-[11px] capitalize text-[color:var(--color-ink-3)]">
            {sector.replace(/-/g, ' ')}
          </div>
          <div className="h-[6px] flex-1 overflow-hidden rounded-full bg-white/[0.05]">
            <div
              className="h-full rounded-full bg-[var(--color-accent-2)]"
              style={{ width: `${(n / max) * 100}%` }}
            />
          </div>
          <div className="w-5 shrink-0 text-[11px] font-semibold text-[color:var(--color-ink-2)]">{n}</div>
        </div>
      ))}
    </div>
  )
}

function DealRow({ deal }: { deal: DealEntity }): JSX.Element {
  const band = deal.win_likelihood_band ? BAND_META[deal.win_likelihood_band] : null
  const vel = VELOCITY_META[deal.velocity.signal]
  const last = deal.meetings[deal.meetings.length - 1]
  const closed = deal.outcome !== 'open'
  return (
    <div
      className={`flex flex-col gap-1 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-3 py-2 ${closed ? 'opacity-60' : ''}`}
    >
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[color:var(--color-ink)]">
          {deal.name}
          {deal.account && <span className="font-normal text-[color:var(--color-ink-3)]"> · {deal.account}</span>}
        </div>
        {closed ? (
          <Chip
            label={deal.outcome === 'won' ? 'Won' : 'Lost'}
            color={deal.outcome === 'won' ? 'var(--color-success)' : 'var(--color-danger)'}
            Icon={deal.outcome === 'won' ? TrendingUp : AlertTriangle}
          />
        ) : (
          <>
            {band ? (
              <Chip label={band.label} color={band.color} Icon={band.Icon} title={deal.band_evidence || undefined} />
            ) : (
              <Chip label="No read" color="var(--color-ink-3)" Icon={HelpCircle} />
            )}
            <Chip label={vel.label} color={vel.color} Icon={vel.Icon} title={deal.velocity.evidence || undefined} />
          </>
        )}
      </div>
      <div className="flex items-center gap-3 text-[11px] text-[color:var(--color-ink-3)]">
        {deal.stage && <span className="truncate">{deal.stage}</span>}
        <span className="shrink-0">
          {deal.meetings.length} meeting{deal.meetings.length === 1 ? '' : 's'}
          {last?.date ? ` · last ${new Date(last.date).toLocaleDateString()}` : ''}
        </span>
      </div>
      {!closed && deal.band_evidence && (
        <div className="truncate text-[11px] italic text-[color:var(--color-ink-3)]" title={deal.band_evidence}>
          “{deal.band_evidence}”
        </div>
      )}
    </div>
  )
}

const BAND_ORDER: Record<string, number> = { concerning: 0, mixed: 1, good: 2 }

export function BrainView({ onBack }: { onBack: () => void }): JSX.Element {
  const [data, setData] = useState<BrainRead | null>(null)
  const [status, setStatus] = useState<BrainStatus | null>(null)
  const [meetings, setMeetings] = useState<MeetingSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [backfilling, setBackfilling] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [read, st, list] = await Promise.all([
        window.toto.brainRead(),
        window.toto.brainStatus(),
        window.toto.recallList()
      ])
      setData(read)
      setStatus(st)
      setMeetings(list)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // While a backfill is running, poll so the dashboard fills in live as extractions land.
  const backfillRunning = !!status?.backfill?.running
  useEffect(() => {
    if (!backfillRunning) return
    const t = setInterval(() => void refresh(), 4000)
    return () => clearInterval(t)
  }, [backfillRunning, refresh])

  const startBackfill = useCallback(async (): Promise<void> => {
    setBackfilling(true)
    try {
      await window.toto.brainBackfill()
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBackfilling(false)
    }
  }, [refresh])

  const sectors = useMemo(() => {
    const by = new Map<string, number>()
    for (const a of data?.accounts ?? []) by.set(a.sector, (by.get(a.sector) || 0) + 1)
    return Array.from(by, ([sector, n]) => ({ sector, n })).sort((a, b) => b.n - a.n).slice(0, 8)
  }, [data])

  const deals = useMemo(() => {
    const list = [...(data?.deals ?? [])]
    return list.sort((a, b) => {
      if ((a.outcome === 'open') !== (b.outcome === 'open')) return a.outcome === 'open' ? -1 : 1
      const ab = a.win_likelihood_band ? BAND_ORDER[a.win_likelihood_band] : 3
      const bb = b.win_likelihood_band ? BAND_ORDER[b.win_likelihood_band] : 3
      return ab - bb
    })
  }, [data])

  const people = useMemo(
    () => [...(data?.people ?? [])].sort((a, b) => b.meetings.length - a.meetings.length).slice(0, 6),
    [data]
  )

  // Commitment Ledger: every open promise across all deals, oldest first (age = urgency).
  const openPromises = useMemo(() => {
    const all: (LedgerCommitment & { deal: string })[] = []
    for (const d of data?.deals ?? []) {
      for (const c of d.commitments ?? []) {
        if (c.status === 'open') all.push({ ...c, deal: d.name })
      }
    }
    return all.sort((a, b) => (a.date || '').localeCompare(b.date || '')).slice(0, 8)
  }, [data])

  const ingested = status?.meetings ?? 0
  const notIngested = Math.max(0, meetings.length - ingested)
  const bf = status?.backfill

  return (
    <div className="fade-up flex flex-col gap-3 px-1 py-1">
      {/* Header — Mantu-branded */}
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          aria-label="Back"
          onClick={onBack}
          className="no-drag focus-ring grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[color:var(--color-ink-3)] hover:text-[color:var(--color-ink)]"
        >
          <ArrowLeft size={15} />
        </button>
        <MantuMark size={22} />
        <div className="min-w-0 flex-1">
          <div className="font-ui text-[15px] font-semibold tracking-tight text-[color:var(--color-ink)]">
            Mantu Intelligence
          </div>
          <div className="text-[11px] text-[color:var(--color-ink-3)]">
            Your meeting knowledge, compounding — grounded in transcripts, never invented.
          </div>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          title="Refresh"
          className="no-drag focus-ring grid h-7 w-7 place-items-center rounded-lg text-[color:var(--color-ink-3)] hover:text-[color:var(--color-ink)]"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-1.5 text-[11px] text-[var(--color-danger)]">
          {error}
        </div>
      )}

      {loading && !data ? (
        <div className="flex items-center justify-center gap-2 py-10 text-[12px] text-[color:var(--color-ink-3)]">
          <Spinner size={14} /> Reading the brain…
        </div>
      ) : ingested === 0 && !bf?.running ? (
        /* Empty state — the brain has not ingested anything yet. */
        <div className="flex flex-col items-center gap-3 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-6 py-8 text-center">
          <Brain size={28} className="text-[color:var(--color-accent-2)]" />
          <div className="text-[13px] font-semibold text-[color:var(--color-ink)]">
            Build your intelligence from {meetings.length > 0 ? `${meetings.length} saved meeting${meetings.length === 1 ? '' : 's'}` : 'your meetings'}
          </div>
          <div className="max-w-[380px] text-[12px] leading-snug text-[color:var(--color-ink-3)]">
            AskToto extracts people, accounts, deals, and win/loss signals from every saved transcript into a
            knowledge store your Dust agents can read. New meetings are ingested automatically.
          </div>
          <button
            type="button"
            onClick={() => void startBackfill()}
            disabled={backfilling || meetings.length === 0}
            className="no-drag focus-ring rounded-full bg-[var(--color-accent)] px-4 py-1.5 text-[12px] font-semibold text-white hover:bg-[var(--color-accent-2)] disabled:opacity-50"
          >
            {backfilling ? 'Starting…' : 'Ingest my meetings'}
          </button>
        </div>
      ) : (
        <>
          {/* Backfill progress + drift note */}
          {bf?.running ? (
            <div className="flex items-center gap-2 rounded-xl border border-[var(--color-hair-soft)] bg-[var(--color-accent-soft)] px-3 py-1.5 text-[11px] text-[color:var(--color-ink-2)]">
              <Spinner size={12} /> Ingesting {bf.done}/{bf.total} meetings…
            </div>
          ) : notIngested > 0 ? (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-3 py-1.5 text-[11px] text-[color:var(--color-ink-3)]">
              <span>
                {notIngested} saved meeting{notIngested === 1 ? '' : 's'} not in the brain yet.
              </span>
              <button
                type="button"
                onClick={() => void startBackfill()}
                disabled={backfilling}
                className="no-drag focus-ring shrink-0 rounded-full bg-white/[0.06] px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-ink-2)] hover:bg-white/10"
              >
                {backfilling ? 'Starting…' : 'Ingest now'}
              </button>
            </div>
          ) : null}

          {/* FACTUAL — KPI tiles */}
          <div className="flex gap-2">
            <StatTile value={ingested} label="Meetings" />
            <StatTile value={status?.people ?? 0} label="People" />
            <StatTile value={status?.accounts ?? 0} label="Accounts" />
            <StatTile value={status?.deals ?? 0} label="Deals" />
            <StatTile value={status?.edges ?? 0} label="Connections" />
          </div>

          {/* FACTUAL — volume + sectors */}
          <div className="rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-3 py-2.5">
            <SectionTitle>Meetings per week</SectionTitle>
            <WeeklyBars meetings={meetings} />
          </div>

          {sectors.length > 0 && (
            <div className="rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-3 py-2.5">
              <SectionTitle>
                <Building2 size={11} className="mr-1 inline" />
                Accounts by sector
              </SectionTitle>
              <SectorBars sectors={sectors} />
            </div>
          )}

          {/* COMMITMENT LEDGER — open promises across every deal, oldest (most urgent) first */}
          {openPromises.length > 0 && (
            <div className="rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-3 py-2.5">
              <SectionTitle>
                <CalendarCheck size={11} className="mr-1 inline" />
                Open promises
              </SectionTitle>
              <div className="flex flex-col gap-1">
                {openPromises.map((c) => {
                  const days = c.date ? Math.max(0, Math.floor((Date.now() - Date.parse(c.date)) / 86400000)) : null
                  const yours = c.by === 'you'
                  return (
                    <div key={c.meeting + c.text} className="flex items-center gap-2 text-[12px]" title={c.quote || undefined}>
                      <span
                        className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                        style={{
                          color: yours ? 'var(--color-accent-2)' : MIXED_COLOR,
                          background: 'rgba(255,255,255,0.05)'
                        }}
                      >
                        {yours ? 'You' : c.by === 'them' ? 'Them' : c.by}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[color:var(--color-ink-2)]">{c.text}</span>
                      {c.due_hint && (
                        <span className="shrink-0 text-[10px] italic text-[color:var(--color-ink-3)]">“{c.due_hint}”</span>
                      )}
                      {days !== null && (
                        <span
                          className="shrink-0 text-[10px] font-semibold"
                          style={{ color: days >= 7 ? 'var(--color-danger)' : 'var(--color-ink-3)' }}
                        >
                          {days === 0 ? 'today' : `${days}d`}
                        </span>
                      )}
                      <span className="shrink-0 truncate text-[10px] text-[color:var(--color-ink-3)]">{c.deal}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* PREDICTIVE — opportunities */}
          {deals.length > 0 && (
            <div>
              <SectionTitle>Opportunities — win read &amp; momentum</SectionTitle>
              <div className="flex flex-col gap-1.5">
                {deals.map((d) => (
                  <DealRow key={d.name + d.account} deal={d} />
                ))}
              </div>
            </div>
          )}

          {/* FACTUAL — people */}
          {people.length > 0 && (
            <div className="rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-3 py-2.5">
              <SectionTitle>
                <Users size={11} className="mr-1 inline" />
                People you meet
              </SectionTitle>
              <div className="flex flex-col gap-1">
                {people.map((p) => (
                  <div key={p.name} className="flex items-center gap-2 text-[12px]">
                    <span className="min-w-0 flex-1 truncate text-[color:var(--color-ink-2)]">
                      <span className="font-semibold text-[color:var(--color-ink)]">{p.name}</span>
                      {(p.role || p.account) && (
                        <span className="text-[color:var(--color-ink-3)]">
                          {' '}
                          — {[p.role, p.account].filter(Boolean).join(' @ ')}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 rounded-full bg-white/[0.05] px-2 py-0.5 text-[10px] font-semibold text-[color:var(--color-ink-3)]">
                      {p.meetings.length}×
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Lint warnings — contradictions the ingest refused to auto-resolve */}
          {(data?.index.warnings.length ?? 0) > 0 && (
            <div className="rounded-xl border border-[var(--color-danger)]/20 bg-[var(--color-danger)]/5 px-3 py-2">
              <SectionTitle>
                <AlertTriangle size={11} className="mr-1 inline" />
                Needs a human read
              </SectionTitle>
              <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[11px] text-[color:var(--color-ink-3)]">
                {data!.index.warnings.slice(0, 5).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Footer: escalate from this in-overlay glance to the full dedicated dashboard window */}
          <button
            type="button"
            onClick={() => void window.toto.brainOpenDashboard()}
            className="no-drag focus-ring flex items-center justify-center gap-1.5 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-3 py-2 text-[11px] font-semibold text-[color:var(--color-ink-3)] hover:text-[color:var(--color-ink)]"
          >
            <ExternalLink size={12} /> Open the full Mantu Intelligence dashboard
          </button>
        </>
      )}
    </div>
  )
}
