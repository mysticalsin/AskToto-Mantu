/**
 * Ledger aggregates — the promise-keeping numbers the dashboard has never rolled up anywhere. Pure
 * functions only: `now` (epoch ms) is always injected where age matters, never read from the clock
 * here. Independent of brainAdapter.ts / types/data.ts on purpose (see momentum.ts's header for why)
 * — minimal structural interfaces are declared locally so any adapter shape can be passed straight in.
 *
 * Status vocabulary is the display subset of the real ledger schema (src/shared/brain.ts
 * LedgerCommitmentSchema): 'open' | 'kept' | 'broken', defaulting to 'open' when a legacy row predates
 * the `status` field. The schema also carries 'rejected' — a human override for a promise that was never
 * made — but brainAdapter drops those rows before anything reaches this file, so a row here that is
 * neither kept nor broken is genuinely open rather than one the user already struck out.
 */

export interface CommitmentLike {
  status?: string
  date?: string
}

export interface LedgerTotals {
  open: number
  kept: number
  broken: number
  total: number
  /** kept / (kept + broken). Null — never a fabricated 100% — when nothing has settled yet. */
  keptRate: number | null
}

/** Tallies a flat list of commitment-shaped rows into open/kept/broken counts plus a keptRate that
 *  is honestly null (not 0, not 1) until at least one row has actually settled. */
export function ledgerTotals(ledgers: CommitmentLike[]): LedgerTotals {
  let open = 0
  let kept = 0
  let broken = 0
  for (const row of ledgers) {
    const status = (row.status ?? 'open').toLowerCase()
    if (status === 'kept') kept++
    else if (status === 'broken') broken++
    else open++
  }
  const settled = kept + broken
  return { open, kept, broken, total: open + kept + broken, keptRate: settled === 0 ? null : kept / settled }
}

/**
 * Parses a leading `YYYY-MM-DD` off a date string as a UTC midnight timestamp, rejecting anything
 * that isn't a real calendar date (mirrors momentum.ts's parseDateUTC — duplicated rather than shared
 * so this file stays a standalone, dependency-free unit like momentum.ts).
 */
function parseDateUTC(dateStr: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const t = Date.UTC(year, month - 1, day)
  const check = new Date(t)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null
  return t
}

export type AgeBucketLabel = '<7d' | '7-30d' | '30-90d' | '>90d'
const AGE_BUCKET_LABELS: AgeBucketLabel[] = ['<7d', '7-30d', '30-90d', '>90d']

export interface AgingBucket<T> {
  label: AgeBucketLabel
  items: T[]
}

export interface AgingBucketsResult<T> {
  buckets: AgingBucket<T>[]
  /** Open commitments with no valid date — can't be aged, so they're never silently dropped nor
   *  guessed into a bucket; they get their own pile. */
  undated: T[]
}

/** Buckets OPEN commitments by age since their commitment date. Kept/broken rows are already settled
 *  and have nothing to age towards, so they're excluded here (use ledgerTotals for the settled view). */
export function agingBuckets<T extends CommitmentLike>(commitments: T[], now: number): AgingBucketsResult<T> {
  const byLabel = new Map<AgeBucketLabel, T[]>(AGE_BUCKET_LABELS.map((l) => [l, []]))
  const undated: T[] = []

  for (const row of commitments) {
    const status = (row.status ?? 'open').toLowerCase()
    if (status !== 'open') continue
    const t = row.date ? parseDateUTC(row.date) : null
    if (t === null) {
      undated.push(row)
      continue
    }
    const ageDays = Math.max(0, (now - t) / (24 * 60 * 60 * 1000))
    const label: AgeBucketLabel = ageDays < 7 ? '<7d' : ageDays < 30 ? '7-30d' : ageDays < 90 ? '30-90d' : '>90d'
    byLabel.get(label)!.push(row)
  }

  return { buckets: AGE_BUCKET_LABELS.map((label) => ({ label, items: byLabel.get(label)! })), undated }
}

export interface OwnerReliability {
  person: string
  kept: number
  broken: number
  open: number
  keptRate: number | null
}

/** Per-person reliability, sorted worst-first (lowest keptRate first) — people with zero settled
 *  rows can't be judged yet, so they sink to the bottom rather than sorting as either best or worst. */
export function reliabilityByOwner(ledgersByPerson: Record<string, CommitmentLike[]>): OwnerReliability[] {
  const out: OwnerReliability[] = Object.entries(ledgersByPerson).map(([person, rows]) => {
    const totals = ledgerTotals(rows)
    return { person, kept: totals.kept, broken: totals.broken, open: totals.open, keptRate: totals.keptRate }
  })

  out.sort((a, b) => {
    if (a.keptRate === null && b.keptRate === null) return 0
    if (a.keptRate === null) return 1
    if (b.keptRate === null) return -1
    return a.keptRate - b.keptRate
  })
  return out
}

export interface DealOutcomeLike {
  outcome?: string
}

/** Deal outcome counts. Missing/unrecognized outcome defaults to 'open', mirroring the ledger
 *  status convention above and the brain schema's own default. */
export function outcomeDistribution(deals: DealOutcomeLike[]): { open: number; won: number; lost: number } {
  let open = 0
  let won = 0
  let lost = 0
  for (const deal of deals) {
    const outcome = (deal.outcome ?? 'open').toLowerCase()
    if (outcome === 'won') won++
    else if (outcome === 'lost') lost++
    else open++
  }
  return { open, won, lost }
}

export interface DealBandLike {
  win_likelihood_band?: string | null
}

export interface BandDistribution {
  good: number
  mixed: number
  concerning: number
  /** Null/unset band — a deal that hasn't been graded yet. Never folded into 'mixed' as a guess. */
  unknown: number
}

/** Counts deals per win-likelihood band, matching the extraction pipeline's exact vocabulary
 *  (good/mixed/concerning) plus an honest 'unknown' bucket for ungraded deals. */
export function bandDistribution(deals: DealBandLike[]): BandDistribution {
  const out: BandDistribution = { good: 0, mixed: 0, concerning: 0, unknown: 0 }
  for (const deal of deals) {
    if (deal.win_likelihood_band === 'good') out.good++
    else if (deal.win_likelihood_band === 'mixed') out.mixed++
    else if (deal.win_likelihood_band === 'concerning') out.concerning++
    else out.unknown++
  }
  return out
}

export interface ClaimLike {
  category?: string
  stance?: string
}

/** Counts claims per category, then per stance within that category — e.g. `{pricing: {objection: 3,
 *  'positive-signal': 1}}`. Missing category/stance falls into an honest 'unknown' key rather than
 *  being dropped or guessed into an existing bucket. */
export function stanceMix(claims: ClaimLike[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {}
  for (const claim of claims) {
    const category = claim.category ?? 'unknown'
    const stance = claim.stance ?? 'unknown'
    const byStance = out[category] ?? {}
    byStance[stance] = (byStance[stance] ?? 0) + 1
    out[category] = byStance
  }
  return out
}
