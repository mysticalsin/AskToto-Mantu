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
  ChevronRight,
  ClipboardList,
  ExternalLink,
  FileWarning,
  HelpCircle,
  Minus,
  RefreshCw,
  Timer,
  TrendingUp,
  Users,
  VolumeX,
  X
} from 'lucide-react'
import type { BrainRead, BrainStatus, Band, DealEntity, EntityKind, LedgerCommitment } from '@shared/brain'
import type { AttentionItem, MeetingSummary, Settings } from '@shared/ipc'
import { computeSilence } from '@shared/silence'
import {
  DEFAULT_TIME_SAVED_ASSUMPTIONS,
  formatSavedTime,
  timeSavedFromTotals,
  type TimeSavedAssumptions
} from '@shared/time-saved'
import { buildMarsWeek, renderMarsMarkdown } from '@shared/mars'
import { MantuMark } from './MantuMark'
import { TextButton } from './ui'
import { AgentStatus, InlineOrb } from './AgentStatus'
import { WorkProgressMeter } from './WorkProgressMeter'
import { useFlash } from '../lib/useFlash'
import { BrainRecordPage, recordKey, sortAttentionItems, type BrainRecordRef, type RecentMerge } from './BrainRecordPage'
import { shouldAutoBackfill } from './brain-auto'
import { brainStatusPollInterval, shouldRefreshAfterBrainStatus } from './brain-status-refresh'
import { describeMeetingIndexProgress } from './work-progress'
import { IntelligenceUpdateButton } from './IntelligenceUpdateButton'
import {
  INTELLIGENCE_PASS_EMPTY,
  INTELLIGENCE_PASS_NO_PROVIDER,
  startIntelligenceUpdateFromClick
} from '@shared/intelligence-pass'

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

const WEEKS_SHOWN = 12

/**
 * The honest "time saved" card. Deliberately NOT styled like the measured KPI tiles beside it — it shows
 * an "≈", the word "estimate", and the assumption it rests on, because unlike meeting/people/deal counts
 * this is a projection, and this codebase never dresses a projection as a measured fact. Empty until the
 * first meeting is summarized (a "0 hours saved" would read as broken, not honest).
 */
function TimeSavedCard({
  usageStats,
  assumptions,
  nextSteps,
  onAdjust
}: {
  usageStats: Settings['usageStats']
  assumptions: TimeSavedAssumptions
  nextSteps: number
  onAdjust: () => void
}): JSX.Element | null {
  const saved = timeSavedFromTotals(usageStats, assumptions)
  if (saved.meetings === 0) {
    return (
      <div className="rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-3.5 py-3">
        <div className="flex items-center gap-2 text-[color:var(--color-ink-3)]">
          <Timer size={14} />
          <span className="text-[12px]">Summarize your first meeting to see the time you save.</span>
        </div>
      </div>
    )
  }
  const convHours = Math.round((saved.conversationMinutes / 60) * 10) / 10
  return (
    <div className="rounded-xl border border-[var(--color-hair-soft)] bg-gradient-to-b from-white/[0.04] to-white/[0.01] px-3.5 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-[color:var(--color-ink-3)]">
            <Timer size={12} /> Time saved with Métis
          </div>
          <div className="mt-1 font-ui text-[26px] font-semibold leading-none tracking-tight text-[color:var(--color-ink)]">
            ≈ {formatSavedTime(saved.savedMinutes)}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-[color:var(--color-ink-2)]">
            <span>{saved.meetings} meetings summarized</span>
            <span>{convHours}h of conversation captured</span>
            {nextSteps > 0 && <span>{nextSteps} next-steps extracted</span>}
          </div>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 border-t border-[var(--color-hair-soft)] pt-2">
        <span className="text-[10.5px] text-[color:var(--color-ink-3)]">
          Estimate: ~{saved.perMeetingAvgMin} min of write-up avoided per meeting.
        </span>
        <button
          type="button"
          onClick={onAdjust}
          className="focus-ring shrink-0 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium text-[color:var(--color-ink-3)] transition-colors hover:text-[color:var(--color-ink)]"
        >
          Adjust estimate <ChevronRight size={11} className="ml-0.5 inline align-middle" />
        </button>
      </div>
    </div>
  )
}

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

export interface WeeklyBarData {
  weeks: { w: number; n: number }[]
  max: number
  maxIdx: number
}

/**
 * The WEEKS_SHOWN meetings-per-week columns (oldest first), the bar scale, and the busiest column.
 * Pure and `now`-injected so the bucketing is testable across a DST boundary. Exported for unit testing.
 */
