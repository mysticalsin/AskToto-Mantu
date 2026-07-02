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

/**
 * Adapter: AskToto's live brain (window.intelligence.getData(), IPC brain:read) → this dashboard's
 * display contract. The brain is the source of truth; this file only reshapes — it must never invent
 * facts. Where the brain genuinely lacks a field the old vault pipeline had (deal value, call grades),
 * the honest empty value is used, and the views already render those gaps gracefully.
 */

// ── Brain shapes (mirror src/shared/brain.ts in the host app; kept loose on purpose) ─────────────
type Conf = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS'
interface BrainSignal { kind: 'positive' | 'objection' | 'neutral'; statement: string; quote: string; confidence: Conf; meeting: string }
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
  missed_signals: Array<{ statement: string; why_it_matters: string; meeting: string }>
  feedback: Array<{ note: string; meeting: string }>
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
interface BrainPerson { name: string; role: string | null; account: string | null }
export interface BrainRead {
  index: { warnings: string[] }
  graph: { nodes: Array<{ id: string; type: string; label: string }>; edges: Array<{ from: string; to: string; rel: string; confidence: Conf }> }
  people: BrainPerson[]
  accounts: BrainAccount[]
  deals: BrainDeal[]
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

function toDeal(d: BrainDeal, sectorByAccount: Map<string, string>): Deal {
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
    call_grades: [] // per-call grades arrive with per-meeting sentiment in a later brain read
  }
}

function toInsights(deals: BrainDeal[]): CoachingInsight[] {
  const out: CoachingInsight[] = []
  for (const d of deals) {
    for (const [i, f] of d.feedback.entries()) {
      out.push({
        insight_id: `${slug(d.name)}-fb-${i}`,
        pattern: f.note,
        n_observations: 1,
        deals: [slug(d.name)],
        what_happened: `Observed during ${f.meeting}`,
        why_it_matters: 'Coaching note grounded in this call.',
        coaching_move: f.note,
        category: categorize(f.note),
        confidence: 0.6,
        grounding: 'assumed',
        sources: [{ file: f.meeting, quote_or_paraphrase: f.note }]
      })
    }
    for (const [i, ms] of d.missed_signals.entries()) {
      out.push({
        insight_id: `${slug(d.name)}-ms-${i}`,
        pattern: ms.statement,
        n_observations: 1,
        deals: [slug(d.name)],
        what_happened: ms.statement,
        why_it_matters: ms.why_it_matters || 'An opening the seller did not pursue.',
        coaching_move: `Next call: pursue this directly — ${ms.statement}`,
        category: categorize(ms.statement),
        confidence: 0.6,
        grounding: 'assumed',
        sources: [{ file: ms.meeting, quote_or_paraphrase: ms.statement }]
      })
    }
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

  const deals = b.deals.map((d) => toDeal(d, sectorByAccount))
  const insights = toInsights(b.deals)

  // Meetings are dropped from the DISPLAY graph (61 meeting nodes would drown the entity structure);
  // their connectivity survives because people/accounts/deals were already linked during ingest.
  const keepTypes = new Set(['account', 'person', 'deal', 'sector'])
  const nodes: GraphNode[] = b.graph.nodes
    .filter((n) => keepTypes.has(n.type))
    .map((n) => {
      const bare = n.id.replace(/^[a-z_]+:/, '')
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
        community_label: ''
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
    sector_summaries: sectorSummaries
  }
}
