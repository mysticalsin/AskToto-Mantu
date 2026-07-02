import type {
  DashboardData,
  Deal,
  Claim,
  CoachingInsight,
  GraphNode,
  GraphEdge,
  Category,
  Grounding,
  ScopeSummary,
  WinLikelihoodBand
} from '../types/data'
import { buildGoingCold } from './goingCold'

/**
 * Adapter: AskToto's live brain (window.intelligence.getData(), IPC brain:read) → this dashboard's
 * display contract. The brain is the source of truth; this file only reshapes — it must never invent
 * facts. Where the brain genuinely lacks a field the old vault pipeline had (deal value, call grades),
 * the honest empty value is used, and the views already render those gaps gracefully.
 */

// ── Brain shapes (mirror src/shared/brain.ts in the host app; kept loose on purpose) ─────────────
type Conf = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS'
interface BrainSignal { kind: 'positive' | 'objection' | 'neutral'; statement: string; quote: string; confidence: Conf; meeting: string }
interface BrainCommitment { text: string; by: string; status: string; due_hint?: string; meeting?: string; date?: string }
interface BrainDeal {
  name: string
  account: string
  stage: string
  outcome: 'open' | 'won' | 'lost'
  win_likelihood_band: WinLikelihoodBand | null
  band_evidence: string
  velocity: { signal: string; evidence: string }
  meetings: Array<{ file: string; date: string; title: string }>
  signals: BrainSignal[]
  missed_signals: Array<{ statement: string; why_it_matters: string; quote?: string; confidence?: Conf; meeting: string }>
  feedback: Array<{ note: string; quote?: string; confidence?: Conf; meeting: string }>
  commitments?: BrainCommitment[]
}
interface BrainMeeting {
  source_file: string
  date: string
  title24: string
  sentiment: WinLikelihoodBand
  topics: string[]
  account: { name: string } | null
}
interface BrainAccount {
  name: string
  sector: string
  strategic: boolean
  people: string[]
  deals: string[]
  meetings: Array<{ file: string; date: string; title: string }>
  win_reasons: Array<{ statement: string; quote: string; meeting: string }>
  loss_reasons: Array<{ statement: string; quote: string; meeting: string }>
}
interface BrainPerson {
  name: string
  role: string | null
  account: string | null
  meetings?: Array<{ file: string; date: string; title: string }>
  commitments?: BrainCommitment[]
}
export interface BrainRead {
  index: { warnings: string[] }
  graph: { nodes: Array<{ id: string; type: string; label: string }>; edges: Array<{ from: string; to: string; rel: string; confidence: Conf }> }
  people: BrainPerson[]
  accounts: BrainAccount[]
  deals: BrainDeal[]
  meetings?: BrainMeeting[]
}