export function computeWeeklyBars(meetings: MeetingSummary[], now: number): WeeklyBarData {
  // Step back seven CALENDAR days at a time instead of subtracting 7*24h: `weekStart` returns local
  // Monday midnights, and consecutive local Monday midnights are 7d ± 1h apart across a DST
  // transition. Fixed-millisecond columns therefore miss every bucket key on the far side of a
  // transition (bars read zero) and, going into spring-forward, land on Sunday 23:00 — mislabelling
  // the axis too. `setDate` preserves the wall-clock fields, so each column stays a real Monday 00:00.
  const columns: number[] = []
  const cursor = new Date(weekStart(now))
  for (let i = 0; i < WEEKS_SHOWN; i++) {
    columns.unshift(cursor.getTime())
    cursor.setDate(cursor.getDate() - 7)
  }
  const counts = new Map<number, number>()
  for (const m of meetings) {
    const ms = Date.parse(m.date)
    if (isNaN(ms)) continue
    const w = weekStart(ms)
    counts.set(w, (counts.get(w) || 0) + 1)
  }
  // No range guard needed: a bucket outside the 12 columns is simply never read.
  const weeks = columns.map((w) => ({ w, n: counts.get(w) || 0 }))
  const max = Math.max(1, ...weeks.map((x) => x.n))
  const maxIdx = weeks.reduce((best, x, i) => (x.n > weeks[best].n ? i : best), 0)
  return { weeks, max, maxIdx }
}

