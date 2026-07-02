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

/** Layer 1 — a single atomic, cited claim extracted from one deal's sources. */
export interface Claim {
  claim_id: string
  statement: string
  category: Category
  raised_by: string
  stance: Stance
  was_deciding_factor: boolean
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

export interface Deal {
  bid_id: string
  account: string
  // Optional: the vault's account brief doesn't currently populate this field for every account (a
  // planned taxonomy that isn't live yet) — never fabricate one when it's genuinely absent.
  strategic_group?: string
  sector: string
  display_name: string
  outcome: DealOutcome
  win_likelihood_band: WinLikelihoodBand
  value_usd: number | null
  stage: string
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
    is_client_facing: boolean
  }>
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
}
