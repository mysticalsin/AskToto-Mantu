/**
 * B5: questions + skills analytics (plan section 7 row B5, plan 6.11 Settings "Questions" and
 * "Skills" tabs). `GET /v1/admin/questions.json?range=24h|7d|30d` and `GET /v1/admin/skills.json`.
 *
 * Both routes are computed entirely from structured `asks` fields (mode, question_type, provider,
 * model, rating, outcome, tokens, cache_status, total_ms) and the `proposals`/`packs` tables --
 * never prompt text. The one existing path to real ask text, `GET /v1/admin/asks/:id`
 * (operator/src/routes/admin-core.ts, a file this task does not own), stays the single audited
 * "Reveal" -- nothing here shortcuts it or echoes `preview`/`prompt_cipher`.
 *
 * Cache-hit-rate, latency-by-cache-bucket and cost-estimate math reuse the exact shared functions
 * operator/src/dashboard.ts already uses (`aggregateCacheSlice`, `estimateCacheCost`,
 * `formatUsdEstimate` from repo-root src/shared/operator.ts) so Settings never disagrees with
 * Overview about what "cache hit" or "cost" means. `dashboard.ts`'s own `askLine()`/`costForAsks()`
 * mappers are private to that file (not exported), so this module carries its own copies of the
 * same few lines rather than reaching into a file it does not own.
 */
import {
  aggregateCacheSlice,
  estimateCacheCost,
  formatUsdEstimate,
  type AskLogLine,
  type CacheBadge,
  type CacheTtl
} from '../../../src/shared/operator'
import { aggregateQuestionTypes, type QuestionTypeMix } from '../../../src/shared/question-type'
import { json } from '../http'
import type { AskRow } from '../store'
import type { AdminCtx } from './admin-ctx'
import { defineRoute } from './registry'
import { profileOf, seatCache } from './seat-view'

// ---------------------------------------------------------------------------
// Small, local, pure helpers (see file doc comment: deliberately not imported from dashboard.ts).
// ---------------------------------------------------------------------------

type QuestionsRange = '24h' | '7d' | '30d'
const RANGE_MS: Record<QuestionsRange, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000
}

function resolveQuestionsRange(raw: string | null): QuestionsRange {
  return raw === '24h' || raw === '7d' || raw === '30d' ? raw : '7d'
}

/** Mirrors dashboard.ts's private `askLine()`: the same AskRow -> AskLogLine field mapping, needed
 *  here to reuse the shared cache-slice math. */
function askLogLine(a: AskRow): AskLogLine {
  return {
    id: a.id,
    ts: a.ts,
    mode: a.mode ?? undefined,
    skillId: a.skill_id ?? undefined,
    skillVersion: a.skill_version ?? undefined,
    provider: a.provider ?? undefined,
    model: a.model ?? undefined,
    ttftMs: a.ttft_ms ?? undefined,
    totalMs: a.total_ms ?? undefined,
    inputTokens: a.input_tokens ?? undefined,
    outputTokens: a.output_tokens ?? undefined,
    cacheRead: a.cache_read ?? undefined,
    cacheWrite: a.cache_write ?? undefined,
    cacheUncached: a.cache_uncached ?? undefined,
    cacheStatus: (a.cache_status as CacheBadge | null) ?? undefined,
    cacheTtl: (a.cache_ttl as CacheTtl | null) ?? undefined,
    rating: a.rating === 'up' || a.rating === 'down' ? a.rating : undefined,
    outcome: a.outcome === 'answered' || a.outcome === 'error' || a.outcome === 'thumbs-down' ? a.outcome : undefined
  }
}

/** Nearest-rank percentile over whatever finite numbers were actually reported. Null input (no
 *  seat reported a latency in this window) is null, never a fabricated 0. */
