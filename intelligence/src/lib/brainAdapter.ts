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
  WinLikelihoodBand,
  Commitment,
  Account,
  Person,
  MeetingFeedRow,
  IngestError,
  StatusCounts
} from '../types/data'
import { buildGoingCold } from './goingCold.ts'
import { slug } from './slug.ts'

/**
 * Adapter: AskToto's live brain (window.intelligence.getData(), IPC brain:read) → this dashboard's
 * display contract. The brain is the source of truth; this file only reshapes — it must never invent
 * facts. Where the brain genuinely lacks a field the old vault pipeline had (deal value, call grades),
 * the honest empty value is used, and the views already render those gaps gracefully.
 */

// ── Brain shapes (mirror src/shared/brain.ts in the host app; kept loose on purpose) ─────────────
// This is a workspace boundary (intelligence/ cannot import src/shared) so these are hand-mirrored,
// not imported. Source of truth + line numbers as of this writing, re-check on brain.ts schema changes:
//   ConfidenceSchema             brain.ts:15    MeetingSignalSchema   brain.ts:42-47
//   CommitmentSchema/Ledger      brain.ts:54-69 MeetingExtractionSchema brain.ts:72-132 (meetings feed)
//   PersonEntitySchema           brain.ts:142-151 (role/meetings/stance_trail/commitments)
//   AccountEntitySchema          brain.ts:153-164 (win_reasons/loss_reasons)
//   DealEntitySchema             brain.ts:166-200 (band_evidence/velocity/commitments)
//   GraphNodeSchema/GraphEdgeSchema/BrainGraphSchema brain.ts:202-217
//   BrainIndexSchema              brain.ts:219-229 (ingested/warnings)
//   BrainRead (assembled shape)   brain.ts:232-241
type Conf = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS'
interface BrainSignal { kind: 'positive' | 'objection' | 'neutral'; statement: string; quote: string; confidence: Conf; meeting: string }
interface BrainCommitment { text: string; by: string; status: string; due_hint?: string; quote?: string; confidence?: Conf; meeting?: string; date?: string }
interface BrainDeal {
  name: string
  account: string
  stage: string
  outcome: 'open' | 'won' | 'lost'
  win_likelihood_band: WinLikelihoodBand | null
  band_evidence: string
  velocity: { signal: 'hard-calendar-gate' | 'soft-organizational-gate' | 'no-hard-date-found'; evidence: string }
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
  stance_trail?: Array<{ meeting: string; kind: string; statement: string }>
  commitments?: BrainCommitment[]
}
export interface BrainRead {
  index: { warnings: string[]; ingested: Record<string, { at: number; ok: boolean; error?: string }> }
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

/** Normalizes a brain commitment (ledger entry, loose `status: string`) into the display shape's strict
 *  status union — an unrecognized/legacy status defaults to 'open', mirroring LedgerCommitmentSchema's
 *  own default and the same fallback goingCold.ts already applies to missing statuses. */
function toCommitment(c: BrainCommitment): Commitment {
  return {
    text: c.text,
    by: c.by,
    status: c.status === 'kept' || c.status === 'broken' ? c.status : 'open',
    due_hint: c.due_hint ?? '',
    quote: c.quote ?? '',
    date: c.date ?? '',
    meeting: c.meeting ?? ''
  }
}

function toDeal(d: BrainDeal, sectorByAccount: Map<string, string>, meetingsByFile: Map<string, BrainMeeting>): Deal {
  // raised_by and was_deciding_factor are deliberately absent: the signal extraction schema has no
  // "who raised this" or "was this the deciding factor" field to ground either in, and the previous
  // code faked them ('meeting participant', false) — an honest adapter omits what it doesn't know.
  const claims: Claim[] = d.signals.map((sig, i) => ({
    claim_id: `${slug(d.name)}-${i}`,
    statement: sig.statement,
    category: categorize(sig.statement + ' ' + sig.quote),
    stance: sig.kind === 'positive' ? 'positive-signal' : sig.kind === 'objection' ? 'objection' : 'neutral-observation',
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
    band_evidence: d.band_evidence ?? '',
    velocity: d.velocity,
    claims,
    call_grades,
    commitments: (d.commitments ?? []).map(toCommitment)
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

/**
 * Deterministic label propagation (Raghavan et al., asynchronous variant) for real graph-structural
 * clusters. Connected components (the previous approach) collapse an entire connected graph into ONE
 * community the moment any edge bridges two otherwise-separate clusters — exactly the case AskToto's
 * graph hits once a single cross-account edge exists. Label propagation instead lets each node adopt
 * its neighborhood's majority label, which respects locally dense sub-clusters (an account with its
 * people/deals/sector) even when a thin bridge connects them to the rest of the graph.
 *
 * Determinism, on purpose (no randomness anywhere):
 *   - Node processing order is always the input `nodes` array order (never shuffled).
 *   - Updates are asynchronous (a node sees neighbors already updated earlier in the SAME round) —
 *     standard practice to avoid oscillation, and reproducible here because the order is fixed.
 *   - Ties are broken by keeping the node's current label when it's among the winners, else by the
 *     first-encountered label in (fixed) neighbor order — never by comparing label strings/ids.
 *   - A small, fixed round count (4) intentionally stops short of full convergence: convergence is
 *     what collapses everything into one or two giant communities; a few rounds preserve the more
 *     useful, smaller local clusters.
 */
const LABEL_PROPAGATION_ROUNDS = 4

function communities(nodes: GraphNode[], edges: GraphEdge[]): void {
  const index = new Map(nodes.map((n, i) => [n.id, i]))
  const adjacency: string[][] = nodes.map(() => [])
  for (const e of edges) {
    const a = index.get(e.from)
    const b = index.get(e.to)
    if (a === undefined || b === undefined || a === b) continue
    adjacency[a].push(e.to)
    adjacency[b].push(e.from)
  }

  const label = new Map<string, string>(nodes.map((n) => [n.id, n.id]))
  for (let round = 0; round < LABEL_PROPAGATION_ROUNDS; round++) {
    let changed = false
    for (let i = 0; i < nodes.length; i++) {
      const neighbors = adjacency[i]
      if (neighbors.length === 0) continue
      const counts = new Map<string, number>()
      for (const nb of neighbors) {
        const l = label.get(nb)!
        counts.set(l, (counts.get(l) ?? 0) + 1)
      }
      const own = label.get(nodes[i].id)!
      let best = own
      let bestCount = counts.get(own) ?? 0
      for (const [candidate, count] of counts) {
        if (count > bestCount) {
          best = candidate
          bestCount = count
        }
      }
      if (best !== own) {
        label.set(nodes[i].id, best)
        changed = true
      }
    }
    if (!changed) break // stable early — no need to burn the remaining rounds
  }

  const communityIdOf = new Map<string, number>()
  const members = new Map<number, GraphNode[]>()
  for (const n of nodes) {
    const l = label.get(n.id)!
    if (!communityIdOf.has(l)) communityIdOf.set(l, communityIdOf.size)
    const cid = communityIdOf.get(l)!
    n.community_id = cid
    if (!members.has(cid)) members.set(cid, [])
    members.get(cid)!.push(n)
  }
  for (const [, ns] of members) {
    // Label by the dominant sector, else the account, else the first label — real groupings, no "Community N".
    const bySector = new Map<string, number>()
    for (const n of ns) if (n.sector) bySector.set(n.sector, (bySector.get(n.sector) ?? 0) + 1)
    const top = [...bySector.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    const communityLabel = top ?? ns.find((n) => n.type === 'account')?.label ?? ns[0]?.label ?? 'group'
    for (const n of ns) n.community_label = communityLabel
  }
}

/** Latest dated ref from an entity's own meeting list — real, derived, never fabricated. Used to give
 *  the graph's info panel an actual source reference instead of just id+label+type (see GraphNode's
 *  ref/date/is_client_facing doc comment in types/data.ts). */
function latestMeetingRef(
  refs: Array<{ file: string; date: string; title: string }> | undefined
): { file: string; date: string } | null {
  const dated = (refs ?? []).filter((m) => m.date)
  if (!dated.length) return null
  const last = dated.reduce((a, b) => (a.date > b.date ? a : b))
  return { file: last.file, date: last.date }
}

export function brainToDashboard(b: BrainRead): DashboardData {
  const sectorByAccount = new Map(b.accounts.map((a) => [a.name, a.sector]))
  const bandByDeal = new Map(b.deals.map((d) => [slug(d.name), d.win_likelihood_band ?? ('mixed' as WinLikelihoodBand)]))
  const accountByPerson = new Map(b.people.map((p) => [slug(p.name), p.account ?? undefined]))
  const accountBySlug = new Map(b.accounts.map((a) => [slug(a.name), a]))
  const personBySlug = new Map(b.people.map((p) => [slug(p.name), p]))
  const dealBySlug = new Map(b.deals.map((d) => [slug(d.name), d]))

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
      const entityMeetings =
        n.type === 'account' ? accountBySlug.get(bare)?.meetings
        : n.type === 'person' ? personBySlug.get(bare)?.meetings
        : n.type === 'deal' ? dealBySlug.get(bare)?.meetings
        : undefined
      const ref = latestMeetingRef(entityMeetings)
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
        ref: ref?.file,
        date: ref?.date,
        is_client_facing: ref ? !!meetingsByFile.get(ref.file)?.account : undefined,
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
      total_value_usd: null, // no money data in transcripts — the UI states this, never shows $0
      band_counts: counts,
      insight_ids: insights.filter((i) => i.deals.some((bd) => deals.find((d) => d.bid_id === bd)?.account === a.name)).map((i) => i.insight_id)
    }
  })
  const sectors = [...new Set(b.accounts.map((a) => a.sector))]
  const sectorSummaries: ScopeSummary[] = sectors.map((sec) => {
    const inSector = deals.filter((d) => d.sector === sec)
    const counts = band0()
    for (const d of inSector) counts[d.win_likelihood_band]++
    return {
      key: slug(sec),
      label: sec,
      deal_count: inSector.length,
      total_value_usd: null,
      band_counts: counts,
      // Same rollup as the account summary above, keyed by sector instead of account name — this was
      // hardcoded to [] before, silently emptying every sector's coaching-insight panel.
      insight_ids: insights.filter((i) => i.deals.some((bd) => deals.find((d) => d.bid_id === bd)?.sector === sec)).map((i) => i.insight_id)
    }
  })

  const accountsOut: Account[] = b.accounts.map((a) => ({
    slug: slug(a.name),
    name: a.name,
    sector: a.sector,
    strategic: a.strategic,
    win_reasons: a.win_reasons ?? [],
    loss_reasons: a.loss_reasons ?? []
  }))

  const peopleOut: Person[] = b.people.map((p) => ({
    slug: slug(p.name),
    name: p.name,
    role: p.role,
    account: p.account,
    stance_trail: p.stance_trail ?? [],
    commitments: (p.commitments ?? []).map(toCommitment)
  }))

  // Newest first — a feed reads top-down by recency, same convention as an inbox.
  const meetingsFeed: MeetingFeedRow[] = [...(b.meetings ?? [])]
    .sort((a, b2) => (b2.date || '').localeCompare(a.date || ''))
    .map((m) => ({
      slug: slug(m.source_file),
      title24: m.title24,
      date: (m.date || '').slice(0, 10),
      account: m.account?.name ?? null,
      sentiment: m.sentiment,
      topics: m.topics
    }))

  const ingestErrors: IngestError[] = Object.entries(b.index.ingested ?? {})
    .filter(([, v]) => !v.ok)
    .map(([file, v]) => ({ file, error: v.error ?? '' }))

  const status: StatusCounts = {
    meetings: Object.values(b.index.ingested ?? {}).filter((v) => v.ok).length,
    people: b.people.length,
    accounts: b.accounts.length,
    deals: b.deals.length,
    nodes: b.graph.nodes.length,
    edges: b.graph.edges.length
  }

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
    going_cold: cold.rail,
    accounts: accountsOut,
    people: peopleOut,
    meetings_feed: meetingsFeed,
    warnings: b.index.warnings,
    ingest_errors: ingestErrors,
    status
  }
}
