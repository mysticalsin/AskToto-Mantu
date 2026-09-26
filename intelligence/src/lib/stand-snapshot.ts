/**
 * Cap3 — deterministic "Where do we stand?" snapshot.
 * Counts/overdue/deltas live in app code. Missing fields stay null (missing ≠ 0).
 * Jev may classify this evidence later; it must never invent these numbers.
 */

import type { DashboardData, Deal } from '../types/data'
import { agingBuckets, ledgerTotals } from './ledgerstats'

export const STAND_QUESTIONS = [
  'Where do we stand overall?',
  'What changed since last week?',
  'What needs attention?',
  "What's blocked?",
  'Overdue/unassigned?',
  'What needs me today?',
  'What evidence?'
] as const

export type StandQuestion = (typeof STAND_QUESTIONS)[number]

export type JevIntelLabel =
  | 'on track'
  | 'needs attention'
  | 'blocked'
  | 'stale'
  | 'insufficient'

export type StandFact =
  | { kind: 'count'; key: string; value: number; label: string }
  | { kind: 'missing'; key: string; label: string; reason: string }
  | { kind: 'list'; key: string; label: string; items: string[]; truncated?: number }

export type StandAnswer = {
  question: StandQuestion
  layer: 'deterministic'
  facts: StandFact[]
  summary: string
  evidenceLinks: Array<{ href: string; label: string }>
}

export type StandSnapshot = {
  generatedAt: number
  answers: StandAnswer[]
  /** Compact evidence blob safe for /v1/decide intel_* (no secrets/photos). */
  evidencePayload: Record<string, unknown>
  /** Heuristic local label before/without Jev — never claimed as Jev. */
  deterministicHint: JevIntelLabel
}

function openDeals(data: DashboardData): Deal[] {
  return (data.deals ?? []).filter((d) => d.outcome === 'open')
}

