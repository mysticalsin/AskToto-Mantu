import type { MeetingExtraction, DealEntity, LedgerCommitment } from './brain'
import { RENDERABLE_PROVENANCE_STATES } from './brain'

/**
 * Mars week draft — pre-fill for the weekly Mars report (prospection meetings, cold calls, QMs,
 * projects won / lost, follow-ups). Filling Mars by memory every Friday means re-deriving a week
 * the brain already recorded; this assembles the factual skeleton so the human only classifies
 * and polishes.
 *
 * Epistemics, deliberately strict: everything here is COUNTED or QUOTED from the week's meeting
 * extractions and deal entities — never predicted, never invented. Mars-specific buckets the data
 * cannot prove (was that meeting a "QM" or a prospection call?) are NOT guessed: meetings are listed
 * with their observable facts (account, stage, band, sentiment) under neutral headings, and the
 * won/lost sections come only from human-set deal outcomes. Pure functions; `now` injected.
 */

const DAY = 24 * 60 * 60 * 1000

export interface MarsMeetingRow {
  date: string
  title: string
  account: string // '' when the meeting had no account (internal/personal)
  stage: string
  band: string // win-likelihood band or ''
  sentiment: string
  firstContact: boolean // first meeting ever recorded with this account — prospection candidate
}

export interface MarsWeek {
  weekStart: string // ISO date (inclusive)
  weekEnd: string // ISO date (inclusive)
  meetings: MarsMeetingRow[]
  newAccounts: string[] // accounts whose FIRST recorded meeting is inside the week
  won: { name: string; account: string }[] // human-marked outcomes only
  lost: { name: string; account: string }[]
  openFollowups: { text: string; by: string; due_hint: string; deal: string; date: string }[]
  atRisk: { name: string; account: string; evidence: string }[] // concerning band on an open deal
  // MI-4 — the verified numbers lane. OPEN deals' amounts, summed per currency (no FX conversion), but
  // ONLY where the amount sidecar's state is verified/pinned/edited (RENDERABLE_PROVENANCE_STATES) — an
  // 'extracted' (unverified LLM guess) amount must never contribute to a headline pipeline figure. []
  // when nothing qualifies; renderMarsMarkdown omits the section entirely in that case.
  pipelineValue: { currency: string; total: number }[]
}

const isoDay = (t: number): string => new Date(t).toISOString().slice(0, 10)

function parse(d: string): number {
  const t = new Date(d).getTime()
  return Number.isFinite(t) ? t : NaN
}

/**
 * Assemble the week's factual skeleton. The week is the 7 days ending at `now` (inclusive) — Mars is
 * filled at week's end, so "the last 7 days" is the window that matters.
 */
export function buildMarsWeek(extractions: MeetingExtraction[], deals: DealEntity[], now: number): MarsWeek {
  const end = now
  const start = now - 6 * DAY
  const startDay = isoDay(start)
  const endDay = isoDay(end)

  const dated = extractions.filter((x) => Number.isFinite(parse(x.date)))
  const inWeek = (x: MeetingExtraction): boolean => {
    const d = x.date.slice(0, 10)
    return d >= startDay && d <= endDay
  }

  // First-ever meeting date per account, across ALL history — marks the week's genuinely new accounts.
  const firstSeen = new Map<string, string>()
  for (const x of dated) {
    const name = x.account?.name?.trim()
    if (!name) continue
    const key = name.toLowerCase()
    const day = x.date.slice(0, 10)
    const prev = firstSeen.get(key)
    if (!prev || day < prev) firstSeen.set(key, day)
  }

  const week = dated.filter(inWeek).sort((a, b) => a.date.localeCompare(b.date))
  const meetings: MarsMeetingRow[] = week.map((x) => {
    const account = x.account?.name?.trim() ?? ''
    return {
      date: x.date.slice(0, 10),
      title: x.title24 || '(untitled)',
      account,
      stage: x.deal?.stage ?? '',
      band: x.deal?.win_likelihood_band ?? '',
      sentiment: x.sentiment,
      firstContact: !!account && firstSeen.get(account.toLowerCase())! >= startDay
    }
  })

  const newAccounts = [...new Set(meetings.filter((m) => m.firstContact).map((m) => m.account))]

  // Outcomes are only ever set by explicit human action (see DealEntitySchema) — safe to report as fact.
  // A deal counts for THIS week when its most recent meeting falls inside the window.
  const touchedThisWeek = (d: DealEntity): boolean =>
    d.meetings.some((m) => m.date && m.date.slice(0, 10) >= startDay && m.date.slice(0, 10) <= endDay)
  const won = deals.filter((d) => d.outcome === 'won' && touchedThisWeek(d)).map((d) => ({ name: d.name, account: d.account }))
  const lost = deals.filter((d) => d.outcome === 'lost' && touchedThisWeek(d)).map((d) => ({ name: d.name, account: d.account }))
  const atRisk = deals
    .filter((d) => d.outcome === 'open' && d.win_likelihood_band === 'concerning')
    .map((d) => ({ name: d.name, account: d.account, evidence: d.band_evidence }))

  const openFollowups = deals
    .flatMap((d) => (d.commitments ?? []).filter((c: LedgerCommitment) => c.status === 'open').map((c) => ({ ...c, dealName: d.name })))
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
    .map((c) => ({ text: c.text, by: c.by, due_hint: c.due_hint, deal: c.dealName, date: c.date }))

  // MI-4 render gate: whole-portfolio snapshot (like atRisk, not week-scoped) of OPEN deals' amounts,
  // grouped per currency (no FX conversion — mixing currencies into one number would be a fabricated
  // figure of its own) — but ONLY the amounts a human has actually verified/pinned/edited. An
  // 'extracted' (LLM-only) amount contributes nothing here, no matter how confident the extraction.
  const pipelineByCurrency = new Map<string, number>()
  for (const d of deals) {
    if (d.outcome !== 'open' || !d.amount) continue
    if (!RENDERABLE_PROVENANCE_STATES.has(d.amount.state)) continue
    const { currency, value } = d.amount.value
    pipelineByCurrency.set(currency, (pipelineByCurrency.get(currency) ?? 0) + value)
  }
  const pipelineValue = [...pipelineByCurrency.entries()]
    .map(([currency, total]) => ({ currency, total }))
    .sort((a, b) => a.currency.localeCompare(b.currency))

  return { weekStart: startDay, weekEnd: endDay, meetings, newAccounts, won, lost, openFollowups, atRisk, pipelineValue }
}

