/**
 * responsiveness-metrics.ts — the typed contract for Métis 2.12 responsiveness metrics (G12).
 *
 * Counts and latencies only. Nothing here can carry a prompt, an answer, a transcript or a screen: every
 * value is a metric id, a number or one of a fixed set of labels, and the report schema is strict. A metric
 * with no measurement reads "not measured"; a number is never invented, defaulted or smoothed.
 *
 * The budget values live in responsiveness-budgets.json. They are PROPOSED engineering targets from the
 * Rebuild spec (section 6), not results. A metric the spec gives no value for is UNSET.
 */
import { z } from 'zod'
import budgetFile from './responsiveness-budgets.json'

/** Channels live beside the contract (like OWNER_SESSION_IPC) so the shared IPC table does not grow. */
export { RESPONSIVENESS_IPC } from './responsiveness-ipc'

export const LATENCY_METRICS = [
  'first_partial_ms',
  'useful_suggestion_ms',
  'display_receipt_ms',
  'ask_cancel_release_ms',
  'queue_wait_ms'
] as const
export const COUNTER_METRICS = [
  'suggestions_shown',
  'suggestions_displayed',
  'asks_cancelled',
  'intervention_generated',
  'intervention_eligible',
  'intervention_displayed',
  'intervention_dismissed',
  'intervention_expired',
  'intervention_superseded',
  'router_local_first',
  'router_cloud_first',
  'router_unavailable',
  'handoff_started',
  'handoff_superseded',
  'handoff_refused',
  'card_duplicate_rolled_back',
  'card_duplicate_retained',
  'card_review_expired',
  'card_review_superseded'
] as const
export const PEAK_METRICS = ['queue_depth_peak'] as const

export type LatencyMetricId = (typeof LATENCY_METRICS)[number]
export type CounterMetricId = (typeof COUNTER_METRICS)[number]
export type PeakMetricId = (typeof PEAK_METRICS)[number]
export type MetricId = LatencyMetricId | CounterMetricId | PeakMetricId

export const METRIC_IDS: readonly MetricId[] = [...LATENCY_METRICS, ...COUNTER_METRICS, ...PEAK_METRICS]

export type MetricKind = 'latency' | 'counter' | 'peak'

export interface MetricDefinition {
  kind: MetricKind
  unit: 'ms' | 'count'
  label: string
  /** `wired`: a real event site records it today. `slot`: typed and reported, recorded by `owner` later. */
  wiring: 'wired' | 'slot'
  owner: string | null
  /** Where the clock starts and stops, in words. Empty for counters and peaks. */
  measuredFrom: string | null
  measuredTo: string | null
}

const latency = (
  label: string,
  measuredFrom: string,
  measuredTo: string,
  wiring: { wired: true } | { owner: string }
): MetricDefinition => ({
  kind: 'latency',
  unit: 'ms',
  label,
  wiring: 'wired' in wiring ? 'wired' : 'slot',
  owner: 'owner' in wiring ? wiring.owner : null,
  measuredFrom,
  measuredTo
})
const counter = (label: string, wiring: { wired: true; owner?: string } | { owner: string }): MetricDefinition => ({
  kind: 'counter',
  unit: 'count',
  label,
  wiring: 'wired' in wiring ? 'wired' : 'slot',
  owner: wiring.owner ?? null,
  measuredFrom: null,
  measuredTo: null
})

