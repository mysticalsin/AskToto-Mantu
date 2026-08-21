// Data contract for the Deal Psychology Coaching Dashboard.
// The app reads ONE generated file: /public/data.json, matching this shape.
// See: ~/.claude/plans/deal-psychology-coaching-dashboard.md (sections 2.3, 3, 4.1)
//
// This file never reads the vault or any filesystem at runtime — data.json is
// produced by a separate build-step/extraction pipeline (out of scope here).

export type Grounding = 'verified' | 'assumed' | 'unknown'
export type Stance = 'objection' | 'positive-signal' | 'neutral-observation'
export type Category =
  | 'pricing'
  | 'technical-fit'
  | 'relationship'
  | 'timing'
  | 'competitor'
  | 'process'
  | 'commercial-model'

export type DealOutcome = 'won' | 'lost' | 'open'

/** Mirrors the host's ProvenanceState (src/shared/brain.ts) for exactly the provenance-bearing fields
 *  Deal/Account/Person carry — keyed by the SAME field name brain:field-decision/brain:entityUpdateField
 *  use ('stage'/'win_likelihood_band'/'velocity' for Deal, 'sector' for Account, 'role'/'org' for
 *  Person). A field absent from the map has no provenance sidecar at all (legacy data, or the
 *  standalone data.json build, which never carries provenance) — views must treat a missing entry as
 *  "nothing to review", never as an implicit 'extracted'. */
export type FieldState = Partial<Record<string, 'extracted' | 'verified' | 'edited' | 'pinned'>>

/** Layer 1 — a single atomic, cited claim extracted from one deal's sources. */
export interface Claim {
  claim_id: string
  statement: string
  category: Category
  // Optional: the brain's signal extraction never tags who raised a claim — the field used to be
  // hardcoded to the fake constant 'meeting participant'. Omitted (not faked) when unknown; views must
  // render its absence, never invent a speaker.
  raised_by?: string
  stance: Stance
  // Optional and never set by the live adapter: the extraction schema has no "was this the deciding
  // factor" signal to ground it in, and hardcoding it to `false` (the previous behavior) is a fabricated
  // fact, not an honest absence. Kept as a field (not deleted) only because DealView.tsx still reads it.
  was_deciding_factor?: boolean
  source: {
    file: string
    quote_or_paraphrase: string
    grounding: Grounding
  }
  confidence: number
}

/** Layer 2 — a coaching insight rolled up from one or more claims/deals. */
export interface CoachingInsight {
  insight_id: string
  pattern: string
  n_observations: number
  deals: string[]
  what_happened: string
  why_it_matters: string
  coaching_move: string
  category: Category
  confidence: number
  grounding: Grounding
  sources: Array<{ file: string; quote_or_paraphrase: string }>
}

// Matches the real extraction pipeline's vocabulary exactly (good/mixed/concerning) — the same
// 3-band label used for per-call quality grading, kept consistent at the deal-rollup level too.
// Never a percentage: there is no statistical/historical win-rate model behind this (see risk_score.json
// method_note in the vault) — this is an LLM-as-judge qualitative estimate grounded in cited evidence.
export type WinLikelihoodBand = 'good' | 'mixed' | 'concerning'

/**
 * A promise actually spoken in a meeting (the brain's Commitment Ledger — src/main/brain/store.ts's
 * LedgerCommitmentSchema). `by` is 'you', 'them', or a named person (freeform, no enum in the source).
 * `status` only ever moves off 'open' via later meeting evidence or explicit human action.
 */
export interface Commitment {
  text: string
  by: string
  status: 'open' | 'kept' | 'broken'
  due_hint: string
  quote: string
  date: string
  meeting: string
}

/** A meeting ref an entity was mapped to — same 3-field shape as the brain's own MeetingRef schema
 *  (src/shared/brain.ts). Feeds the shared Timeline component across Deal/Account/Person detail panes. */
export interface MeetingRef {
  file: string
  date: string
  title: string
}

export interface Deal {
  bid_id: string
  account: string
  // Optional: the vault's account brief doesn't currently populate this field for every account (a
  // planned taxonomy that isn't live yet) — never fabricate one when it's genuinely absent.
  strategic_group?: string
  sector: string
  display_name: string
  outcome: DealOutcome
  // null = the brain never graded this deal (no cited evidence). MUST stay null — coercing it to a real
  // band (previously '?? mixed') fabricates a qualitative sales signal and inflates the mixed count in
  // every chart/summary. Views render null as an explicit "ungraded" state.
  win_likelihood_band: WinLikelihoodBand | null
  value_usd: number | null
  stage: string
  // Why the band is what it is, in the extraction's own words — '' when the brain recorded none.
  band_evidence: string
  velocity: {
    signal: 'hard-calendar-gate' | 'soft-organizational-gate' | 'no-hard-date-found'
    evidence: string
  }
  claims: Claim[]
  call_grades: Array<{
    date: string
    label: string
    // 'not-applicable' is a real, expected value — internal-only calls (prep, dry-runs, debriefs) are
    // deliberately never graded as if they were client interactions. Letter grades were never part of
    // the plan's design (it explicitly rejects fake precision); this is the qualitative vocabulary the
    // real extraction pipeline actually produces.
    grade: 'good' | 'mixed' | 'concerning' | 'not-applicable'
    note: string
    // true when the meeting's extraction named an account. ABSENT, not false, when it did not: the
    // bundled model often returns a null account name (MQA-112) and the whole sidecar is nulled, so a
    // missing account is missing attribution — never evidence the call was internal. Same contract as
    // GraphNode.is_client_facing below, which callers already gate with `!== undefined`.
    is_client_facing?: boolean
  }>
  commitments: Commitment[]
  // Every meeting ref this deal was tagged in, including ones extraction hasn't landed for yet — a
  // superset of call_grades (which only shows refs already joined to a landed extraction).
  meetings: MeetingRef[]
  // See FieldState's doc comment above. Absent entirely for the standalone data.json build.
  field_state?: FieldState
}

