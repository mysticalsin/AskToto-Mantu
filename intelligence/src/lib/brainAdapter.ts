import type {
  DashboardData,
  Deal,
  DealAmount,
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
  FieldState,
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
// MI-2.5 Fix C: only the `.state` of a ProvenantField sidecar is needed client-side (to decide whether
// the dashboard's Accept affordance shows) — the value/quote/source_file/superseded history stay
// server-side, read fresh by the brain:field-decision handler itself when a decision comes in.
interface BrainProvenance { state?: string }
// MI-4: amount/close_date have NO plain sibling field the way stage/velocity do — the provenant
// sidecar IS the only place the value lives (DealEntitySchema — brain.ts:436-437), so these mirrors
// need the full { value, quote, state } shape, not just BrainProvenance's bare .state.
interface BrainAmountField { value: { value: number; currency: string }; quote?: string; state?: string }
interface BrainCloseDateField { value: string; quote?: string; state?: string }
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
  stage_provenance?: BrainProvenance
  win_likelihood_band_provenance?: BrainProvenance
  velocity_provenance?: BrainProvenance
  amount?: BrainAmountField
  close_date?: BrainCloseDateField
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
  sector_provenance?: BrainProvenance
}
interface BrainPerson {
  name: string
  role: string | null
  account: string | null
  meetings?: Array<{ file: string; date: string; title: string }>
  stance_trail?: Array<{ meeting: string; kind: string; statement: string }>
  commitments?: BrainCommitment[]
  role_provenance?: BrainProvenance
  org_provenance?: BrainProvenance
}

/** Builds a Deal/Account/Person's `field_state` map from its raw provenance sidecars — only the four
 *  ProvenanceState values are ever carried through (see FieldState's doc comment); anything else
 *  (absent sidecar, a schema-drifted/legacy value) is dropped rather than guessed at. Returns undefined
 *  (not `{}`) when nothing qualifies, so a view's `data.field_state?.stage` check stays a clean absence. */
// MI-4 render-gate invariant, mirrored from src/shared/brain.ts's RENDERABLE_PROVENANCE_STATES: a bare
// 'extracted' (LLM-only, never independently confirmed) amount/close_date must NEVER render as a real
// figure — only a human-verified/pinned/edited value may. See amountFrom()/closeDateFrom() below.
const RENDERABLE_STATES = new Set(['verified', 'pinned', 'edited'])

/** Split one amount provenance sidecar into the (confirmed, pending) pair Deal.amount/amount_pending
 *  carry — at most one is ever non-null. Absent sidecar (no amount ever extracted) → both null. */
function amountFrom(f: BrainAmountField | undefined): { amount: DealAmount | null; pending: DealAmount | null } {
  if (!f) return { amount: null, pending: null }
  const value: DealAmount = { value: f.value.value, currency: f.value.currency, quote: f.quote ?? '' }
  return RENDERABLE_STATES.has(f.state ?? '') ? { amount: value, pending: null } : { amount: null, pending: value }
}

/** Same split for close_date — see amountFrom(). */
function closeDateFrom(
  f: BrainCloseDateField | undefined
): { close_date: string | null; pending: { value: string; quote: string } | null } {
  if (!f) return { close_date: null, pending: null }
  const value = { value: f.value, quote: f.quote ?? '' }
  return RENDERABLE_STATES.has(f.state ?? '') ? { close_date: f.value, pending: null } : { close_date: null, pending: value }
}