export const METRIC_DEFINITIONS: Readonly<Record<MetricId, MetricDefinition>> = {
  first_partial_ms: latency(
    'First partial transcript',
    'first PCM chunk sent to the live speech session',
    'first partial or final text handed to the renderer',
    { wired: true }
  ),
  useful_suggestion_ms: latency(
    'Useful suggestion',
    'suggest request received in main',
    'first visible token sent to the renderer',
    { wired: true }
  ),
  display_receipt_ms: latency(
    'Suggestion display receipt',
    'first visible token sent to the renderer',
    'renderer confirms the suggestion is on screen',
    { wired: true }
  ),
  ask_cancel_release_ms: latency(
    'Ask cancellation',
    'cancel request received in main',
    'abort handle returned and the stream released in main',
    { wired: true }
  ),
  queue_wait_ms: latency('Queue wait', 'job enqueued', 'job leased', { owner: 'G14' }),
  suggestions_shown: counter('Suggestions shown', { wired: true }),
  suggestions_displayed: counter('Suggestions confirmed on screen', { wired: true }),
  asks_cancelled: counter('Asks cancelled', { wired: true }),
  intervention_generated: counter('Interventions generated', { owner: 'G70' }),
  intervention_eligible: counter('Interventions eligible', { owner: 'G70' }),
  intervention_displayed: counter('Interventions displayed', { owner: 'G70' }),
  intervention_dismissed: counter('Interventions dismissed', { owner: 'G70' }),
  intervention_expired: counter('Interventions expired', { owner: 'G70' }),
  intervention_superseded: counter('Interventions superseded', { owner: 'G70' }),
  router_local_first: counter('Requests routed on-device first', { wired: true }),
  router_cloud_first: counter('Requests routed to a provider first', { wired: true }),
  router_unavailable: counter('Requests the router refused', { wired: true }),
  handoff_started: counter('Fast-to-deep handoffs started', { wired: true }),
  handoff_superseded: counter('Fast answers superseded by a deep one', { wired: true }),
  handoff_refused: counter('Deeper asks run fresh, not handed off', { wired: true }),
  card_duplicate_rolled_back: counter('Duplicate suggestions rolled back to the prior card', {
    wired: true,
    owner: 'G71'
  }),
  card_duplicate_retained: counter('Suggestions kept after the duplicate review', { wired: true, owner: 'G71' }),
  card_review_expired: counter('Duplicate reviews that ran out of time', { wired: true, owner: 'G71' }),
  card_review_superseded: counter('Duplicate reviews overtaken by a newer card', { wired: true, owner: 'G71' }),
  queue_depth_peak: {
    kind: 'peak',
    unit: 'count',
    label: 'Queue depth peak',
    wiring: 'slot',
    owner: 'G14',
    measuredFrom: null,
    measuredTo: null
  }
}

// ---------------------------------------------------------------------------------------------------------
// Budget file
// ---------------------------------------------------------------------------------------------------------

const BudgetEntrySchema = z
  .object({
    p95Ms: z.number().positive().finite().nullable(),
    label: z.enum(['PROPOSED', 'UNSET']),
    basis: z.string().min(10).max(600)
  })
  .strict()
  .refine((entry) => (entry.label === 'PROPOSED') === (entry.p95Ms !== null), {
    message: 'PROPOSED needs a number and UNSET must not have one'
  })

export type BudgetEntry = z.infer<typeof BudgetEntrySchema>

const latencyBudgetShape = Object.fromEntries(LATENCY_METRICS.map((id) => [id, BudgetEntrySchema])) as Record<
  LatencyMetricId,
  typeof BudgetEntrySchema
>

const BudgetFileSchema = z
  .object({
    schema: z.literal(1),
    status: z.literal('PROPOSED'),
    source: z.string().min(10).max(600),
    minSamples: z.number().int().min(1).max(10_000),
    budgets: z.object(latencyBudgetShape).strict()
  })
  .strict()

export type BudgetFile = z.infer<typeof BudgetFileSchema>

export function parseBudgetFile(raw: unknown): BudgetFile {
  return BudgetFileSchema.parse(raw)
}

export const RESPONSIVENESS_BUDGETS: BudgetFile = parseBudgetFile(budgetFile)

// ---------------------------------------------------------------------------------------------------------
// Snapshot and report
// ---------------------------------------------------------------------------------------------------------

/** Most latency samples kept per metric; the oldest drops first. Bounded so the store never grows. */
export const MAX_LATENCY_SAMPLES = 200
/** A latency above this is a clock fault, not a measurement. */
export const MAX_PLAUSIBLE_LATENCY_MS = 60 * 60 * 1000