/** account_graph node/edge shape for the relationship-graph view. */
export interface GraphNode {
  id: string
  label: string
  type: 'account' | 'deal' | 'person' | 'strategic_group' | 'sector'
  account?: string
  strategic_group?: string
  sector?: string
  win_likelihood_band?: WinLikelihoodBand
  bid_id?: string
  degree: number
  // Real fields from the vault's account_graph.json, previously dropped on remap — carried through so
  // the info panel can show the actual meeting date / client-facing flag / source reference instead of
  // just id+label+type.
  ref?: string
  date?: string
  is_client_facing?: boolean
  // Real graph-structural clustering (connected components today, upgradeable to a weighted
  // community-detection algorithm once the graph has enough cross-account edges to make one
  // meaningful) — computed in build-data.mjs, never hand-assigned. community_label is derived
  // from the dominant sector/account inside that component, not a generic "Community N".
  community_id: number
  community_label: string
  // Going-Cold layer (innovation #8): the graph learns time. Derived from each entity's own dated
  // meeting refs — absent when the entity has no dated meetings (placeholder data included).
  last_touch?: string
  days_quiet?: number
  freshness?: 'fresh' | 'cooling' | 'cold'
  /** Deal at an account with ≤1 mapped person — the whole deal hangs on one thread. */
  single_threaded?: boolean
  /** Account with zero mapped people — the unexplored region. */
  unmapped?: boolean
}

/** A "going cold" rail row: a cooling/cold relationship plus the honest re-engagement hook. */
export interface GoingColdRow {
  nodeId: string
  label: string
  type: 'person' | 'account'
  account?: string
  daysQuiet: number
  hook: string
}

export interface GraphEdge {
  from: string
  to: string
  relation: string
  confidence: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS'
}

export interface AccountGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

// Real, derived rollups — no fabricated ROI %: there's no cost/spend data anywhere in the vault to
// divide against, so "ROI" here means the honest things that ARE knowable: deal value at stake and
// the win-likelihood distribution across deals in this scope, plus the actual grounded coaching
// insights tied to those deals (why we're winning/losing, sourced from real cited claims).
export interface ScopeSummary {
  key: string
  label: string
  deal_count: number
  // null = no value data exists in this scope's sources (the live brain never extracts money from
  // transcripts). Views must render the absence honestly ("no value data"), never a fabricated $0.
  total_value_usd: number | null
  band_counts: Record<WinLikelihoodBand, number>
  insight_ids: string[]
}

/** A cited reason an account was won or lost — statement + verbatim anchor + source meeting. */
export interface Reason {
  statement: string
  quote: string
  meeting: string
}

/** The account entity itself (distinct from ScopeSummary, which is a per-scope rollup across deals). */
export interface Account {
  slug: string
  name: string
  sector: string
  strategic: boolean
  win_reasons: Reason[]
  loss_reasons: Reason[]
  meetings: MeetingRef[]
  // See FieldState's doc comment above. Absent entirely for the standalone data.json build.
  field_state?: FieldState
}

export interface StanceTrailEntry {
  meeting: string
  kind: string
  statement: string
}

/** The person entity itself — role, which account they belong to, their own commitment ledger, and
 *  the trail of stances they've taken across meetings (for spotting a champion cooling off). */
export interface Person {
  slug: string
  name: string
  role: string | null
  account: string | null
  stance_trail: StanceTrailEntry[]
  commitments: Commitment[]
  meetings: MeetingRef[]
  // See FieldState's doc comment above. Absent entirely for the standalone data.json build.
  field_state?: FieldState
}

/** One row of the meetings feed — every ingested meeting, newest first. */
export interface MeetingFeedRow {
  slug: string
  title24: string
  date: string
  account: string | null
  sentiment: WinLikelihoodBand
  topics: string[]
}

/** A transcript that failed extraction — surfaced honestly instead of silently vanishing from counts. */
export interface IngestError {
  file: string
  error: string
}

/** Mirrors the host app's BrainStatus counts (src/shared/brain.ts) — the raw brain, not the
 *  display-filtered graph (account_graph drops meeting nodes; these counts don't). */
export interface StatusCounts {
  meetings: number
  people: number
  accounts: number
  deals: number
  nodes: number
  edges: number
}

export interface DashboardData {
  meta: {
    is_placeholder: boolean
    note: string
    generated: string
    n_deals: number
  }
  deals: Deal[]
  coaching_insights: CoachingInsight[]
  account_graph: AccountGraph
  // Per-account and per-sector rollups for the graph view's win/loss + ROI intelligence panel.
  account_summaries: ScopeSummary[]
  sector_summaries: ScopeSummary[]
  // Going-Cold rail (optional: absent in placeholder data.json) — coldest relationships first.
  going_cold?: GoingColdRow[]
  // Entity detail carried through in full (see Account/Person doc comments) — the graph/scope summaries
  // above are rollups; these are the underlying records, e.g. for a per-account or per-person detail view.
  accounts: Account[]
  people: Person[]
  meetings_feed: MeetingFeedRow[]
  // Brain-wide health, surfaced honestly instead of dropped on the floor.
  warnings: string[]
  ingest_errors: IngestError[]
  status: StatusCounts
}