function percentile(values: number[], p: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

/** Mirrors dashboard.ts's private `costForAsks()`: list-price estimate summed from the exported
 *  `estimateCacheCost()`, formatted with the exported `formatUsdEstimate()`. Null (not a $0
 *  string) when not one ask in the set carried enough cache/token detail to price. */
function costForAsks(asks: AskRow[]): string | null {
  let usd = 0
  let any = false
  for (const a of asks) {
    const est = estimateCacheCost(
      {
        cacheRead: a.cache_read ?? undefined,
        cacheWrite: a.cache_write ?? undefined,
        cacheUncached: a.cache_uncached ?? undefined,
        cacheStatus: (a.cache_status as CacheBadge | null) ?? undefined,
        cacheTtl: (a.cache_ttl as CacheTtl | null) ?? undefined,
        outputTokens: a.output_tokens ?? undefined
      },
      a.model || '',
      a.provider || undefined
    )
    if (est) {
      any = true
      usd += est.usd
    }
  }
  return any ? formatUsdEstimate(usd) : null
}

interface CountRow {
  key: string
  count: number
}

/** Generic "group by a key, count, sort by count desc" -- providers, models. Rows with no key
 *  (provider/model not reported) are excluded rather than counted under a fake "unknown" bucket:
 *  the Questions tab already reports overall coverage separately. */
function countBy(rows: AskRow[], keyFn: (a: AskRow) => string | null): CountRow[] {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const key = keyFn(row)
    if (!key) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
}

interface ByModeRow {
  mode: string
  count: number
  topType: { type: string; label: string; count: number } | null
  ratings: { up: number; down: number }
  errorRate: number | null
  latencyP50Ms: number | null
}

function byModeRows(asks: AskRow[]): ByModeRow[] {
  const grouped = new Map<string, AskRow[]>()
  for (const a of asks) {
    const mode = a.mode || 'unknown'
    const arr = grouped.get(mode) ?? []
    arr.push(a)
    grouped.set(mode, arr)
  }
  return [...grouped.entries()]
    .map(([mode, rows]) => {
      const mix = aggregateQuestionTypes(rows.map((r) => r.question_type))
      const latencies = rows.map((r) => r.total_ms).filter((n): n is number => typeof n === 'number')
      return {
        mode,
        count: rows.length,
        topType: mix.bars[0] ? { type: mix.bars[0].type, label: mix.bars[0].label, count: mix.bars[0].count } : null,
        ratings: { up: rows.filter((r) => r.rating === 'up').length, down: rows.filter((r) => r.rating === 'down').length },
        errorRate: rows.length ? rows.filter((r) => r.outcome === 'error').length / rows.length : null,
        latencyP50Ms: percentile(latencies, 50)
      }
    })
    .sort((a, b) => b.count - a.count || a.mode.localeCompare(b.mode))
}

interface NeedsAttentionRow {
  id: string
  ts: number
  mode: string | null
  questionType: string | null
  provider: string | null
  model: string | null
  outcome: string | null
  rating: string | null
  latencyMs: number | null
  seat: string
}

async function needsAttentionRows(ctx: AdminCtx, asks: AskRow[]): Promise<NeedsAttentionRow[]> {
  const flagged = asks
    .filter((a) => a.outcome === 'error' || a.rating === 'down')
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 20)
  const seatOf = seatCache(ctx.store)
  return Promise.all(
    flagged.map(async (a) => {
      const profile = profileOf(await seatOf(a.device_id))
      return {
        id: a.id,
        ts: a.ts,
        mode: a.mode,
        questionType: a.question_type,
        provider: a.provider,
        model: a.model,
        outcome: a.outcome,
        rating: a.rating,
        latencyMs: a.total_ms,
        seat: profile.hostname || profile.email || `seat ${a.device_id.slice(0, 8)}`
      }
    })
  )
}

export interface QuestionsPayloadFull {
  ok: true
  range: QuestionsRange
  since: number
  until: number
  totalAsks: number
  mix: QuestionTypeMix
  coverage: number | null
  byMode: ByModeRow[]
  ratings: { rated: number; up: number; down: number; positiveRate: number | null }
  errorRate: number | null
  latency: { p50Ms: number | null; p95Ms: number | null; sampleSize: number }
  cache: { hitRate: number | null; tokensRead: number; tokensWrite: number }
  providers: CountRow[]
  models: CountRow[]
  cost: string | null
  needsAttention: NeedsAttentionRow[]
}

async function buildQuestionsPayload(ctx: AdminCtx): Promise<QuestionsPayloadFull> {
  const range = resolveQuestionsRange(ctx.url.searchParams.get('range'))
  const since = ctx.now - RANGE_MS[range]
  const asks = await ctx.store.listAsks(5000, since)

  const mix = aggregateQuestionTypes(asks.map((a) => a.question_type))
  const rated = asks.filter((a) => a.rating === 'up' || a.rating === 'down')
  const up = rated.filter((a) => a.rating === 'up').length
  const down = rated.filter((a) => a.rating === 'down').length
  const errored = asks.filter((a) => a.outcome === 'error').length
  const latencies = asks.map((a) => a.total_ms).filter((n): n is number => typeof n === 'number')
  const cacheSlice = aggregateCacheSlice(asks.map(askLogLine))

  return {
    ok: true,
    range,
    since,
    until: ctx.now,
    totalAsks: asks.length,
    mix,
    coverage: mix.coverage,
    byMode: byModeRows(asks),
    ratings: { rated: rated.length, up, down, positiveRate: rated.length ? up / rated.length : null },
    errorRate: asks.length ? errored / asks.length : null,
    latency: { p50Ms: percentile(latencies, 50), p95Ms: percentile(latencies, 95), sampleSize: latencies.length },
    cache: { hitRate: cacheSlice.hitRate, tokensRead: cacheSlice.tokensRead, tokensWrite: cacheSlice.tokensWrite },
    providers: countBy(asks, (a) => a.provider),
    models: countBy(asks, (a) => (a.provider && a.model ? `${a.provider} / ${a.model}` : null)),
    cost: costForAsks(asks),
    needsAttention: await needsAttentionRows(ctx, asks)
  }
}