function weekAgoIso(now: number): string {
  return new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/**
 * Build deterministic stand answers. Never coerce absent counts to 0 when the
 * underlying collection itself is missing (null/undefined) — that is "insufficient".
 */
export function buildStandSnapshot(data: DashboardData, now = Date.now()): StandSnapshot {
  const dealsPresent = Array.isArray(data.deals)
  const peoplePresent = Array.isArray(data.people)
  const meetingsPresent = Array.isArray(data.meetings_feed) || typeof data.status?.meetings === 'number'

  const opens = dealsPresent ? openDeals(data) : []
  const goingCold = Array.isArray(data.going_cold) ? data.going_cold : null

  const allCommitments = dealsPresent
    ? opens.flatMap((d) => d.commitments ?? [])
    : null
  const ledger = allCommitments ? ledgerTotals(allCommitments) : null
  const aged = allCommitments ? agingBuckets(allCommitments.filter((c) => c.status === 'open'), now) : null

  const concerning = dealsPresent
    ? opens.filter((d) => d.win_likelihood_band === 'concerning')
    : null
  const ungraded = dealsPresent
    ? opens.filter((d) => d.win_likelihood_band == null)
    : null

  const since = weekAgoIso(now)
  const meetingsThisWeek = Array.isArray(data.meetings_feed)
    ? data.meetings_feed.filter((m) => typeof m?.date === 'string' && m.date >= since).length
    : typeof data.status?.meetings === 'number'
      ? null // status total exists but not a week delta — missing, not 0
      : null

  const attentionItems = dealsPresent
    ? opens
        .filter((d) => {
          const broken = (d.commitments ?? []).filter((c) => c.status === 'broken').length
          return (
            d.win_likelihood_band === 'concerning' ||
            broken > 0 ||
            d.velocity?.signal === 'no-hard-date-found'
          )
        })
        .map((d) => d.display_name)
    : null

  const blockedItems = dealsPresent
    ? opens
        .filter((d) => (d.commitments ?? []).some((c) => c.status === 'broken'))
        .map((d) => d.display_name)
    : null

  const overdueItems =
    aged && aged.buckets
      ? aged.buckets
          .filter((b) => b.label === '>90d' || b.label === '30-90d')
          .flatMap((b) => b.items.map((c) => c.text))
      : null

  const unassigned =
    allCommitments
      ? allCommitments.filter((c) => c.status === 'open' && (!c.by || !String(c.by).trim()))
      : null

  const needsMeToday = attentionItems

  const answers: StandAnswer[] = []

  // 1 overall
  {
    const facts: StandFact[] = []
    if (!dealsPresent) {
      facts.push({ kind: 'missing', key: 'openDeals', label: 'Open deals', reason: 'deals collection absent' })
    } else {
      facts.push({ kind: 'count', key: 'openDeals', value: opens.length, label: 'Open deals' })
      facts.push({
        kind: 'count',
        key: 'concerning',
        value: concerning!.length,
        label: 'Concerning band'
      })
      if (ungraded && ungraded.length > 0) {
        facts.push({
          kind: 'count',
          key: 'ungraded',
          value: ungraded.length,
          label: 'Ungraded (band missing — not treated as good)'
        })
      }
    }
    if (goingCold === null) {
      facts.push({ kind: 'missing', key: 'goingCold', label: 'Going cold', reason: 'going_cold absent' })
    } else {
      facts.push({ kind: 'count', key: 'goingCold', value: goingCold.length, label: 'Going cold' })
    }
    if (ledger === null) {
      facts.push({ kind: 'missing', key: 'broken', label: 'Broken commitments', reason: 'commitments absent' })
    } else {
      facts.push({ kind: 'count', key: 'broken', value: ledger.broken, label: 'Broken commitments' })
    }

    let summary: string
    if (!dealsPresent) {
      summary = 'Insufficient deal evidence — open-deal counts are missing, not zero.'
    } else if (concerning!.length > 0 || (ledger && ledger.broken > 0)) {
      summary = 'Pressure on open work: concerning bands and/or broken commitments need a look.'
    } else if (opens.length === 0) {
      summary = 'No open deals in the connected brain right now.'
    } else {
      summary = 'Open book looks steady on deterministic signals.'
    }

    answers.push({
      question: 'Where do we stand overall?',
      layer: 'deterministic',
      facts,
      summary,
      evidenceLinks: [{ href: '/deals', label: 'Deals' }, { href: '/stats', label: 'Stats' }]
    })
  }

  // 2 changed since last week
  {
    const facts: StandFact[] = []
    if (meetingsThisWeek === null) {
      facts.push({
        kind: 'missing',
        key: 'meetingsThisWeek',
        label: 'Meetings since last week',
        reason: meetingsPresent
          ? 'week delta unavailable from status totals alone'
          : 'meetings feed absent'
      })
    } else {
      facts.push({
        kind: 'count',
        key: 'meetingsThisWeek',
        value: meetingsThisWeek,
        label: 'Meetings since last week'
      })
    }
    answers.push({
      question: 'What changed since last week?',
      layer: 'deterministic',
      facts,
      summary:
        meetingsThisWeek === null
          ? 'Week-over-week meeting delta is insufficient — not shown as 0.'
          : meetingsThisWeek === 0
            ? 'No meetings dated in the last 7 days in the feed.'
            : `${meetingsThisWeek} meeting(s) in the last 7 days.`,
      evidenceLinks: [{ href: '/meetings', label: 'Meetings' }]
    })
  }

  // 3 needs attention
  {
    const facts: StandFact[] = []
    if (attentionItems === null) {
      facts.push({ kind: 'missing', key: 'attention', label: 'Needs attention', reason: 'deals absent' })
    } else {
      facts.push({ kind: 'count', key: 'attention', value: attentionItems.length, label: 'Needs attention' })
      if (attentionItems.length) {
        facts.push({
          kind: 'list',
          key: 'attentionList',
          label: 'Top',
          items: attentionItems.slice(0, 5),
          truncated: Math.max(0, attentionItems.length - 5)
        })
      }
    }
    answers.push({
      question: 'What needs attention?',
      layer: 'deterministic',
      facts,
      summary:
        attentionItems === null
          ? 'Attention list insufficient — deals missing.'
          : attentionItems.length
            ? `${attentionItems.length} open deal(s) flagged on real signals.`
            : 'Nothing flagged on concerning / broken / no-hard-date signals.',
      evidenceLinks: [{ href: '/', label: 'Today' }]
    })
  }

  // 4 blocked
  {
    const facts: StandFact[] = []
    if (blockedItems === null) {
      facts.push({ kind: 'missing', key: 'blocked', label: 'Blocked', reason: 'deals absent' })
    } else {
      facts.push({ kind: 'count', key: 'blocked', value: blockedItems.length, label: 'Blocked (broken commitments)' })
      if (blockedItems.length) {
        facts.push({
          kind: 'list',
          key: 'blockedList',
          label: 'Deals',
          items: blockedItems.slice(0, 5),
          truncated: Math.max(0, blockedItems.length - 5)
        })
      }
    }
    answers.push({
      question: "What's blocked?",
      layer: 'deterministic',
      facts,
      summary:
        blockedItems === null
          ? 'Blocked set insufficient — deals missing.'
          : blockedItems.length
            ? `${blockedItems.length} deal(s) with broken commitments.`
            : 'No broken-commitment blockers in open deals.',
      evidenceLinks: [{ href: '/deals', label: 'Deals' }]
    })
  }

  // 5 overdue/unassigned
  {
    const facts: StandFact[] = []
    if (overdueItems === null) {
      facts.push({ kind: 'missing', key: 'overdue', label: 'Overdue open commitments', reason: 'commitments absent' })
    } else {
      facts.push({ kind: 'count', key: 'overdue', value: overdueItems.length, label: 'Overdue (30d+)' })
    }
    if (unassigned === null) {
      facts.push({ kind: 'missing', key: 'unassigned', label: 'Unassigned open', reason: 'commitments absent' })
    } else {
      facts.push({ kind: 'count', key: 'unassigned', value: unassigned.length, label: 'Unassigned open' })
    }
    if (aged && aged.undated.length > 0) {
      facts.push({
        kind: 'count',
        key: 'undatedOpen',
        value: aged.undated.length,
        label: 'Open commitments with undated due (not aged into overdue)'
      })
    }
    answers.push({
      question: 'Overdue/unassigned?',
      layer: 'deterministic',
      facts,
      summary:
        overdueItems === null || unassigned === null
          ? 'Overdue/unassigned insufficient — commitment ledgers missing (not zero).'
          : `Overdue ${overdueItems.length}; unassigned ${unassigned.length}.`,
      evidenceLinks: [{ href: '/stats', label: 'Stats' }]
    })
  }

  // 6 needs me today
  {
    const facts: StandFact[] = []
    if (needsMeToday === null) {
      facts.push({ kind: 'missing', key: 'needsMe', label: 'Needs me today', reason: 'deals absent' })
    } else {
      facts.push({ kind: 'count', key: 'needsMe', value: needsMeToday.length, label: 'Needs me today' })
      if (needsMeToday.length) {
        facts.push({
          kind: 'list',
          key: 'needsMeList',
          label: 'Focus',
          items: needsMeToday.slice(0, 5),
          truncated: Math.max(0, needsMeToday.length - 5)
        })
      }
    }
    answers.push({
      question: 'What needs me today?',
      layer: 'deterministic',
      facts,
      summary:
        needsMeToday === null
          ? 'Today focus insufficient — deals missing.'
          : needsMeToday.length
            ? 'Start with the flagged open deals (same attention set).'
            : 'No deterministic "needs me" flags this morning.',
      evidenceLinks: [{ href: '/', label: 'Today' }]
    })
  }

  // 7 evidence
  {
    const facts: StandFact[] = [
      {
        kind: 'list',
        key: 'sources',
        label: 'Evidence surfaces',
        items: ['Open deals + bands', 'Commitments ledger', 'Going cold', 'Meetings feed']
      }
    ]
    if (!dealsPresent || !peoplePresent) {
      facts.push({
        kind: 'missing',
        key: 'brainCoverage',
        label: 'Brain coverage',
        reason: !dealsPresent ? 'deals absent' : 'people absent'
      })
    }
    answers.push({
      question: 'What evidence?',
      layer: 'deterministic',
      facts,
      summary: 'All stand answers cite dashboard fields already on disk — drill into Deals, Stats, Meetings.',
      evidenceLinks: [
        { href: '/deals', label: 'Deals' },
        { href: '/stats', label: 'Stats' },
        { href: '/meetings', label: 'Meetings' }
      ]
    })
  }

  // Local hint only (not Jev)
  let deterministicHint: JevIntelLabel = 'on track'
  if (!dealsPresent) deterministicHint = 'insufficient'
  else if (blockedItems && blockedItems.length > 0) deterministicHint = 'blocked'
  else if (goingCold && goingCold.length > 0 && concerning && concerning.length > 0) deterministicHint = 'needs attention'
  else if (goingCold && goingCold.length > 0) deterministicHint = 'stale'
  else if (attentionItems && attentionItems.length > 0) deterministicHint = 'needs attention'

  const evidencePayload: Record<string, unknown> = {
    openDeals: dealsPresent ? opens.length : null,
    concerning: concerning ? concerning.length : null,
    goingCold: goingCold ? goingCold.length : null,
    broken: ledger ? ledger.broken : null,
    overdue: overdueItems ? overdueItems.length : null,
    unassigned: unassigned ? unassigned.length : null,
    meetingsThisWeek,
    attention: attentionItems ? attentionItems.length : null,
    blocked: blockedItems ? blockedItems.length : null,
    generatedAt: now
  }

  return { generatedAt: now, answers, evidencePayload, deterministicHint }
}

export type StandLayers = {
  deterministic: StandSnapshot
  jev: {
    available: boolean
    label: JevIntelLabel | null
    confidence: number | null
    error?: string
  }
  explanation: {
    source: 'approved_llm' | 'none'
    text: string | null
    citesDeterministic: boolean
  }
  suggestedActionPreviewRequired: true
}

export function emptyJevLayer(error?: string): StandLayers['jev'] {
  return { available: false, label: null, confidence: null, error: error || 'decision assist unavailable' }
}

export function buildStandLayers(data: DashboardData, now = Date.now()): StandLayers {
  const deterministic = buildStandSnapshot(data, now)
  return {
    deterministic,
    jev: emptyJevLayer('Jev classify not requested yet'),
    explanation: {
      source: 'none',
      text: null,
      citesDeterministic: true
    },
    suggestedActionPreviewRequired: true
  }
}