const sampleList = z.array(z.number().finite().min(0).max(MAX_PLAUSIBLE_LATENCY_MS)).max(MAX_LATENCY_SAMPLES)
const countValue = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

function recordOf<T extends readonly string[], V extends z.ZodTypeAny>(ids: T, value: V) {
  return z
    .object(Object.fromEntries(ids.map((id) => [id, value.optional()])) as Record<T[number], z.ZodOptional<V>>)
    .strict()
}

export const ResponsivenessSnapshotSchema = z
  .object({
    latencies: recordOf(LATENCY_METRICS, sampleList),
    counters: recordOf(COUNTER_METRICS, countValue),
    peaks: recordOf(PEAK_METRICS, countValue)
  })
  .strict()

export type ResponsivenessSnapshot = z.infer<typeof ResponsivenessSnapshotSchema>

export function emptySnapshot(): ResponsivenessSnapshot {
  return { latencies: {}, counters: {}, peaks: {} }
}

/** Nearest-rank percentile of a sample; null for an empty one. */
export function nearestRankPercentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]
}

export const VERDICTS = [
  'not_measured',
  'no_budget',
  'insufficient_samples',
  'within_budget',
  'over_budget',
  'not_applicable'
] as const
export type Verdict = (typeof VERDICTS)[number]

const MetricIdSchema = z.enum(METRIC_IDS as unknown as [MetricId, ...MetricId[]])
const nullableNumber = z.number().finite().nullable()

export const ResponsivenessEntrySchema = z
  .object({
    id: MetricIdSchema,
    metricKind: z.enum(['latency', 'counter', 'peak']),
    unit: z.enum(['ms', 'count']),
    label: z.string().max(80),
    wiring: z.enum(['wired', 'slot']),
    owner: z.string().max(8).nullable(),
    status: z.enum(['measured', 'not_measured']),
    count: nullableNumber,
    value: nullableNumber,
    p50Ms: nullableNumber,
    p95Ms: nullableNumber,
    maxMs: nullableNumber,
    budget: BudgetEntrySchema.nullable(),
    verdict: z.enum(VERDICTS),
    measuredFrom: z.string().max(120).nullable(),
    measuredTo: z.string().max(120).nullable()
  })
  .strict()

export type ResponsivenessEntry = z.infer<typeof ResponsivenessEntrySchema>

export const ResponsivenessReportSchema = z
  .object({
    kind: z.literal('metis-responsiveness-report'),
    schema: z.literal(1),
    generatedAt: z.string().max(40),
    host: z.object({ platform: z.string().max(24), arch: z.string().max(24), appVersion: z.string().max(40) }).strict(),
    budgetStatus: z.literal('PROPOSED'),
    minSamples: z.number().int(),
    entries: z.array(ResponsivenessEntrySchema).max(64),
    /** The raw bounded samples and counts: what a restart reloads, and what a packaged run (G90) reads. */
    snapshot: ResponsivenessSnapshotSchema
  })
  .strict()

export type ResponsivenessReport = z.infer<typeof ResponsivenessReportSchema>

export interface ReportContext {
  identity: { platform: string; arch: string; appVersion: string }
  generatedAt: Date
  budgets?: BudgetFile
}

