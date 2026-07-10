import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  Brain,
  Building2,
  CalendarCheck,
  CalendarClock,
  CalendarX,
  Check,
  ClipboardList,
  ExternalLink,
  HelpCircle,
  Minus,
  RefreshCw,
  TrendingUp,
  Users,
  VolumeX,
  X
} from 'lucide-react'
import type { BrainRead, BrainStatus, Band, DealEntity, LedgerCommitment } from '@shared/brain'
import type { MeetingSummary } from '@shared/ipc'
import { computeSilence } from '@shared/silence'
import { buildMarsWeek, renderMarsMarkdown } from '@shared/mars'
import { MantuMark } from './MantuMark'
import { Spinner } from './ui'
import { useFlash } from '../lib/useFlash'

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
  const { weeks, max, maxIdx } = useMemo(() => {
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
    const max = Math.max(1, ...weeks.map((x) => x.n))
    const maxIdx = weeks.reduce((best, x, i) => (x.n > weeks[best].n ? i : best), 0)
    return { weeks, max, maxIdx }
  }, [meetings])

  const W = 480
  const H = 64
  const gap = 6
  const bw = (W - gap * (WEEKS_SHOWN - 1)) / WEEKS_SHOWN
  const fmt = (w: number): string =>
    new Date(w).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block h-[64px] w-full"
        role="img"
        aria-label="Meetings per week"
      >
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
              {n > 0 && (i === maxIdx || i === WEEKS_SHOWN - 1) && (
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
          <div className="h-[6px] min-w-[24px] flex-1 overflow-hidden rounded-full bg-white/[0.05]">
            <div
              className="h-full rounded-full bg-[var(--color-accent-2)]"
              style={{ width: `${(n / max) * 100}%` }}
            />
          </div>
          <div className="min-w-[1.25rem] shrink-0 text-right text-[11px] font-semibold text-[color:var(--color-ink-2)]">
            {n}
          </div>
        </div>
      ))}
    </div>
  )
}