// ---------------------------------------------------------------------------
// Skills: proposals board evidence + push history/adoption.
// ---------------------------------------------------------------------------

const EVIDENCE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

interface ProposalEvidence {
  askCount: number
  topTypes: { type: string; label: string; count: number }[]
  ratings: { up: number; down: number }
}

function evidenceFor(skillId: string, asks: AskRow[], now: number): ProposalEvidence {
  const since = now - EVIDENCE_WINDOW_MS
  const rows = asks.filter((a) => a.ts >= since && (a.skill_id === skillId || a.mode === skillId))
  const mix = aggregateQuestionTypes(rows.map((r) => r.question_type))
  return {
    askCount: rows.length,
    topTypes: mix.bars.slice(0, 3).map((b) => ({ type: b.type, label: b.label, count: b.count })),
    ratings: { up: rows.filter((r) => r.rating === 'up').length, down: rows.filter((r) => r.rating === 'down').length }
  }
}

export interface SkillsPayloadFull {
  ok: true
  proposals: {
    id: string
    skillId: string
    fromVersion: string
    status: string
    createdBy: string
    createdAt: number
    decidedAt: number | null
    rejectReason: string | null
    rationale: string
    diff: string
    evidence: ProposalEvidence
  }[]
  history: {
    id: string
    skillId: string
    version: string
    sha256: string
    pushedAt: number
    pushedBy: string
    pulledBySeats: number
  }[]
}

async function buildSkillsPayload(ctx: AdminCtx): Promise<SkillsPayloadFull> {
  const [proposals, packs, asks] = await Promise.all([
    ctx.store.listProposals(100),
    ctx.store.listPacks(),
    ctx.store.listAsks(5000)
  ])

  const proposalRows = proposals.map((p) => ({
    id: p.id,
    skillId: p.skill_id,
    fromVersion: p.from_version,
    status: p.status,
    createdBy: p.created_by,
    createdAt: p.created_at,
    decidedAt: p.decided_at,
    rejectReason: p.reject_reason,
    rationale: p.rationale,
    diff: p.diff,
    evidence: evidenceFor(p.skill_id, asks, ctx.now)
  }))

  // Adoption (plan 6.11: "history with which seats pulled the manifest"): no seat ever logs a
  // manifest pull directly, so this reads the version each seat's most recent Ask actually carried
  // -- the closest honest signal already in `asks`, never a fabricated download count.
  const latestByDevice = new Map<string, AskRow>()
  for (const a of asks) {
    const cur = latestByDevice.get(a.device_id)
    if (!cur || a.ts > cur.ts) latestByDevice.set(a.device_id, a)
  }
  const adoptionCounts = new Map<string, number>()
  for (const a of latestByDevice.values()) {
    if (!a.skill_id || !a.skill_version) continue
    const key = `${a.skill_id}@${a.skill_version}`
    adoptionCounts.set(key, (adoptionCounts.get(key) ?? 0) + 1)
  }

  const history = [...packs]
    .sort((a, b) => b.pushed_at - a.pushed_at)
    .map((pack) => ({
      id: pack.id,
      skillId: pack.skill_id,
      version: pack.version,
      sha256: pack.sha256,
      pushedAt: pack.pushed_at,
      pushedBy: pack.pushed_by,
      pulledBySeats: adoptionCounts.get(`${pack.skill_id}@${pack.version}`) ?? 0
    }))

  return { ok: true, proposals: proposalRows, history }
}

// ---------------------------------------------------------------------------
// Routes.
// ---------------------------------------------------------------------------

export function registerInsightsRoutes(): void {
  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: '/v1/admin/questions.json',
    auth: 'admin',
    handler: async (_request, ctx) => json(await buildQuestionsPayload(ctx))
  })

  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: '/v1/admin/skills.json',
    auth: 'admin',
    handler: async (_request, ctx) => json(await buildSkillsPayload(ctx))
  })
}