function latencyEntry(id: LatencyMetricId, samples: readonly number[], budgets: BudgetFile): ResponsivenessEntry {
  const def = METRIC_DEFINITIONS[id]
  const budget = budgets.budgets[id]
  const base = {
    id,
    metricKind: 'latency' as const,
    unit: 'ms' as const,
    label: def.label,
    wiring: def.wiring,
    owner: def.owner,
    value: null,
    budget,
    measuredFrom: def.measuredFrom,
    measuredTo: def.measuredTo
  }
  if (samples.length === 0) {
    return {
      ...base,
      status: 'not_measured',
      count: null,
      p50Ms: null,
      p95Ms: null,
      maxMs: null,
      verdict: 'not_measured'
    }
  }
  const p95Ms = nearestRankPercentile(samples, 95)
  let verdict: Verdict
  if (budget.p95Ms === null) verdict = 'no_budget'
  else if (samples.length < budgets.minSamples) verdict = 'insufficient_samples'
  else verdict = (p95Ms ?? 0) <= budget.p95Ms ? 'within_budget' : 'over_budget'
  return {
    ...base,
    status: 'measured',
    count: samples.length,
    p50Ms: nearestRankPercentile(samples, 50),
    p95Ms,
    maxMs: Math.max(...samples),
    verdict
  }
}

function countEntry(id: CounterMetricId | PeakMetricId, value: number | undefined): ResponsivenessEntry {
  const def = METRIC_DEFINITIONS[id]
  const measured = typeof value === 'number' && value > 0
  return {
    id,
    metricKind: def.kind,
    unit: 'count',
    label: def.label,
    wiring: def.wiring,
    owner: def.owner,
    status: measured ? 'measured' : 'not_measured',
    count: null,
    // Zero observed events reads "not measured", never "0": the recorder cannot tell a quiet app from a
    // path that never ran, and a zero would look like a result.
    value: measured ? value : null,
    p50Ms: null,
    p95Ms: null,
    maxMs: null,
    budget: null,
    verdict: measured ? 'not_applicable' : 'not_measured',
    measuredFrom: null,
    measuredTo: null
  }
}

export function buildResponsivenessReport(snapshot: ResponsivenessSnapshot, ctx: ReportContext): ResponsivenessReport {
  const budgets = ctx.budgets ?? RESPONSIVENESS_BUDGETS
  const entries: ResponsivenessEntry[] = [
    ...LATENCY_METRICS.map((id) => latencyEntry(id, snapshot.latencies[id] ?? [], budgets)),
    ...COUNTER_METRICS.map((id) => countEntry(id, snapshot.counters[id])),
    ...PEAK_METRICS.map((id) => countEntry(id, snapshot.peaks[id]))
  ]
  return {
    kind: 'metis-responsiveness-report',
    schema: 1,
    generatedAt: ctx.generatedAt.toISOString(),
    host: { platform: ctx.identity.platform, arch: ctx.identity.arch, appVersion: ctx.identity.appVersion },
    budgetStatus: budgets.status,
    minSamples: budgets.minSamples,
    entries,
    snapshot
  }
}

export interface MetricRowText {
  label: string
  value: string
  budget: string | null
  note: string | null
}

const ms = (value: number | null): string => `${Math.round(value ?? 0)} ms`

/** One row of Settings, as text. The only place a metric becomes words, so "not measured" has one spelling. */
export function describeMetricEntry(
  entry: ResponsivenessEntry,
  minSamples = RESPONSIVENESS_BUDGETS.minSamples
): MetricRowText {
  const note = entry.wiring === 'slot' && entry.owner ? `Not wired yet (${entry.owner})` : null
  if (entry.status === 'not_measured') return { label: entry.label, value: 'not measured', budget: null, note }
  if (entry.metricKind !== 'latency') {
    return { label: entry.label, value: String(entry.value ?? 0), budget: null, note }
  }
  const value = `p50 ${ms(entry.p50Ms)}, p95 ${ms(entry.p95Ms)}, n=${entry.count}`
  const target = entry.budget
  if (!target || target.p95Ms === null) return { label: entry.label, value, budget: 'No target set', note }
  const judged: Record<Verdict, string> = {
    within_budget: 'within',
    over_budget: 'over',
    insufficient_samples: `needs ${minSamples} samples`,
    no_budget: 'no target set',
    not_measured: 'not measured',
    not_applicable: 'not applicable'
  }
  return {
    label: entry.label,
    value,
    budget: `Target p95 ${target.p95Ms} ms (${target.label}): ${judged[entry.verdict]}`,
    note
  }
}