declare global {
  interface Window {
    intelligence?: {
      getData: () => Promise<BrainRead>
      getStatus: () => Promise<unknown>
      backfill: () => Promise<{ queued: number }>
    }
  }
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x'
const groundingOf = (c: Conf): Grounding => (c === 'EXTRACTED' ? 'verified' : c === 'INFERRED' ? 'assumed' : 'unknown')
const confidenceOf = (c: Conf): number => (c === 'EXTRACTED' ? 0.9 : c === 'INFERRED' ? 0.6 : 0.3)

/** Display-taxonomy bucketing only (keyword heuristic) — a UI grouping aid, not an extracted fact. */
function categorize(text: string): Category {
  const t = text.toLowerCase()
  if (/(price|pricing|cost|budget|expensive|rate|discount)/.test(t)) return 'pricing'
  if (/(competitor|competing|rival|other (bid|offer|vendor))/.test(t)) return 'competitor'
  if (/(deadline|timeline|date|schedule|delay|q[1-4]|quarter)/.test(t)) return 'timing'
  if (/(integration|technical|architecture|api|platform|migration|security)/.test(t)) return 'technical-fit'
  if (/(relationship|trust|team|stakeholder|sponsor|champion)/.test(t)) return 'relationship'
  if (/(contract|terms|commercial|payment|sow|scope)/.test(t)) return 'commercial-model'
  return 'process'
}

function toDeal(d: BrainDeal, sectorByAccount: Map<string, string>, meetingsByFile: Map<string, BrainMeeting>): Deal {
  const claims: Claim[] = d.signals.map((sig, i) => ({
    claim_id: `${slug(d.name)}-${i}`,
    statement: sig.statement,
    category: categorize(sig.statement + ' ' + sig.quote),
    raised_by: 'meeting participant',
    stance: sig.kind === 'positive' ? 'positive-signal' : sig.kind === 'objection' ? 'objection' : 'neutral-observation',
    was_deciding_factor: false,
    source: { file: sig.meeting, quote_or_paraphrase: sig.quote || sig.statement, grounding: sig.quote ? groundingOf(sig.confidence) : 'assumed' },
    confidence: confidenceOf(sig.confidence)
  }))
  // Per-call quality timeline: join the deal's meeting refs to their extractions' sentiment. The
  // sentiment IS the qualitative grade (same good/mixed/concerning vocabulary); meetings whose
  // extraction hasn't landed yet (backfill still running) simply don't appear rather than guessing.
  const call_grades = d.meetings
    .map((ref) => {
      const m = meetingsByFile.get(ref.file)
      if (!m) return null
      return {
        date: (m.date || ref.date || '').slice(0, 10),
        label: m.title24 || ref.title,
        grade: m.sentiment,
        note: m.topics.slice(0, 3).join(' · '),
        is_client_facing: !!m.account
      }
    })
    .filter((g): g is NonNullable<typeof g> => g !== null)
    .sort((a, b) => a.date.localeCompare(b.date))

  return {
    bid_id: slug(d.name),
    account: d.account,
    sector: sectorByAccount.get(d.account) ?? 'other',
    display_name: d.name,
    outcome: d.outcome,
    win_likelihood_band: d.win_likelihood_band ?? 'mixed',
    value_usd: null, // the brain never invents money — no value data in transcripts
    stage: d.stage || (d.velocity.signal === 'hard-calendar-gate' ? 'moving (hard date)' : 'open'),
    claims,
    call_grades
  }
}

/**
 * Confidence engine for coaching insights. Three honest inputs, no flat defaults (the first version
 * hardcoded 0.6 everywhere and the whole Coaching view read as an identical wall of "60%"):
 *   1. Source tag from the extraction (EXTRACTED = the model could quote the moment, INFERRED = a
 *      judgement, AMBIGUOUS = a stretch) → base 0.85 / 0.55 / 0.35.
 *   2. Corroboration: the same pattern observed again (another meeting or deal) raises confidence
 *      +0.06 per extra observation, capped at +0.18 — repetition is evidence.
 *   3. Anchor quote: any verbatim transcript anchor adds +0.05 and flips grounding to 'verified'.
 * Cap 0.95. Grounding: quoted → verified; INFERRED → assumed; AMBIGUOUS → unknown.
 */
function insightConfidence(base: Conf, observations: number, hasQuote: boolean): { confidence: number; grounding: Grounding } {
  const baseScore = base === 'EXTRACTED' ? 0.85 : base === 'INFERRED' ? 0.55 : 0.35
  const corroboration = Math.min(0.18, Math.max(0, observations - 1) * 0.06)
  const quoteBoost = hasQuote ? 0.05 : 0
  return {
    confidence: Math.min(0.95, baseScore + corroboration + quoteBoost),
    grounding: hasQuote ? 'verified' : groundingOf(base)
  }
}

/** Grouping key: same category + the first significant words — repeated coaching themes cluster into
 *  ONE insight with a real n_observations instead of n copies each claiming a single observation. */
function patternKey(category: Category, text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !['this', 'that', 'with', 'from', 'their', 'client', 'next', 'call'].includes(w))
    .slice(0, 4)
  return `${category}|${words.join('-')}`
}

interface RawObservation {
  kind: 'feedback' | 'missed'
  text: string
  why: string
  quote: string
  confidence: Conf
  meeting: string
  dealSlug: string
}

