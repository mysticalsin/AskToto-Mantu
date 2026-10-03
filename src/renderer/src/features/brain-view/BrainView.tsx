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

import { BrainViewLayout } from './BrainViewLayout'
import {
  DealRow,
  MIXED_COLOR,
  PersonRow,
  SectionTitle,
  SectorBars,
  StatTile,
  TimeSavedCard,
  WeeklyBars,
  computeWeeklyBars,
  BAND_ORDER
} from './brain-widgets'

export { DealRow, computeWeeklyBars, type WeeklyBarData } from './brain-widgets'

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
  const [statusError, setStatusError] = useState<string | null>(null)
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
  // A full dashboard refresh reads every entity and meeting. During indexing, poll only the small status
  // payload for responsive progress, then hydrate the complete dashboard once the batch settles.
  const statusWasWorkingRef = useRef(false)
  const statusRevisionRef = useRef<number | undefined>(undefined)
  const refresh = useMemo(() => createBrainRefresh(
    async () => {
      const [read, st, list, att, settings] = await Promise.all([
        window.toto.brainRead(),
        window.toto.brainStatus(),
        window.toto.recallList(),
        window.toto.brainAttention(),
        window.toto.getSettings()
      ])
      return { read, st, list, att, settings }
    },
    ({ read, st, list, att, settings }) => {
      setData(read)
      setStatus(st)
      setMeetings(list)
      setAttention(att.items)
      setProviderReady(settings.providerReady)
      setLocalFallbackReady(settings.localFallbackReady)
      setLocalSummaryReady(settings.localSummaryReady)
      setUsageStats(settings.usageStats)
      setTimeSavedAssumptions(settings.timeSaved)
      setError(st?.error ?? null)
      setStatusError(null)
    },
    setError,
    () => setLoading(false)
  ), [])

  const refreshStatus = useCallback(async (): Promise<void> => {
    try {
      const st = await window.toto.brainStatus()
      setStatus(st)
      setStatusError(st ? null : INTELLIGENCE_STATUS_UNAVAILABLE)
    } catch {
      setStatusError(INTELLIGENCE_STATUS_UNAVAILABLE)
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
  const statusWorking = brainStatusIsWorking(status)
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
      const { error: clickError } = await runIntelligenceUpdateClick(() => window.toto.brainBackfill())
      if (clickError) {
        setError(clickError)
        return
      }
      await refresh()
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
    } finally {
      setBackfilling(false)
    }
  }, [refresh])

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
    () => [...(data?.people ?? [])].sort((a, b) => b.meetings.length - a.meetings.length),
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
  const visibleError = error || statusError || brainStatusError(status)

  return (
    <BrainViewLayout
      {...{
        record,
        data,
        openRecord,
        onOpenMeeting,
        refresh,
        setError,
        setRecentMerge,
        recentMerge,
        undoMerge,
        ingested,
        statusWorking,
        backfilling,
        meetings,
        runIntelligencePass,
        canIndex,
        onOpenSettings,
        bf,
        live,
        status,
        notIngested,
        startBackfill,
        usageStats,
        timeSavedAssumptions,
        nextStepsCount,
        attention,
        sectors,
        openPromises,
        openPromisesRef,
        settlePromise,
        mars,
        marsPrev,
        marsCopied,
        flashMarsCopied,
        silence,
        deals,
        handleSetDealOutcome,
        accountIdByName,
        people,
        resetCorruptionLock,
        onDashboardOpen,
        visibleError,
        failuresExpanded,
        setFailuresExpanded,
        indexProgress,
        durableFailed,
        topError,
        localFallbackReady, loading, setRecord, onBack
      }}
    />
  )
}