function DealRow({
  deal,
  onSetOutcome
}: {
  deal: DealEntity
  onSetOutcome: (deal: DealEntity, outcome: 'open' | 'won' | 'lost') => void
}): JSX.Element {
  const band = deal.win_likelihood_band ? BAND_META[deal.win_likelihood_band] : null
  const vel = VELOCITY_META[deal.velocity.signal]
  const last = deal.meetings[deal.meetings.length - 1]
  const closed = deal.outcome !== 'open'
  // Won/Lost unmounts those buttons in favor of a Chip + "Reopen" — hand keyboard focus to Reopen
  // on that transition so it doesn't fall through to <body>. Guarded so it only fires on the actual
  // open→closed transition, not on initial mount of an already-closed deal.
  const reopenRef = useRef<HTMLButtonElement>(null)
  const wasClosedRef = useRef(closed)
  useEffect(() => {
    if (closed && !wasClosedRef.current) reopenRef.current?.focus()
    wasClosedRef.current = closed
  }, [closed])
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
          <>
            <Chip
              label={deal.outcome === 'won' ? 'Won' : 'Lost'}
              color={deal.outcome === 'won' ? 'var(--color-success)' : 'var(--color-danger)'}
              Icon={deal.outcome === 'won' ? TrendingUp : AlertTriangle}
            />
            {/* Human closes the loop, human can reopen it — mirrors the ledger's kept/broken flow. */}
            <button
              type="button"
              ref={reopenRef}
              onClick={() => onSetOutcome(deal, 'open')}
              className="no-drag focus-ring shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--color-ink-3)] hover:bg-white/10 hover:text-[color:var(--color-ink)]"
            >
              Reopen
            </button>
          </>
        ) : (
          <>
            {band ? (
              <Chip label={band.label} color={band.color} Icon={band.Icon} title={deal.band_evidence || undefined} />
            ) : (
              <Chip label="No read" color="var(--color-ink-3)" Icon={HelpCircle} />
            )}
            <Chip label={vel.label} color={vel.color} Icon={vel.Icon} title={deal.velocity.evidence || undefined} />
            {/* Outcome — never set by the LLM. A human marking a deal won/lost is the only writer. */}
            <span className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                onClick={() => onSetOutcome(deal, 'won')}
                className="no-drag focus-ring rounded-full px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--color-ink-3)] hover:bg-white/10 hover:text-[var(--color-success)]"
              >
                Won
              </button>
              <button
                type="button"
                onClick={() => onSetOutcome(deal, 'lost')}
                className="no-drag focus-ring rounded-full px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--color-ink-3)] hover:bg-white/10 hover:text-[var(--color-danger)]"
              >
                Lost
              </button>
            </span>
          </>
        )}
      </div>
      <div className="flex items-center gap-3 text-[11px] text-[color:var(--color-ink-3)]">
        {deal.stage && <span className="min-w-0 flex-1 truncate">{deal.stage}</span>}
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
  const [marsCopied, flashMarsCopied] = useFlash(2000)
  const [status, setStatus] = useState<BrainStatus | null>(null)
  const [meetings, setMeetings] = useState<MeetingSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [backfilling, setBackfilling] = useState(false)
  // Guards against overlapping polls during a long backfill: brainRead can take longer than the 4s
  // poll interval as ingestion grows, so without this an older, slower-resolving snapshot can land
  // after a newer one and make the KPI tiles/lists visibly jump backward.
  const refreshingRef = useRef(false)

  const refresh = useCallback(async (): Promise<void> => {
    if (refreshingRef.current) return
    refreshingRef.current = true
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
      refreshingRef.current = false
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Settling a promise removes its row (and the button that had focus) from "Open promises" — hand
  // focus to the section container so it doesn't fall through to <body>.
  const openPromisesRef = useRef<HTMLDivElement>(null)

  // Settle a ledger promise (kept/broken) and re-read — the row leaves "Open promises" and starts
  // counting toward the per-person reliability read. Human-only action; the LLM never settles.
  const settlePromise = useCallback(
    async (deal: string, text: string, status: 'kept' | 'broken'): Promise<void> => {
      try {
        const r = await window.toto.brainCommitmentSettle(deal, text, status)
        if (r.ok) {
          await refresh()
          openPromisesRef.current?.focus()
        } else setError(r.error ?? 'Could not settle the promise.')
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [refresh]
  )

  // Mark a deal open/won/lost — human-only action; the LLM never sets outcome. Optimistic: the row
  // flips the instant the write is confirmed, no round trip back through brainRead needed.
  const handleSetDealOutcome = useCallback(
    async (deal: DealEntity, outcome: 'open' | 'won' | 'lost'): Promise<void> => {
      try {
        const r = await window.toto.brainSetDealOutcome(deal.name, outcome)
        if (r.ok) {
          setData((prev) =>
            prev
              ? {
                  ...prev,
                  deals: prev.deals.map((d) =>
                    d.name === deal.name && d.account === deal.account ? { ...d, outcome } : d
                  )
                }
              : prev
          )
        } else {
          setError(r.error ?? 'Could not update the deal outcome.')
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    []
  )

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

  // Silence Detector: what accounts STOPPED saying — dropped themes, vanished champions, cooling, or
  // gone fully quiet. Computed from the meeting extractions' topic/people timeline; empty until an
  // account has enough history to compare windows. Stamp the real clock once (the analysis is pure).
  const silence = useMemo(() => computeSilence(data?.meetings ?? [], Date.now()).slice(0, 6), [data])

  // Mars week: the weekly-report skeleton (meetings, first contacts, won/lost, follow-ups, at-risk)
  // over the last 7 days — plus the SAME computation shifted one week back, so every tile can show
  // week-over-week movement (trend first, level second). Same pure function, different `now`: the
  // delta is as provable as the level.
  const mars = useMemo(() => buildMarsWeek(data?.meetings ?? [], data?.deals ?? [], Date.now()), [data])
  const marsPrev = useMemo(
    () => buildMarsWeek(data?.meetings ?? [], data?.deals ?? [], Date.now() - 7 * 24 * 60 * 60 * 1000),
    [data]
  )

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
            Your meeting knowledge, compounding. Grounded in transcripts, never invented.
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
            Métis extracts people, accounts, deals, and win/loss signals from every saved transcript into a
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

          {/* Ingested, but nothing extracted — explain the 0/0/0 instead of leaving bare zeros that read
              as "broken". Happens with short or non-client-facing transcripts. */}
          {ingested > 0 &&
            !bf?.running &&
            (status?.people ?? 0) === 0 &&
            (status?.accounts ?? 0) === 0 &&
            (status?.deals ?? 0) === 0 && (
              <div className="rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-3 py-2.5 text-[12px] leading-snug text-[color:var(--color-ink-3)]">
                Meetings are ingested, but no people, accounts, or deals were extracted yet. Usually the
                transcripts are short or don&rsquo;t name clients. Longer, client-facing meetings will fill this in.
              </div>
            )}

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
            <div
              ref={openPromisesRef}
              tabIndex={-1}
              className="focus-ring rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-3 py-2.5"
            >
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
                        <span
                          className="max-w-[110px] shrink-0 truncate text-[10px] italic text-[color:var(--color-ink-3)]"
                          title={c.due_hint}
                        >
                          “{c.due_hint}”
                        </span>
                      )}
                      {days !== null && (
                        <span
                          className="shrink-0 text-[10px] font-semibold"
                          style={{ color: days >= 7 ? 'var(--color-danger)' : 'var(--color-ink-3)' }}
                        >
                          {days === 0 ? 'today' : `${days}d`}
                        </span>
                      )}
                      <span className="min-w-0 max-w-[90px] shrink truncate text-[10px] text-[color:var(--color-ink-3)]" title={c.deal}>
                        {c.deal}
                      </span>
                      {/* Settlement — the human closes the loop. Settled rows leave this rail on refresh
                          and feed the per-person kept-promise reliability read. */}
                      <span className="flex shrink-0 items-center gap-0.5">
                        <button
                          type="button"
                          aria-label="Mark kept"
                          title="Kept: promise delivered"
                          onClick={() => void settlePromise(c.deal, c.text, 'kept')}
                          className="no-drag focus-ring grid h-5 w-5 place-items-center rounded text-[color:var(--color-ink-3)] hover:bg-white/10 hover:text-[var(--color-success)]"
                        >
                          <Check size={11} />
                        </button>
                        <button
                          type="button"
                          aria-label="Mark broken"
                          title="Broken: promise not delivered"
                          onClick={() => void settlePromise(c.deal, c.text, 'broken')}
                          className="no-drag focus-ring grid h-5 w-5 place-items-center rounded text-[color:var(--color-ink-3)] hover:bg-white/10 hover:text-[var(--color-danger)]"
                        >
                          <X size={11} />
                        </button>
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* MARS WEEK — the weekly-report section: this week's facts, ready to file. */}
          {mars.meetings.length > 0 && (
            <div className="rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-3 py-2.5">
              <div className="mb-1.5 flex items-center justify-between">
                <SectionTitle>
                  <ClipboardList size={11} className="mr-1 inline" />
                  Mars week: {mars.weekStart} → {mars.weekEnd}
                </SectionTitle>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(renderMarsMarkdown(mars)).then(() => {
                      flashMarsCopied()
                    })
                  }}
                  title="Copy the full Mars draft as markdown"
                  className="no-drag focus-ring flex items-center gap-1 rounded-lg px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--color-ink-3)] hover:text-[color:var(--color-ink)]"
                >
                  {marsCopied ? <Check size={11} className="text-[var(--color-success)]" /> : <ClipboardList size={11} />}
                  {marsCopied ? 'Copied' : 'Copy draft'}
                </button>
              </div>
              <div className="mb-2 grid grid-cols-4 gap-1.5 text-center">
                {(
                  [
                    ['Meetings', mars.meetings.length, marsPrev.meetings.length],
                    ['New accounts', mars.newAccounts.length, marsPrev.newAccounts.length],
                    ['Won', mars.won.length, marsPrev.won.length],
                    ['Lost', mars.lost.length, marsPrev.lost.length]
                  ] as const
                ).map(([label, n, prev]) => {
                  const d = n - prev
                  return (
                    <div key={label} className="rounded-lg bg-white/[0.03] px-1.5 py-1">
                      <div className="flex items-baseline justify-center gap-1">
                        <span className="text-[15px] font-semibold text-[color:var(--color-ink)]">{n}</span>
                        {d !== 0 && (
                          <span
                            className="text-[9px] font-semibold"
                            title={`${prev} last week`}
                            style={{
                              // Direction color follows MEANING: more losses is bad, more of the rest is good.
                              color:
                                (label === 'Lost' ? d < 0 : d > 0) ? 'var(--color-success)' : 'var(--color-danger)'
                            }}
                          >
                            {d > 0 ? `▲${d}` : `▼${-d}`}
                          </span>
                        )}
                      </div>
                      <div className="text-[9px] uppercase tracking-wide text-[color:var(--color-ink-3)]">{label}</div>
                    </div>
                  )
                })}
              </div>
              <div className="flex flex-col gap-1">
                {mars.meetings.slice(0, 6).map((m) => (
                  <div key={m.date + m.title} className="flex items-center gap-2 text-[12px]">
                    <span className="shrink-0 text-[10px] tabular-nums text-[color:var(--color-ink-3)]">{m.date.slice(5)}</span>
                    <span className="min-w-0 flex-1 truncate text-[color:var(--color-ink-2)]">
                      <span className="text-[color:var(--color-ink)]">{m.title}</span>
                      {m.account && <span className="text-[color:var(--color-ink-3)]"> · {m.account}</span>}
                    </span>
                    {m.firstContact && (
                      <span
                        className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold"
                        style={{ color: 'var(--color-accent-2)', background: 'rgba(255,255,255,0.05)' }}
                      >
                        First contact
                      </span>
                    )}
                    {m.band && (
                      <span className="shrink-0 text-[10px] text-[color:var(--color-ink-3)]">{m.band}</span>
                    )}
                  </div>
                ))}
                {mars.meetings.length > 6 && (
                  <div className="text-[10px] text-[color:var(--color-ink-3)]">
                    +{mars.meetings.length - 6} more in the copied draft
                  </div>
                )}
              </div>
              {(mars.openFollowups.length > 0 || mars.atRisk.length > 0) && (
                <div className="mt-1.5 flex flex-wrap gap-1 text-[10px] text-[color:var(--color-ink-3)]">
                  {mars.openFollowups.length > 0 && (
                    <span className="rounded px-1.5 py-0.5" style={{ background: 'rgba(255,255,255,0.04)' }}>
                      {mars.openFollowups.length} open follow-up{mars.openFollowups.length === 1 ? '' : 's'}
                    </span>
                  )}
                  {mars.atRisk.length > 0 && (
                    <span className="rounded px-1.5 py-0.5" style={{ background: 'rgba(255,255,255,0.04)', color: MIXED_COLOR }}>
                      {mars.atRisk.length} at risk
                    </span>
                  )}
                </div>
              )}
              <div className="mt-1.5 text-[10px] text-[color:var(--color-ink-3)]">
                Facts from recorded meetings. The Mars bucket (prospection / cold call / QM) is yours to confirm.
              </div>
            </div>
          )}

          {/* SILENCE DETECTOR — accounts going quiet: dropped themes, vanished champions, cooling, dark */}
          {silence.length > 0 && (
            <div className="rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-3 py-2.5">
              <SectionTitle>
                <VolumeX size={11} className="mr-1 inline" />
                Going quiet: what accounts stopped saying
              </SectionTitle>
              <div className="flex flex-col gap-1.5">
                {silence.map((s) => (
                  <div key={s.account} className="text-[12px]">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 truncate font-semibold text-[color:var(--color-ink)]">{s.account}</span>
                      <span className="shrink-0 text-[10px] text-[color:var(--color-ink-3)]">{s.sector}</span>
                      <span className="flex-1" />
                      {s.cooling && (
                        <span className="shrink-0 text-[10px] font-semibold" style={{ color: MIXED_COLOR }}>
                          cooling
                        </span>
                      )}
                      {s.wentDark ? (
                        <span
                          className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                          style={{ color: 'var(--color-danger)', background: 'rgba(255,255,255,0.05)' }}
                        >
                          Silent {s.daysQuiet}d
                        </span>
                      ) : (
                        <span
                          className="shrink-0 text-[10px] font-semibold"
                          style={{ color: s.daysQuiet >= 30 ? 'var(--color-danger)' : 'var(--color-ink-3)' }}
                        >
                          {s.daysQuiet}d quiet
                        </span>
                      )}
                    </div>
                    {(s.droppedTopics.length > 0 || s.vanishedPeople.length > 0) && (
                      <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-[color:var(--color-ink-3)]">
                        {s.droppedTopics.slice(0, 4).map((t) => (
                          <span key={t.topic} className="rounded px-1.5 py-0.5" style={{ background: 'rgba(255,255,255,0.04)' }}>
                            dropped: {t.topic}
                          </span>
                        ))}
                        {s.vanishedPeople.slice(0, 2).map((p) => (
                          <span key={p} className="rounded px-1.5 py-0.5" style={{ background: 'rgba(255,255,255,0.04)' }}>
                            {p} went quiet
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* PREDICTIVE — opportunities */}
          {deals.length > 0 && (
            <div>
              <SectionTitle>Opportunities: win read &amp; momentum</SectionTitle>
              <div className="flex flex-col gap-1.5">
                {deals.map((d) => (
                  <DealRow key={d.name + d.account} deal={d} onSetOutcome={handleSetDealOutcome} />
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
                          {[p.role, p.account].filter(Boolean).join(' @ ')}
                        </span>
                      )}
                    </span>
                    {/* Kept-promise reliability — only settled promises count (kept vs broken);
                        open ones prove nothing yet. Shown only once at least one is settled. */}
                    {(() => {
                      const kept = (p.commitments ?? []).filter((c) => c.status === 'kept').length
                      const broken = (p.commitments ?? []).filter((c) => c.status === 'broken').length
                      if (kept + broken === 0) return null
                      return (
                        <span
                          className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                          title={`${kept} kept, ${broken} broken (settled promises only)`}
                          style={{
                            color: broken > kept ? 'var(--color-danger)' : 'var(--color-success)',
                            background: 'rgba(255,255,255,0.05)'
                          }}
                        >
                          kept {kept}/{kept + broken}
                        </span>
                      )
                    })()}
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
            onClick={() => {
              void window.toto.brainOpenDashboard()
                .catch((e) => ({ ok: false, error: String(e) }))
                .then((r) => {
                  if (!r.ok) setError(r.error || 'Could not open Mantu Intelligence.')
                })
            }}
            className="no-drag focus-ring flex items-center justify-center gap-1.5 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-3 py-2 text-[11px] font-semibold text-[color:var(--color-ink-3)] hover:text-[color:var(--color-ink)]"
          >
            <ExternalLink size={12} /> Open the full Mantu Intelligence dashboard
          </button>
        </>
      )}
    </div>
  )
}