function fieldState(entries: Array<[string, BrainProvenance | undefined]>): FieldState | undefined {
  type State = 'extracted' | 'verified' | 'edited' | 'pinned'
  const known: readonly State[] = ['extracted', 'verified', 'edited', 'pinned']
  const out: FieldState = {}
  for (const [field, p] of entries) {
    const match = known.find((k) => k === p?.state)
    if (match) out[field] = match
  }
  return Object.keys(out).length ? out : undefined
}
export interface BrainRead {
  index: {
    warnings: string[]
    revision?: number
    ingested: Record<string, { at: number; ok: boolean; error?: string; sourceVersion?: string; attempts?: number; retryAfter?: number; exhausted?: boolean }>
  }
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
      backfill: () => Promise<{ queued: number; deferred?: string; preparing?: boolean; error?: string }>
      runPass?: () => Promise<{ queued: number; error?: string; upToDate?: boolean }>
      // Dashboard suggestion accept/dismiss (deferred CRM pattern 3) — see src/preload/intelligence.ts
      // in the host app for the real signature this mirrors.
      fieldDecision: (payload: {
        entityKind: 'person' | 'account' | 'deal'
        entityId: string
        field: string
        decision: 'accept' | 'dismiss'
      }) => Promise<{ ok: boolean; error?: string }>
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
 *  status union.
 *
 *  Callers MUST drop `status === 'rejected'` rows before calling this. 'rejected' is a human override for
 *  a promise that was never actually made (LedgerCommitmentSchema, src/shared/brain.ts) — its schema
 *  comment says every `status === 'open'` filter excludes it for free, which is true of every surface
 *  that FILTERS on open and exactly false here, because this function MAPS anything unrecognized TO
 *  'open'. Left unfiltered, a promise the user struck out in Métis came back as a live obligation on the
 *  dashboard they make decisions from, counted in the open tile, the aging buckets and the attention
 *  score, while goingCold.ts (which does filter) disagreed about the same row.
 *
 *  With rejected rows excluded at both call sites, the fallback below only ever catches a genuinely
 *  legacy status with no value, mirroring LedgerCommitmentSchema's own default. */
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

function toDeal(d: BrainDeal, accountBySlug: Map<string, BrainAccount>, meetingsByFile: Map<string, BrainMeeting>): Deal {
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
        is_client_facing: m.account ? true : undefined
      }
    })
    .filter((g): g is NonNullable<typeof g> => g !== null)
    .sort((a, b) => a.date.localeCompare(b.date))

  const { amount, pending: amountPending } = amountFrom(d.amount)
  const { close_date, pending: closeDatePending } = closeDateFrom(d.close_date)

  return {
    bid_id: slug(d.name),
    account: d.account,
    sector: accountBySlug.get(slug(d.account))?.sector ?? 'other',
    display_name: d.name,
    outcome: d.outcome,
    win_likelihood_band: d.win_likelihood_band ?? null, // preserve "ungraded" — never fabricate a band
    amount,
    amount_pending: amountPending,
    close_date,
    close_date_pending: closeDatePending,
    stage: d.stage || (d.velocity.signal === 'hard-calendar-gate' ? 'moving (hard date)' : 'open'),
    band_evidence: d.band_evidence ?? '',
    velocity: d.velocity,
    claims,
    call_grades,
    commitments: (d.commitments ?? []).filter((c) => c.status !== 'rejected').map(toCommitment),
    meetings: d.meetings,
    field_state: fieldState([
      ['stage', d.stage_provenance],
      ['win_likelihood_band', d.win_likelihood_band_provenance],
      ['velocity', d.velocity_provenance],
      ['amount', d.amount],
      ['close_date', d.close_date]
    ])
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
          ? `Recurred across ${meetingsIn.size} meetings: a pattern, not a one-off.`
          : lead.kind === 'missed'
            ? 'An opening the seller did not pursue.'
            : 'Coaching note grounded in this call.'),
      // Both branches prefix lead.text rather than echo it bare, so the card never prints the same
      // sentence twice under "pattern" and "coaching move" (it used to for every non-missed insight).
      coaching_move:
        lead.kind === 'missed'
          ? `Next call, pursue this directly: ${lead.text}`
          : `Bring this up directly next call and get their real read: ${lead.text}`,
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
    if (!communityIdOf.has(l)) {
      let hash = 0
      for (let i = 0; i < l.length; i++) hash = (hash * 31 + l.charCodeAt(i)) | 0
      communityIdOf.set(l, hash >>> 0)
    }
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
  const bandByDeal = new Map(b.deals.map((d) => [slug(d.name), d.win_likelihood_band ?? null]))
  const accountByPerson = new Map(b.people.map((p) => [slug(p.name), p.account ?? undefined]))
  const accountBySlug = new Map(b.accounts.map((a) => [slug(a.name), a]))
  const personBySlug = new Map(b.people.map((p) => [slug(p.name), p]))
  const dealBySlug = new Map(b.deals.map((d) => [slug(d.name), d]))

  // Raw extraction files can survive a crash before their entity merge/index success. They are a local
  // checkpoint, not visible Intelligence until index.json says the source completed successfully.
  const indexedMeetings = (b.meetings ?? []).filter((m) => b.index.ingested[m.source_file]?.ok)
  const meetingsByFile = new Map(indexedMeetings.map((m) => [m.source_file, m]))
  const deals = b.deals.map((d) => toDeal(d, accountBySlug, meetingsByFile))
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
        win_likelihood_band: n.type === 'deal' ? bandByDeal.get(bare) ?? undefined : undefined,
        bid_id: n.type === 'deal' ? bare : undefined,
        degree: 0,
        community_id: 0,
        community_label: '',
        ref: ref?.file,
        date: ref?.date,
        is_client_facing: ref && meetingsByFile.get(ref.file)?.account ? true : undefined,
        last_touch: t?.lastTouch,
        days_quiet: t?.daysQuiet,
        freshness: t?.freshness,
        single_threaded: n.type === 'deal' ? cold.singleThreaded.has(n.id) : undefined,
        unmapped: n.type === 'account' ? cold.unmapped.has(n.id) : undefined
      }
    })
  // Map lookup, not nodes.find() per edge — this reruns on every 10s poll tick during an active
  // backfill, and a linear find() per endpoint made it O(edges × nodes) on what should be O(edges).
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const edges: GraphEdge[] = b.graph.edges
    .filter((e) => nodeById.has(e.from) && nodeById.has(e.to))
    .map((e) => ({ from: e.from, to: e.to, relation: e.rel, confidence: e.confidence }))
  for (const e of edges) {
    nodeById.get(e.from)!.degree++
    nodeById.get(e.to)!.degree++
  }
  communities(nodes, edges)

  const band0 = (): Record<WinLikelihoodBand, number> => ({ good: 0, mixed: 0, concerning: 0 })
  // Sum only HUMAN-CONFIRMED amounts (deal.amount — amount_pending never counts toward a rollup a human
  // hasn't confirmed), grouped per currency: nothing in this pipeline does FX conversion, so a "$120,000"
  // total across a EUR deal and a USD deal would be a fabricated number, not a rollup.
  function sumAmounts(scoped: Deal[]): Array<{ currency: string; value: number }> {
    const byCurrency = new Map<string, number>()
    for (const d of scoped) {
      if (!d.amount) continue
      byCurrency.set(d.amount.currency, (byCurrency.get(d.amount.currency) ?? 0) + d.amount.value)
    }
    return [...byCurrency.entries()].map(([currency, value]) => ({ currency, value }))
  }
  const accountSummaries: ScopeSummary[] = b.accounts.map((a) => {
    // Joined by slug, not raw name equality — `d.account` and `a.name` are independently frozen at two
    // different first-creation timestamps in ingest.ts, so casing/punctuation drift between two LLM
    // extractions of the same account name (e.g. "Acme Corp" vs "ACME Corp.") must still resolve to the
    // same account, exactly as accountBySlug/dealBySlug/personBySlug already do above.
    const accSlug = slug(a.name)
    const counts = band0()
    // Ungraded deals (null band) are deliberately NOT counted into any band — no fabrication.
    for (const d of deals.filter((d) => slug(d.account) === accSlug)) if (d.win_likelihood_band) counts[d.win_likelihood_band]++
    const accDeals = deals.filter((d) => slug(d.account) === accSlug)
    return {
      key: accSlug,
      label: a.name,
      deal_count: accDeals.length,
      total_value: sumAmounts(accDeals),
      band_counts: counts,
      insight_ids: insights.filter((i) => i.deals.some((bd) => slug(deals.find((d) => d.bid_id === bd)?.account ?? '') === accSlug)).map((i) => i.insight_id)
    }
  })
  const sectors = [...new Set(b.accounts.map((a) => a.sector))]
  const sectorSummaries: ScopeSummary[] = sectors.map((sec) => {
    const inSector = deals.filter((d) => d.sector === sec)
    const counts = band0()
    for (const d of inSector) if (d.win_likelihood_band) counts[d.win_likelihood_band]++
    return {
      key: slug(sec),
      label: sec,
      deal_count: inSector.length,
      total_value: sumAmounts(inSector),
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
    loss_reasons: a.loss_reasons ?? [],
    meetings: a.meetings ?? [],
    field_state: fieldState([['sector', a.sector_provenance]])
  }))

  const peopleOut: Person[] = b.people.map((p) => ({
    slug: slug(p.name),
    name: p.name,
    role: p.role,
    account: p.account,
    stance_trail: p.stance_trail ?? [],
    commitments: (p.commitments ?? []).filter((c) => c.status !== 'rejected').map(toCommitment),
    meetings: p.meetings ?? [],
    field_state: fieldState([
      ['role', p.role_provenance],
      ['org', p.org_provenance]
    ])
  }))

  // Newest first — a feed reads top-down by recency, same convention as an inbox.
  const meetingsFeed: MeetingFeedRow[] = [...indexedMeetings]
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
    // Pending deferred ingest (ok:false, no error, attempts:0) is waiting for consolidation — not a failure.
    .filter(([, v]) => !v.ok && !!(v.error || v.exhausted || (v.attempts ?? 0) > 0))
    .map(([file, v]) => ({ file, error: v.error ?? '' }))

  const status: StatusCounts = {
    meetings: indexedMeetings.length,
    people: b.people.length,
    accounts: b.accounts.length,
    deals: b.deals.length,
    nodes: b.graph.nodes.length,
    edges: b.graph.edges.length
  }

  return {
    meta: {
      is_placeholder: false,
      note: 'Live from your Mantu Intelligence brain, grounded in your meeting transcripts.',
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