function toInsights(deals: BrainDeal[]): CoachingInsight[] {
  const observations: RawObservation[] = []
  for (const d of deals) {
    for (const f of d.feedback) {
      observations.push({ kind: 'feedback', text: f.note, why: '', quote: f.quote ?? '', confidence: f.confidence ?? 'INFERRED', meeting: f.meeting, dealSlug: slug(d.name) })
    }
    for (const ms of d.missed_signals) {
      observations.push({ kind: 'missed', text: ms.statement, why: ms.why_it_matters, quote: ms.quote ?? '', confidence: ms.confidence ?? 'INFERRED', meeting: ms.meeting, dealSlug: slug(d.name) })
    }
  }

  // Cluster repeated patterns across meetings/deals — corroboration is what earns confidence.
  const groups = new Map<string, RawObservation[]>()
  for (const o of observations) {
    const key = patternKey(categorize(o.text), o.text)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(o)
  }

  const out: CoachingInsight[] = []
  let i = 0
  for (const group of groups.values()) {
    // Best-evidenced observation leads the card; the rest corroborate.
    const rank = (c: Conf): number => (c === 'EXTRACTED' ? 2 : c === 'INFERRED' ? 1 : 0)
    const lead = [...group].sort((a, b) => rank(b.confidence) - rank(a.confidence) || b.quote.length - a.quote.length)[0]
    const dealsIn = [...new Set(group.map((o) => o.dealSlug))]
    const meetingsIn = new Set(group.map((o) => o.meeting))
    const hasQuote = group.some((o) => o.quote.length > 0)
    const { confidence, grounding } = insightConfidence(lead.confidence, meetingsIn.size, hasQuote)
    out.push({
      insight_id: `insight-${i++}-${lead.dealSlug}`,
      pattern: lead.text,
      n_observations: group.length,
      deals: dealsIn,
      what_happened: lead.kind === 'missed' ? lead.text : `Observed during ${lead.meeting}`,
      why_it_matters:
        lead.why ||
        (meetingsIn.size > 1
          ? `Recurred across ${meetingsIn.size} meetings — a pattern, not a one-off.`
          : lead.kind === 'missed'
            ? 'An opening the seller did not pursue.'
            : 'Coaching note grounded in this call.'),
      coaching_move: lead.kind === 'missed' ? `Next call: pursue this directly — ${lead.text}` : lead.text,
      category: categorize(lead.text),
      confidence,
      grounding,
      sources: group.slice(0, 5).map((o) => ({ file: o.meeting, quote_or_paraphrase: o.quote || o.text }))
    })
  }
  return out
}

/** Connected components via union-find (same approach as the old build-data.mjs) for real clusters. */
function communities(nodes: GraphNode[], edges: GraphEdge[]): void {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)!
    parent.set(x, r)
    return r
  }
  for (const n of nodes) parent.set(n.id, n.id)
  for (const e of edges) {
    if (!parent.has(e.from) || !parent.has(e.to)) continue
    const a = find(e.from)
    const b = find(e.to)
    if (a !== b) parent.set(a, b)
  }
  const roots = new Map<string, number>()
  const members = new Map<number, GraphNode[]>()
  for (const n of nodes) {
    const root = find(n.id)
    if (!roots.has(root)) roots.set(root, roots.size)
    const cid = roots.get(root)!
    n.community_id = cid
    if (!members.has(cid)) members.set(cid, [])
    members.get(cid)!.push(n)
  }
  for (const [cid, ns] of members) {
    // Label by the dominant sector, else the account, else the first label — real groupings, no "Community N".
    const bySector = new Map<string, number>()
    for (const n of ns) if (n.sector) bySector.set(n.sector, (bySector.get(n.sector) ?? 0) + 1)
    const top = [...bySector.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    const label = top ?? ns.find((n) => n.type === 'account')?.label ?? ns[0]?.label ?? `group ${cid}`
    for (const n of ns) n.community_label = label
  }
}

