import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { MantuMark } from '../../components/MantuMark'
import { TextButton } from '../../components/ui'
import { AgentStatus, InlineOrb } from '../../components/AgentStatus'
import { WorkProgressMeter } from '../../components/WorkProgressMeter'
import { useFlash } from '../../lib/useFlash'
import { BrainRecordPage, recordKey, sortAttentionItems, type BrainRecordRef, type RecentMerge } from '../brain-record-page/BrainRecordPage'
import { brainStatusError, brainStatusIsWorking, brainStatusPollInterval, shouldRefreshAfterBrainStatus } from '../../components/brain-status-refresh'
import { createBrainRefresh } from '../../components/brain-refresh'
import { INTELLIGENCE_STATUS_UNAVAILABLE, startIntelligenceUpdateFromClick } from '@shared/intelligence-pass'
import { describeMeetingIndexProgress } from '../../components/work-progress'
import { IntelligenceUpdateButton } from '../../components/IntelligenceUpdateButton'
import { NO_PROVIDER_INDEX_COPY, runIntelligenceUpdateClick } from '../../lib/intelligence-update'
import { VirtualList } from '../../ui/VirtualList'

export const MIXED_COLOR = 'var(--color-warn)'

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
export function TimeSavedCard({
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

export function StatTile({ value, label }: { value: number | string; label: string }): JSX.Element {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-2 py-2.5">
      <div className="font-ui text-[20px] font-semibold leading-none tracking-tight text-[color:var(--color-ink)]">
        {value}
      </div>
      <div className="text-[10px] font-medium uppercase tracking-wide text-[color:var(--color-ink-3)]">{label}</div>
    </div>
  )
}

export function SectionTitle({ children }: { children: React.ReactNode }): JSX.Element {
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
export function WeeklyBars({ meetings }: { meetings: MeetingSummary[] }): JSX.Element {
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
export function SectorBars({ sectors }: { sectors: { sector: string; n: number }[] }): JSX.Element {
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

export const DealRow = memo(function DealRow({
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
})

export const PersonRow = memo(function PersonRow({
  person,
  onOpenRecord
}: {
  person: BrainRead['people'][number]
  onOpenRecord: (kind: EntityKind, id: string) => void
}): JSX.Element {
  const kept = (person.commitments ?? []).filter((c) => c.status === 'kept').length
  const broken = (person.commitments ?? []).filter((c) => c.status === 'broken').length
  return (
    <div className="flex items-center gap-2 text-[12px]">
      <span className="min-w-0 flex-1 truncate text-[color:var(--color-ink-2)]">
        <button
          type="button"
          onClick={() => onOpenRecord('person', person.id)}
          className="no-drag focus-ring rounded font-semibold text-[color:var(--color-ink)] hover:underline"
        >
          {person.name}
        </button>
        {(person.role || person.account) && (
          <span className="text-[color:var(--color-ink-3)]">
            {' '}
            {[person.role, person.account].filter(Boolean).join(' @ ')}
          </span>
        )}
      </span>
      {kept + broken > 0 && (
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
      )}
      <span className="shrink-0 rounded-full bg-white/[0.05] px-2 py-0.5 text-[10px] font-semibold text-[color:var(--color-ink-3)]">
        {person.meetings.length}×
      </span>
    </div>
  )
})

export const BAND_ORDER: Record<string, number> = { concerning: 0, mixed: 1, good: 2 }