/** Render the week as a paste-ready markdown draft, honest about what the data can and cannot claim. */
export function renderMarsMarkdown(w: MarsWeek): string {
  const lines: string[] = []
  lines.push(`# Mars week draft: ${w.weekStart} → ${w.weekEnd}`)
  lines.push('')
  lines.push('_Auto-drafted from recorded meetings. Counts are facts; the Mars bucket (prospection / cold call / QM) is yours to confirm._')
  lines.push('')

  lines.push(`## Meetings this week (${w.meetings.length})`)
  if (w.meetings.length === 0) lines.push('- none recorded')
  for (const m of w.meetings) {
    const bits = [
      m.account || 'no account',
      m.stage && `stage: ${m.stage}`,
      m.band && `read: ${m.band}`,
      m.firstContact && 'FIRST CONTACT'
    ].filter(Boolean)
    lines.push(`- ${m.date}: ${m.title} (${bits.join(', ')})`)
  }
  lines.push('')

  lines.push(`## New accounts touched (${w.newAccounts.length})`)
  lines.push(w.newAccounts.length ? w.newAccounts.map((a) => `- ${a}`).join('\n') : '- none')
  lines.push('')

  lines.push(`## Projects won (${w.won.length})`)
  lines.push(w.won.length ? w.won.map((d) => `- ${d.name}${d.account ? ` (${d.account})` : ''}`).join('\n') : '- none marked won this week')
  lines.push('')

  lines.push(`## Projects lost (${w.lost.length})`)
  lines.push(w.lost.length ? w.lost.map((d) => `- ${d.name}${d.account ? ` (${d.account})` : ''}`).join('\n') : '- none marked lost this week')
  lines.push('')

  lines.push(`## Open follow-ups (${w.openFollowups.length})`)
  if (w.openFollowups.length === 0) lines.push('- none open')
  for (const f of w.openFollowups) {
    const owner = f.by === 'you' ? 'You' : f.by === 'them' ? 'Them' : f.by
    lines.push(`- ${owner}: ${f.text}${f.due_hint ? ` (${f.due_hint})` : ''}, ${f.deal}${f.date ? `, from ${f.date}` : ''}`)
  }
  lines.push('')

  if (w.atRisk.length) {
    lines.push(`## At risk (${w.atRisk.length})`)
    for (const d of w.atRisk) lines.push(`- ${d.name}${d.account ? ` (${d.account})` : ''}${d.evidence ? `: ${d.evidence}` : ''}`)
    lines.push('')
  }

  // MI-4 render gate: omitted entirely when no deal has a verified/pinned/edited amount — never a
  // "0 EUR" line, since that would itself misrepresent an empty pipeline as a measured fact.
  if (w.pipelineValue.length) {
    lines.push('## Pipeline value (verified, open deals)')
    for (const p of w.pipelineValue) lines.push(`- ${p.total.toLocaleString()} ${p.currency}`)
    lines.push('')
  }

  return lines.join('\n')
}