/** Meetings-per-week bars: single hue, thin marks, rounded data ends, native tooltips per bar. */
function WeeklyBars({ meetings }: { meetings: MeetingSummary[] }): JSX.Element {
  const { weeks, max, maxIdx } = useMemo(() => computeWeeklyBars(meetings, Date.now()), [meetings])

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
  onSetOutcome,
  onOpenRecord,
  accountIdByName
}: {
  deal: DealEntity
  onSetOutcome: (deal: DealEntity, outcome: 'open' | 'won' | 'lost') => void
  onOpenRecord: (kind: EntityKind, id: string) => void
  accountIdByName: Map<string, string>
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
          <button
            type="button"
            onClick={() => onOpenRecord('deal', deal.id)}
            className="no-drag focus-ring rounded hover:underline"
          >
            {deal.name}
          </button>
          {deal.account &&
            (accountIdByName.has(deal.account) ? (
              <button
                type="button"
                onClick={() => onOpenRecord('account', accountIdByName.get(deal.account)!)}
                className="no-drag focus-ring rounded font-normal text-[color:var(--color-ink-3)] hover:text-[color:var(--color-ink)] hover:underline"
              >
                {' '}
                · {deal.account}
              </button>
            ) : (
              <span className="font-normal text-[color:var(--color-ink-3)]"> · {deal.account}</span>
            ))}
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

export function BrainView({
  onBack,
  onOpenMeeting,
  onOpenSettings,
  onDashboardOpen
}: {
  onBack: () => void
  /** Opens a saved meeting read-only (the same handler History/Settings use) — record pages' provenance
   *  chips and meeting timelines, and the Attention section's jump action, all resolve through this. */
  onOpenMeeting?: (file: string) => void
  /** Opens Settings → AI — this view and Settings live in the same window, so this is just a `setView`
   *  swap in App.tsx, not a new cross-window mechanism. Wired into the no-provider CTAs below. */
  onOpenSettings?: () => void
  /** Optional: called once the full Mantu Intelligence dashboard window actually opened successfully —
   *  App.tsx uses this to minimize this in-bar glance panel so it isn't fighting the new window for
   *  screen space. Never called on failure (the error stays visible in THIS panel for the user to read). */
  onDashboardOpen?: () => void
}): JSX.Element {
  const [data, setData] = useState<BrainRead | null>(null)
  const [marsCopied, flashMarsCopied] = useFlash(2000)
  const [status, setStatus] = useState<BrainStatus | null>(null)
  const [meetings, setMeetings] = useState<MeetingSummary[]>([])
  const [attention, setAttention] = useState<AttentionItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [backfilling, setBackfilling] = useState(false)
  // FIX 4: per-file failure detail is collapsed by default — the banner's single-line summary is enough
  // for the common case, this is an opt-in drill-down for "which files, exactly, and why".
  const [failuresExpanded, setFailuresExpanded] = useState(false)
  // Drill-down record page (Task MI-3) — in-component navigation state, matching how this dashboard
  // already handles internal sections (no router). Cleared implicitly whenever the header's Back arrow
  // pops it, so returning to the dashboard is always one click regardless of how deep a merge chain went.
  const [record, setRecord] = useState<BrainRecordRef | null>(null)
  // Survives ACROSS a post-merge navigation (record changes to the surviving entity) — lifted up here
  // rather than owned by BrainRecordPage itself, which remounts fresh on every record change.
  const [recentMerge, setRecentMerge] = useState<RecentMerge | null>(null)
  // Whether an AI provider is configured/keyed. Backfill silently no-ops on the main side when this
  // is false (see src/main/brain/ingest.ts startBackfill), so the button must reflect it instead of
  // giving zero feedback on click. Defaults true so it never flashes disabled before the first read.
  const [providerReady, setProviderReady] = useState(true)
  // Métis Local as a safety net: with zero cloud/CLI providers configured (or all down), ingest.ts's
  // pickProviderCandidates still routes to the on-device model as the last candidate — so the readiness
  // gates below must OR this in, or a local-only setup would show "connect a provider" while indexing
  // actually works. Defaults false (opt-in setting) so nothing flashes enabled before the first read.
  const [localFallbackReady, setLocalFallbackReady] = useState(false)
  // The OTHER local indexing route: useFor.summary makes local the exclusive extraction provider
  // (ingest.ts's early-return branch), fully independent of the fallback toggle — a local-only privacy
  // setup with fallback off still indexes, so canIndex must OR this in too.
  const [localSummaryReady, setLocalSummaryReady] = useState(false)
  // Durable lifetime usage + the adjustable write-up assumption, for the honest "time saved" card. From
  // the settings snapshot (usageStats survives retention deletion, so the figure stays true after old
  // transcripts are purged). See shared/time-saved.ts for the estimate's model.
  const [usageStats, setUsageStats] = useState<Settings['usageStats']>({
    meetingsSummarized: 0,
    conversationMinutes: 0,
    firstMeetingAt: 0
  })
  const [timeSavedAssumptions, setTimeSavedAssumptions] = useState<TimeSavedAssumptions>(
    DEFAULT_TIME_SAVED_ASSUMPTIONS
  )
  // Guards against overlapping polls during a long backfill: brainRead can take longer than the 4s
  // poll interval as ingestion grows, so without this an older, slower-resolving snapshot can land
  // after a newer one and make the KPI tiles/lists visibly jump backward.
  const refreshingRef = useRef(false)
  // A full dashboard refresh reads every entity and meeting. During indexing, poll only the small status
  // payload for responsive progress, then hydrate the complete dashboard once the batch settles.
  const statusWasWorkingRef = useRef(false)
  const statusRevisionRef = useRef<number | undefined>(undefined)
  // Opening Mantu Intelligence is an explicit request for current knowledge. Start one automatic pass
  // for saved transcripts that predate the brain, without re-triggering it on each progress poll.
  const autoBackfillAttemptedRef = useRef(false)

  const refresh = useCallback(async (): Promise<void> => {
    if (refreshingRef.current) return
    refreshingRef.current = true
    try {
      const [read, st, list, att, settings] = await Promise.all([
        window.toto.brainRead(),
        window.toto.brainStatus(),
        window.toto.recallList(),
        window.toto.brainAttention(),
        window.toto.getSettings()
      ])
      setData(read)
      setStatus(st)
      if (st?.error) setError(st.error)
      setMeetings(list)
      setAttention(att.items)
      setProviderReady(settings.providerReady)
      setLocalFallbackReady(settings.localFallbackReady)
      setLocalSummaryReady(settings.localSummaryReady)
      setUsageStats(settings.usageStats)
      setTimeSavedAssumptions(settings.timeSaved)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
      refreshingRef.current = false
    }
  }, [])

  const refreshStatus = useCallback(async (): Promise<void> => {
    try {
      const st = await window.toto.brainStatus()
      setStatus(st)
      if (st?.error) setError(st.error)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const openRecord = useCallback((kind: EntityKind, id: string) => setRecord({ kind, id }), [])

  // MI-2.5 review round 3: in-app recovery from a durable correction-journal corruption lock — clears the
  // sentinel (the quarantined copy is left for inspection) so corrections resume, then re-reads. Without
  // this the only fix was hand-deleting a hidden .brain/corrections.corruption.lock in the OneDrive folder.
  const resetCorruptionLock = useCallback(async (): Promise<void> => {
    try {
      await window.toto.brainClearJournalCorruption()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
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

  // Keep compact status polling alive even while idle. A new live ingest can begin after this view mounts;
  // a full read is only needed when work settles, so this stays responsive without re-reading the brain.
  const backfillRunning = !!status?.backfill?.running
  const liveRunning = !!status?.live?.running
  const preparing = !!status?.backfill?.preparing
  const statusWorking = backfillRunning || liveRunning || preparing
  useEffect(() => {
    void refreshStatus()
    const t = setInterval(() => void refreshStatus(), brainStatusPollInterval(statusWorking))
    return () => clearInterval(t)
  }, [statusWorking, refreshStatus])

  useEffect(() => {
    const revision = status?.revision
    const shouldRefresh = shouldRefreshAfterBrainStatus({
      previousRevision: statusRevisionRef.current,
      revision,
      wasWorking: statusWasWorkingRef.current,
      isWorking: statusWorking
    })
    if (typeof revision === 'number') statusRevisionRef.current = revision
    statusWasWorkingRef.current = statusWorking
    if (shouldRefresh) void refresh()
  }, [status?.revision, statusWorking, refresh])

  const startBackfill = useCallback(async (): Promise<void> => {
    setBackfilling(true)
    setError(null)
    try {
      const result = await window.toto.brainBackfill()
      if (result.deferred === 'no-provider' || result.error) {
        setError(
          result.error ||
            'Connect an AI provider in Settings → AI, or enable Métis Local there to index meetings on this device.'
        )
        return
      }
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBackfilling(false)
    }
  }, [refresh])

  const runIntelligencePass = useCallback(async (): Promise<void> => {
    setBackfilling(true)
    try {
      await startIntelligenceUpdateFromClick({
        runPass: () => window.toto.brainIntelligencePass(),
        refresh,
        setError
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBackfilling(false)
    }
  }, [refresh])

  // Existing meetings used to wait indefinitely for a manual "Index meetings" click. New saves already
  // enqueue themselves in the main process; this covers the backlog when the in-app Intelligence view is
  // opened and keeps the manual button as an explicit retry/recovery path.
  useEffect(() => {
    if (!status) return
    if (
      shouldAutoBackfill({
        attempted: autoBackfillAttemptedRef.current,
        loading,
        running: statusWorking,
        savedMeetings: meetings.length,
        ingestedMeetings: status.meetings,
        savedMeetingFiles: meetings.map(({ file }) => file),
        ingestedFiles: status.ingestedFiles
      })
    ) {
      autoBackfillAttemptedRef.current = true
      void startBackfill()
    }
  }, [statusWorking, loading, meetings.length, startBackfill, status])

  // Undo a just-completed merge (the record page's post-merge banner) — restores both sides from the
  // journal snapshot and lands back on the just-restored (fromId) record.
  const undoMerge = useCallback(async (): Promise<void> => {
    if (!recentMerge) return
    const { seq, kind, fromId } = recentMerge
    const r = await window.toto.brainEntityUnmerge(seq)
    if (r.ok) {
      setRecentMerge(null)
      await refresh()
      setRecord({ kind, id: fromId })
    } else {
      setError(r.error ?? 'Could not undo the merge.')
    }
  }, [recentMerge, refresh])

  // Account name → id, so an account mentioned inline elsewhere (a deal's `.account` string) can jump to
  // its record page — those call sites only ever hold the display name, not the entity id.
  const accountIdByName = useMemo(() => {
    const map = new Map<string, string>()
    for (const a of data?.accounts ?? []) map.set(a.name, a.id)
    return map
  }, [data])

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

  // Commitment Ledger: every open promise across all deals AND deal-less person ledgers, oldest first
  // (age = urgency). A meeting with no deal only ever lands its spoken commitments on the SPEAKER's
  // person ledger (see ingest.ts's mergeExtraction comment: "in a deal-less meeting... such commitments
  // live ONLY here"), so a deal-only source silently dropped them from this rail. Dedupe by normalized
  // text+by: the SAME commitment can appear on BOTH a deal's ledger and its speaker's person ledger when
  // a meeting has both (a deal takes every commitment spoken in the meeting; a person's ledger only takes
  // the ones THEY spoke) — both copies originate from the identical extracted `c.text`/`c.by`, so a plain
  // trim+lowercase match is exact here without replicating ingest.ts's fuller commitmentKey.
  const openPromises = useMemo(() => {
    const dedupeKey = (c: LedgerCommitment): string => `${c.text.trim().toLowerCase()}|${c.by.trim().toLowerCase()}`
    const seen = new Set<string>()
    const all: (LedgerCommitment & { deal?: string; person?: string })[] = []
    for (const d of data?.deals ?? []) {
      for (const c of d.commitments ?? []) {
        if (c.status !== 'open') continue
        const key = dedupeKey(c)
        if (seen.has(key)) continue
        seen.add(key)
        all.push({ ...c, deal: d.name })
      }
    }
    for (const p of data?.people ?? []) {
      for (const c of p.commitments ?? []) {
        if (c.status !== 'open') continue
        const key = dedupeKey(c)
        if (seen.has(key)) continue
        seen.add(key)
        all.push({ ...c, person: p.name })
      }
    }
    return all.sort((a, b) => (a.date || '').localeCompare(b.date || '')).slice(0, 8)
  }, [data])

  // Distinct next-steps (commitments) extracted across the brain, for the time-saved card's context line.
  // Deduped by text so a commitment landing on both a deal and its speaker's ledger counts once.
  const nextStepsCount = useMemo(() => {
    const seen = new Set<string>()
    for (const d of data?.deals ?? []) for (const c of d.commitments ?? []) seen.add((c.text || '').trim().toLowerCase())
    for (const p of data?.people ?? []) for (const c of p.commitments ?? []) seen.add((c.text || '').trim().toLowerCase())
    seen.delete('')
    return seen.size
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

  // Indexing can actually run when a cloud/CLI provider is configured, OR the local safety net is live,
  // OR the exclusive local-summary route is on — the three branches of ingest.ts's
  // pickProviderCandidates, so the CTA/hint states below never claim "no provider" while indexing would
  // actually succeed.
  const canIndex = providerReady || localFallbackReady || localSummaryReady
  const ingested = status?.meetings ?? 0
  const notIngested = Math.max(0, meetings.length - ingested)
  const bf = status?.backfill
  const live = status?.live
  const indexProgress = bf ? describeMeetingIndexProgress(bf) : null
  // T6 6c: durable counts (status.failed/exhausted), not the ephemeral bf.failed above — a fixed-then-
  // reopened dashboard must still show the banner while any source has ok:false, even across a reconcile
  // tick that reset the per-run counter to 0 in between.
  const durableFailed = (status?.failed ?? 0) + (status?.exhausted ?? 0)
  const topError = status?.topError

  return (
    <div className="fade-up flex flex-col gap-3 px-1 py-1">
      {/* Header — Mantu-branded */}
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          aria-label="Back"
          // A record page pops back to the dashboard first; only a second Back leaves Mantu Intelligence
          // entirely — matching how every other in-component drill-down in this app layers Escape/Back.
          onClick={() => (record ? setRecord(null) : onBack())}
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
            {record
              ? 'Record'
              : status?.lastIndexedAt
                ? `Last indexed ${new Date(status.lastIndexedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
                : 'Your meeting knowledge, compounding. Grounded in transcripts, never invented.'}
          </div>
        </div>
        <IntelligenceUpdateButton
          running={backfilling || statusWorking}
          onClick={() => void runIntelligencePass()}
        />
        <button
          type="button"
          onClick={() => void startBackfill()}
          disabled={backfilling}
          title="Recap missing summaries and extract people, accounts, deals, coaching, and Today"
          className="no-drag focus-ring flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] font-semibold text-[color:var(--color-ink-2)] hover:bg-white/[0.06] hover:text-[color:var(--color-ink)] disabled:opacity-50"
        >
          {backfilling || statusWorking ? <InlineOrb kind="searching" /> : <RefreshCw size={13} />}
          {backfilling || statusWorking ? 'Updating…' : 'Update Intelligence'}
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-1.5 text-[11px] text-[var(--color-danger)]">
          {error}
        </div>
      )}

      {durableFailed > 0 && !bf?.running && (
        <div
          className="rounded-xl border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-[11px] text-[var(--color-danger)]"
          role="alert"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <AlertTriangle size={13} className="shrink-0" />
              <span>
                {topError
                  ? `Your AI provider is failing: ${topError}. Check Settings → AI`
                  : indexProgress?.label ?? 'Some meetings need attention.'}
              </span>
            </div>
            <span className="flex shrink-0 items-center gap-1">
              {/* Per-file detail (FIX 4): failedDetails is bounded (up to 20) by main — never the whole
                  ledger — so this toggle is safe to render unconditionally once any detail exists. */}
              {(status?.failedDetails?.length ?? 0) > 0 && (
                <button
                  type="button"
                  onClick={() => setFailuresExpanded((v) => !v)}
                  aria-expanded={failuresExpanded}
                  className="no-drag focus-ring shrink-0 rounded-full px-2 py-1 text-[11px] font-semibold text-[color:var(--color-danger)] hover:bg-white/[0.08]"
                >
                  {failuresExpanded ? 'Hide' : 'Details'}
                </button>
              )}
              <button
                type="button"
                onClick={() => void startBackfill()}
                disabled={backfilling}
                className="no-drag focus-ring shrink-0 rounded-full bg-white/[0.08] px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-ink)] hover:bg-white/[0.14] disabled:opacity-50"
              >
                Retry index
              </button>
            </span>
          </div>
          {failuresExpanded && (status?.failedDetails?.length ?? 0) > 0 && (
            <ul className="mt-2 flex list-disc flex-col gap-0.5 border-t border-[var(--color-danger)]/20 pl-4 pt-2 text-[color:var(--color-ink-2)]">
              {status!.failedDetails!.map((d) => (
                <li key={d.file} className="truncate" title={`${d.file}: ${d.error}`}>
                  <span className="font-medium">{d.file}</span>
                  {d.exhausted ? ' (exhausted): ' : ': '}
                  {d.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {loading && !data ? (
        <div className="flex items-center justify-center py-10">
          <AgentStatus kind="searching" size="hero" />
        </div>
      ) : record && data ? (
        <BrainRecordPage
          // Force a genuine remount on every record change (incl. direct record→record transitions:
          // post-merge onOpenRecord to the survivor, post-undo setRecord to the restored source).
          // Without this React reuses the instance and leftover local edit state (header rename draft,
          // each FieldCard's editing/draft/pending) would survive the swap and save to the WRONG entity
          // — a misattribution the whole correction feature exists to prevent. See recordKey's doc.
          key={recordKey(record)}
          recordRef={record}
          data={data}
          onOpenRecord={openRecord}
          onOpenMeeting={onOpenMeeting}
          onRefresh={refresh}
          onError={setError}
          onMerged={setRecentMerge}
          recentMerge={recentMerge}
          onUndoMerge={() => void undoMerge()}
          onDismissMerge={() => setRecentMerge(null)}
        />
      ) : ingested === 0 && !bf?.running && !live?.running && !backfilling && !preparing ? (
        /* Empty state — the brain has not ingested anything yet. */
        <div className="flex flex-col items-center gap-3 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-6 py-8 text-center">
          <Brain size={28} className="text-[color:var(--color-accent-2)]" />
          <div className="text-[13px] font-semibold text-[color:var(--color-ink)]">
            Build your intelligence from {meetings.length > 0 ? `${meetings.length} saved meeting${meetings.length === 1 ? '' : 's'}` : 'your meetings'}
          </div>
          <div className="max-w-[380px] text-[12px] leading-snug text-[color:var(--color-ink-3)]">
            {meetings.length > 0
              ? 'Métis extracts people, accounts, deals, and win/loss signals from every saved transcript. Update Intelligence to run that pass now. Local AI is first, then your API if Local cannot run.'
              : INTELLIGENCE_PASS_EMPTY}
          </div>
          <IntelligenceUpdateButton
            running={backfilling || statusWorking}
            disabled={meetings.length === 0}
            onClick={() => void startBackfill()}
          />
          {/* canIndex ORs in localFallbackReady — a local-only setup already indexes fine, so this must
              only claim "no provider" when NEITHER a cloud provider NOR the local safety net is live. */}
          {!canIndex && meetings.length > 0 && (
            <div className="flex flex-col items-center gap-0.5 text-[11px] text-[color:var(--color-ink-3)]">
              <span>{INTELLIGENCE_PASS_NO_PROVIDER}</span>
              {onOpenSettings && <TextButton onClick={onOpenSettings}>Open Settings</TextButton>}
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Backfill progress + drift note */}
          {bf?.running ? (
            <div className="rounded-xl border border-[var(--color-hair-soft)] bg-[var(--color-accent-soft)] px-3 py-2 text-[11px] text-[color:var(--color-ink-2)]">
              <div className="flex items-center gap-2">
                <InlineOrb kind="searching" />
                <span aria-atomic="true" aria-live="polite">{indexProgress?.label ?? 'Updating…'}</span>
              </div>
              <WorkProgressMeter
                active
                ariaLabel="Mantu Intelligence meeting index progress"
                className="mt-1.5"
                percent={indexProgress?.percent ?? null}
                valueText={indexProgress?.valueText ?? 'Mapping meetings'}
              />
            </div>
          ) : live?.running ? (
            <div className="rounded-xl border border-[var(--color-hair-soft)] bg-[var(--color-accent-soft)] px-3 py-2 text-[11px] text-[color:var(--color-ink-2)]">
              <div className="flex items-center gap-2">
                <InlineOrb kind="searching" />
                <span aria-atomic="true" aria-live="polite">
                  Updating Intelligence from {live.pending} new meeting{live.pending === 1 ? '' : 's'}…
                </span>
              </div>
            </div>
          ) : notIngested > 0 ? (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-3 py-1.5 text-[11px] text-[color:var(--color-ink-3)]">
              <span>
                {notIngested} saved meeting{notIngested === 1 ? '' : 's'} not in the brain yet.
                {!canIndex && ' Connect an AI provider in Settings to ingest them.'}
              </span>
              <span className="flex shrink-0 items-center gap-1">
                {!canIndex && onOpenSettings && <TextButton onClick={onOpenSettings}>Open Settings</TextButton>}
                <button
                  type="button"
                  onClick={() => void startBackfill()}
                  disabled={backfilling}
                  className="no-drag focus-ring shrink-0 rounded-full bg-white/[0.06] px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-ink-2)] hover:bg-white/10 disabled:opacity-50"
                >
                  {backfilling || statusWorking ? 'Updating…' : 'Update Intelligence'}
                </button>
              </span>
            </div>
          ) : null}

          {/* Honest time-saved estimate — above the measured tiles, visibly distinct from them. */}
          <TimeSavedCard
            usageStats={usageStats}
            assumptions={timeSavedAssumptions}
            nextSteps={nextStepsCount}
            onAdjust={() => onOpenSettings?.()}
          />

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

          {/* ATTENTION — lint contradictions, AMBIGUOUS fields, and pins a later meeting disputed. Never
              auto-resolved; each row jumps straight to the entity's record page. Empty state is a single
              quiet line (not a panel) — an empty queue is good news, not a gap to explain. */}
          <div>
            <div className="mb-1.5 flex items-center gap-1.5">
              <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
                <AlertTriangle size={11} /> Attention
              </span>
              {attention.length > 0 && (
                <span className="rounded-full bg-white/[0.08] px-1.5 py-px text-[10px] font-semibold text-[color:var(--color-ink-2)]">
                  {attention.length}
                </span>
              )}
            </div>
            {attention.length === 0 ? (
              <div className="text-[12px] text-[color:var(--color-ink-3)]">Nothing needs a look right now.</div>
            ) : (
              <div className="flex flex-col gap-1 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-3 py-2.5">
                {sortAttentionItems(attention)
                  .slice(0, 8)
                  .map((item, i) => (
                    <button
                      key={`${item.kind}:${item.entityKind ?? 'file'}:${item.id}:${i}`}
                      type="button"
                      // 'ingest_failed' has no entity to jump to (see AttentionItemSchema's doc comment)
                      // — its `id` is the source filename, so it opens the transcript instead.
                      onClick={() =>
                        item.kind === 'ingest_failed' ? onOpenMeeting?.(item.id) : openRecord(item.entityKind!, item.id)
                      }
                      className="no-drag focus-ring flex items-center gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-white/[0.06]"
                    >
                      {item.kind === 'ingest_failed' && (
                        <FileWarning size={12} className="shrink-0 text-[color:var(--color-danger)]" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="text-[12px] font-semibold text-[color:var(--color-ink)]">{item.label}</span>
                        <span className="block truncate text-[11px] text-[color:var(--color-ink-3)]">{item.detail}</span>
                      </span>
                      <ChevronRight size={13} className="shrink-0 text-[color:var(--color-ink-3)]" />
                    </button>
                  ))}
              </div>
            )}
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

          {/* COMMITMENT LEDGER — open promises across every deal AND deal-less person ledger, oldest
              (most urgent) first. */}
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
                  // A person-only row (no deal.commitments source, see the useMemo above) has no deal to
                  // settle against — settleCommitment (ingest.ts) is deal-keyed only, a known limitation,
                  // not a bug — so the Kept/Broken actions only render for deal-backed rows.
                  const dealName = c.deal
                  return (
                    <div key={c.meeting + c.text + (c.deal ?? c.person ?? '')} className="flex items-center gap-2 text-[12px]" title={c.quote || undefined}>
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
                      {/* Deal name today, the speaker's own name for a deal-less commitment — same slot,
                          same subdued styling, so the source reads without shouting either way. */}
                      <span
                        className="min-w-0 max-w-[90px] shrink truncate text-[10px] text-[color:var(--color-ink-3)]"
                        title={dealName ?? c.person}
                      >
                        {dealName ?? c.person}
                      </span>
                      {/* Settlement — the human closes the loop. Settled rows leave this rail on refresh
                          and feed the per-person kept-promise reliability read. Deal-backed rows only. */}
                      {dealName && (
                        <span className="flex shrink-0 items-center gap-0.5">
                          <button
                            type="button"
                            aria-label="Mark kept"
                            title="Kept: promise delivered"
                            onClick={() => void settlePromise(dealName, c.text, 'kept')}
                            className="no-drag focus-ring grid h-5 w-5 place-items-center rounded text-[color:var(--color-ink-3)] hover:bg-white/10 hover:text-[var(--color-success)]"
                          >
                            <Check size={11} />
                          </button>
                          <button
                            type="button"
                            aria-label="Mark broken"
                            title="Broken: promise not delivered"
                            onClick={() => void settlePromise(dealName, c.text, 'broken')}
                            className="no-drag focus-ring grid h-5 w-5 place-items-center rounded text-[color:var(--color-ink-3)] hover:bg-white/10 hover:text-[var(--color-danger)]"
                          >
                            <X size={11} />
                          </button>
                        </span>
                      )}
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
                    navigator.clipboard
                      .writeText(renderMarsMarkdown(mars))
                      .then(() => {
                        flashMarsCopied()
                      })
                      .catch((e) => setError(`Copy failed: ${e instanceof Error ? e.message : String(e)}`))
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
                  <DealRow
                    key={d.name + d.account}
                    deal={d}
                    onSetOutcome={handleSetDealOutcome}
                    onOpenRecord={openRecord}
                    accountIdByName={accountIdByName}
                  />
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
                      <button
                        type="button"
                        onClick={() => openRecord('person', p.id)}
                        className="no-drag focus-ring rounded font-semibold text-[color:var(--color-ink)] hover:underline"
                      >
                        {p.name}
                      </button>
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

          {/* MI-2.5 review round 3: "Corrections paused" — always shown ABOVE the lint list (which is
              sliced to 5 and could otherwise push this off-screen). Covers a durable corruption lock
              (status.corruptionBlocked → offer the in-app "Reset corrections lock" recovery) and/or a
              failed rebuild replay (index.replayError, surfaced distinctly here rather than lost in the
              lint slice). The replay-failure warning string is filtered out of the lint list below to
              avoid duplication. */}
          {(status?.corruptionBlocked || data?.index.replayError) && (
            <div className="rounded-xl border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-3 py-2.5">
              <SectionTitle>
                <AlertTriangle size={11} className="mr-1 inline" />
                Corrections paused
              </SectionTitle>
              <div className="text-[11px] text-[color:var(--color-ink-2)]">
                {data?.index.replayError
                  ? `A rebuild could not re-apply your saved corrections: ${data.index.replayError}`
                  : 'The correction journal on this device was locked after a corruption was detected and preserved. Your prior corrections are safe in a preserved copy.'}
              </div>
              {status?.corruptionBlocked && (
                <button
                  type="button"
                  onClick={() => void resetCorruptionLock()}
                  className="no-drag focus-ring mt-2 rounded-lg border border-[var(--color-hair-soft)] bg-white/[0.04] px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-ink)] hover:bg-white/[0.08]"
                >
                  Reset corrections lock
                </button>
              )}
            </div>
          )}

          {/* MQA-230: a deleted meeting's transcript + extraction are removed synchronously, but items
              attributed to it inside entity files wait on the next source refresh (needs a usable
              provider). Say so — a silent wait reads as a completed delete. */}
          {status?.cleanupPending && (
            <div className="rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.03] px-3 py-2 text-[11px] text-[color:var(--color-ink-2)]">
              Cleanup after a deleted meeting is pending — references to it are removed automatically the
              next time indexing runs.
            </div>
          )}

          {/* Lint warnings — contradictions the ingest refused to auto-resolve (the replay-failure notice
              is shown in the banner above, so it's filtered out here to avoid duplication + being cut off). */}
          {(() => {
            const lint = (data?.index.warnings ?? []).filter((w) => !w.includes('re-apply your saved corrections'))
            return lint.length > 0 ? (
              <div className="rounded-xl border border-[var(--color-danger)]/20 bg-[var(--color-danger)]/5 px-3 py-2">
                <SectionTitle>
                  <AlertTriangle size={11} className="mr-1 inline" />
                  Needs a human read
                </SectionTitle>
                <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[11px] text-[color:var(--color-ink-3)]">
                  {lint.slice(0, 5).map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            ) : null
          })()}

          {/* Footer: escalate from this in-overlay glance to the full dedicated dashboard window */}
          <button
            type="button"
            onClick={() => {
              void window.toto.brainOpenDashboard()
                .catch((e) => ({ ok: false, error: String(e) }))
                .then((r) => {
                  if (!r.ok) setError(r.error || 'Could not open Mantu Intelligence.')
                  else onDashboardOpen?.()
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