export function brainToDashboard(b: BrainRead): DashboardData {
  const sectorByAccount = new Map(b.accounts.map((a) => [a.name, a.sector]))
  const bandByDeal = new Map(b.deals.map((d) => [slug(d.name), d.win_likelihood_band ?? ('mixed' as WinLikelihoodBand)]))
  const accountByPerson = new Map(b.people.map((p) => [slug(p.name), p.account ?? undefined]))

  const meetingsByFile = new Map((b.meetings ?? []).map((m) => [m.source_file, m]))
  const deals = b.deals.map((d) => toDeal(d, sectorByAccount, meetingsByFile))
  const insights = toInsights(b.deals)

  // Going-Cold layer: freshness per entity from its own dated meeting refs + structural risk
  // (single-threaded deals, unmapped accounts). Stamped once at adapt time.
  const cold = buildGoingCold(b, Date.now())

  // Meetings are dropped from the DISPLAY graph (61 meeting nodes would drown the entity structure);
  // their connectivity survives because people/accounts/deals were already linked during ingest.
  const keepTypes = new Set(['account', 'person', 'deal', 'sector'])
  const nodes: GraphNode[] = b.graph.nodes
    .filter((n) => keepTypes.has(n.type))
    .map((n) => {
      const bare = n.id.replace(/^[a-z_]+:/, '')
      const t = cold.touch.get(n.id)
      return {
        id: n.id,
        label: n.label,
        type: n.type as GraphNode['type'],
        account: n.type === 'person' ? accountByPerson.get(bare) : n.type === 'account' ? n.label : undefined,
        sector: n.type === 'account' ? sectorByAccount.get(n.label) : n.type === 'sector' ? n.label : undefined,
        win_likelihood_band: n.type === 'deal' ? bandByDeal.get(bare) : undefined,
        bid_id: n.type === 'deal' ? bare : undefined,
        degree: 0,
        community_id: 0,
        community_label: '',
        last_touch: t?.lastTouch,
        days_quiet: t?.daysQuiet,
        freshness: t?.freshness,
        single_threaded: n.type === 'deal' ? cold.singleThreaded.has(n.id) : undefined,
        unmapped: n.type === 'account' ? cold.unmapped.has(n.id) : undefined
      }
    })
  const nodeIds = new Set(nodes.map((n) => n.id))
  const edges: GraphEdge[] = b.graph.edges
    .filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to))
    .map((e) => ({ from: e.from, to: e.to, relation: e.rel, confidence: e.confidence }))
  for (const e of edges) {
    const f = nodes.find((n) => n.id === e.from)
    const t = nodes.find((n) => n.id === e.to)
    if (f) f.degree++
    if (t) t.degree++
  }
  communities(nodes, edges)

  const band0 = (): Record<WinLikelihoodBand, number> => ({ good: 0, mixed: 0, concerning: 0 })
  const accountSummaries: ScopeSummary[] = b.accounts.map((a) => {
    const counts = band0()
    for (const d of deals.filter((d) => d.account === a.name)) counts[d.win_likelihood_band]++
    return {
      key: slug(a.name),
      label: a.name,
      deal_count: deals.filter((d) => d.account === a.name).length,
      total_value_usd: 0,
      band_counts: counts,
      insight_ids: insights.filter((i) => i.deals.some((bd) => deals.find((d) => d.bid_id === bd)?.account === a.name)).map((i) => i.insight_id)
    }
  })
  const sectors = [...new Set(b.accounts.map((a) => a.sector))]
  const sectorSummaries: ScopeSummary[] = sectors.map((sec) => {
    const inSector = deals.filter((d) => d.sector === sec)
    const counts = band0()
    for (const d of inSector) counts[d.win_likelihood_band]++
    return { key: slug(sec), label: sec, deal_count: inSector.length, total_value_usd: 0, band_counts: counts, insight_ids: [] }
  })

  return {
    meta: {
      is_placeholder: false,
      note: 'Live from your Mantu Intelligence brain — grounded in your meeting transcripts.',
      generated: new Date().toISOString(),
      n_deals: deals.length
    },
    deals,
    coaching_insights: insights,
    account_graph: { nodes, edges },
    account_summaries: accountSummaries,
    sector_summaries: sectorSummaries,
    going_cold: cold.rail
  }
}
