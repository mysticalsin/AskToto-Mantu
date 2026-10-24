import { describe, expect, it } from 'vitest'
import {
  COUNTER_METRICS,
  LATENCY_METRICS,
  METRIC_DEFINITIONS,
  METRIC_IDS,
  PEAK_METRICS,
  RESPONSIVENESS_BUDGETS,
  RESPONSIVENESS_IPC,
  ResponsivenessReportSchema,
  buildResponsivenessReport,
  describeMetricEntry,
  emptySnapshot,
  nearestRankPercentile,
  parseBudgetFile,
  type ResponsivenessSnapshot
} from './responsiveness-metrics'

const identity = { platform: 'darwin', arch: 'arm64', appVersion: '0.0.0-test' }
const at = new Date('2026-10-22T00:00:00.000Z')

function entryOf(report: ReturnType<typeof buildResponsivenessReport>, id: string) {
  const entry = report.entries.find((e) => e.id === id)
  if (!entry) throw new Error(`no entry for ${id}`)
  return entry
}

describe('metric catalogue', () => {
  it('defines every metric exactly once, with a kind that matches its list', () => {
    expect(new Set(METRIC_IDS).size).toBe(METRIC_IDS.length)
    expect(Object.keys(METRIC_DEFINITIONS).sort()).toEqual([...METRIC_IDS].sort())
    for (const id of LATENCY_METRICS) expect(METRIC_DEFINITIONS[id].kind).toBe('latency')
    for (const id of COUNTER_METRICS) expect(METRIC_DEFINITIONS[id].kind).toBe('counter')
    for (const id of PEAK_METRICS) expect(METRIC_DEFINITIONS[id].kind).toBe('peak')
  })

  it('covers the six G12 families: first partial, useful suggestion, display receipt, queue health, interventions, cancellation', () => {
    expect(LATENCY_METRICS).toEqual(
      expect.arrayContaining([
        'first_partial_ms',
        'useful_suggestion_ms',
        'display_receipt_ms',
        'ask_cancel_release_ms',
        'queue_wait_ms'
      ])
    )
    expect(PEAK_METRICS).toContain('queue_depth_peak')
    for (const id of [
      'intervention_generated',
      'intervention_eligible',
      'intervention_displayed',
      'intervention_dismissed',
      'intervention_expired',
      'intervention_superseded'
    ] as const) {
      expect(COUNTER_METRICS).toContain(id)
    }
  })

  it('wires only the metrics that have a real event site today; queue health and interventions are typed slots with an owner', () => {
    const wired = METRIC_IDS.filter((id) => METRIC_DEFINITIONS[id].wiring === 'wired').sort()
    expect(wired).toEqual(
      [
        'ask_cancel_release_ms',
        'asks_cancelled',
        'display_receipt_ms',
        'first_partial_ms',
        // G29: the router's decisions and the fast-to-deep handoff, all counts
        'handoff_refused',
        'handoff_started',
        'handoff_superseded',
        // G70: the shadow log records these three; displayed/dismissed/expired stay slots
        'intervention_eligible',
        'intervention_generated',
        'intervention_superseded',
        'router_cloud_first',
        'router_local_first',
        'router_unavailable',
        // G71: card outcomes, counted by main only for a suggestion it marked displayed
        'card_duplicate_retained',
        'card_duplicate_rolled_back',
        'card_review_expired',
        'card_review_superseded',
        'suggestions_displayed',
        'suggestions_shown',
        'useful_suggestion_ms'
      ].sort()
    )
    for (const id of METRIC_IDS) {
      const def = METRIC_DEFINITIONS[id]
      if (def.wiring === 'slot') expect(def.owner, id).toMatch(/^G\d+$/)
      else if (id.startsWith('card_')) expect(def.owner, id).toBe('G71')
      else expect(def.owner, id).toBeNull()
    }
    expect(METRIC_DEFINITIONS.intervention_displayed.owner).toBe('G70')
    expect(METRIC_DEFINITIONS.intervention_dismissed.owner).toBe('G70')
    expect(METRIC_DEFINITIONS.intervention_expired.owner).toBe('G70')
    expect(METRIC_DEFINITIONS.queue_wait_ms.owner).toBe('G14')
  })

  it('the three intervention counters are wired', () => {
    for (const id of ['intervention_eligible', 'intervention_generated', 'intervention_superseded'] as const) {
      expect(METRIC_DEFINITIONS[id].wiring, id).toBe('wired')
    }
  })

  it('names the IPC channels outside the shared IPC table', () => {
    expect(RESPONSIVENESS_IPC).toEqual({
      report: 'metrics:responsiveness',
      displayReceipt: 'metrics:display-receipt',
      cardOutcome: 'metrics:card-outcome',
      interventionShadow: 'metrics:intervention-shadow'
    })
  })
})

describe('budget file', () => {
  it('covers every latency metric and nothing else', () => {
    expect(Object.keys(RESPONSIVENESS_BUDGETS.budgets).sort()).toEqual([...LATENCY_METRICS].sort())
  })

  it('labels every value PROPOSED, and leaves a metric without a spec value UNSET instead of inventing one', () => {
    expect(RESPONSIVENESS_BUDGETS.status).toBe('PROPOSED')
    expect(RESPONSIVENESS_BUDGETS.budgets.first_partial_ms).toMatchObject({ p95Ms: 1000, label: 'PROPOSED' })
    expect(RESPONSIVENESS_BUDGETS.budgets.useful_suggestion_ms).toMatchObject({ p95Ms: 2500, label: 'PROPOSED' })
    for (const id of ['display_receipt_ms', 'ask_cancel_release_ms', 'queue_wait_ms'] as const) {
      expect(RESPONSIVENESS_BUDGETS.budgets[id]).toMatchObject({ p95Ms: null, label: 'UNSET' })
    }
    for (const entry of Object.values(RESPONSIVENESS_BUDGETS.budgets)) {
      expect(entry.basis.length).toBeGreaterThan(10)
      // PROPOSED is only legal with a number, UNSET only without one.
      expect(entry.label === 'PROPOSED').toBe(entry.p95Ms !== null)
    }
  })

  it('rejects a file with a missing metric, an unknown metric, a PROPOSED label without a number, or an extra field', () => {
    const good = JSON.parse(JSON.stringify(RESPONSIVENESS_BUDGETS)) as Record<string, unknown>
    expect(() => parseBudgetFile(good)).not.toThrow()
    const budgets = good.budgets as Record<string, unknown>
    expect(() => parseBudgetFile({ ...good, budgets: { ...budgets, first_partial_ms: undefined } })).toThrow()
    expect(() => parseBudgetFile({ ...good, budgets: { ...budgets, made_up_ms: budgets.first_partial_ms } })).toThrow()
    expect(() =>
      parseBudgetFile({
        ...good,
        budgets: { ...budgets, first_partial_ms: { p95Ms: null, label: 'PROPOSED', basis: 'x'.repeat(20) } }
      })
    ).toThrow()
    expect(() => parseBudgetFile({ ...good, surprise: true })).toThrow()
  })
})

describe('nearestRankPercentile', () => {
  it('returns null for an empty sample and the nearest rank otherwise', () => {
    expect(nearestRankPercentile([], 95)).toBeNull()
    expect(nearestRankPercentile([5], 95)).toBe(5)
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(nearestRankPercentile(hundred, 50)).toBe(50)
    expect(nearestRankPercentile(hundred, 95)).toBe(95)
    expect(nearestRankPercentile([30, 10, 20], 50)).toBe(20)
  })
})

describe('buildResponsivenessReport', () => {
  it('with no measurement reads every metric as not measured, with no number anywhere', () => {
    const report = buildResponsivenessReport(emptySnapshot(), { identity, generatedAt: at })
    expect(report.entries).toHaveLength(METRIC_IDS.length)
    for (const entry of report.entries) {
      expect(entry.status, entry.id).toBe('not_measured')
      expect(entry.verdict, entry.id).toBe('not_measured')
      expect(entry.count, entry.id).toBeNull()
      expect(entry.value, entry.id).toBeNull()
      expect(entry.p50Ms, entry.id).toBeNull()
      expect(entry.p95Ms, entry.id).toBeNull()
      expect(entry.maxMs, entry.id).toBeNull()
      expect(describeMetricEntry(entry).value, entry.id).toBe('not measured')
    }
    expect(ResponsivenessReportSchema.parse(report)).toEqual(report)
  })

  it('names the host and the budget status so a number is never read without its conditions', () => {
    const report = buildResponsivenessReport(emptySnapshot(), { identity, generatedAt: at })
    expect(report).toMatchObject({
      kind: 'metis-responsiveness-report',
      schema: 1,
      generatedAt: '2026-10-22T00:00:00.000Z',
      host: identity,
      budgetStatus: 'PROPOSED'
    })
  })

  it('summarises a latency sample and judges it against the budget only with enough samples', () => {
    const few: ResponsivenessSnapshot = { ...emptySnapshot(), latencies: { first_partial_ms: [400, 600, 900] } }
    const early = entryOf(buildResponsivenessReport(few, { identity, generatedAt: at }), 'first_partial_ms')
    expect(early).toMatchObject({ status: 'measured', count: 3, p50Ms: 600, p95Ms: 900, maxMs: 900 })
    expect(early.verdict).toBe('insufficient_samples')

    const within = Array.from({ length: RESPONSIVENESS_BUDGETS.minSamples }, () => 800)
    const ok = entryOf(
      buildResponsivenessReport(
        { ...emptySnapshot(), latencies: { first_partial_ms: within } },
        { identity, generatedAt: at }
      ),
      'first_partial_ms'
    )
    expect(ok.verdict).toBe('within_budget')
    expect(ok.budget).toMatchObject({ p95Ms: 1000, label: 'PROPOSED' })

    const over = Array.from({ length: RESPONSIVENESS_BUDGETS.minSamples }, () => 1500)
    const slow = entryOf(
      buildResponsivenessReport(
        { ...emptySnapshot(), latencies: { first_partial_ms: over } },
        { identity, generatedAt: at }
      ),
      'first_partial_ms'
    )
    expect(slow.verdict).toBe('over_budget')
  })

  it('reports no_budget for a measured latency whose budget is UNSET', () => {
    const sample = Array.from({ length: 30 }, () => 12)
    const entry = entryOf(
      buildResponsivenessReport(
        { ...emptySnapshot(), latencies: { ask_cancel_release_ms: sample } },
        { identity, generatedAt: at }
      ),
      'ask_cancel_release_ms'
    )
    expect(entry).toMatchObject({ status: 'measured', verdict: 'no_budget', p95Ms: 12 })
  })

  it('reads a counter at zero as not measured, and a counter above zero as its count', () => {
    const report = buildResponsivenessReport(
      {
        ...emptySnapshot(),
        counters: { suggestions_shown: 4, suggestions_displayed: 0 },
        peaks: { queue_depth_peak: 2 }
      },
      { identity, generatedAt: at }
    )
    expect(entryOf(report, 'suggestions_shown')).toMatchObject({
      status: 'measured',
      value: 4,
      verdict: 'not_applicable'
    })
    expect(entryOf(report, 'suggestions_displayed')).toMatchObject({ status: 'not_measured', value: null })
    expect(entryOf(report, 'queue_depth_peak')).toMatchObject({ status: 'measured', value: 2 })
  })

  it('formats rows without inventing a figure', () => {
    const report = buildResponsivenessReport(
      {
        ...emptySnapshot(),
        latencies: { first_partial_ms: Array.from({ length: 25 }, () => 640) },
        counters: { asks_cancelled: 3 }
      },
      { identity, generatedAt: at }
    )
    const partial = describeMetricEntry(entryOf(report, 'first_partial_ms'))
    expect(partial.value).toBe('p50 640 ms, p95 640 ms, n=25')
    expect(partial.budget).toBe('Target p95 1000 ms (PROPOSED): within')
    expect(describeMetricEntry(entryOf(report, 'asks_cancelled')).value).toBe('3')
    expect(describeMetricEntry(entryOf(report, 'intervention_displayed')).note).toBe('Not wired yet (G70)')
  })

  it('carries only ids, numbers and fixed labels: no free text a caller could smuggle content through', () => {
    const report = buildResponsivenessReport(
      { ...emptySnapshot(), latencies: { first_partial_ms: [1, 2, 3] }, counters: { asks_cancelled: 1 } },
      { identity, generatedAt: at }
    )
    const allowedKeys = new Set([
      'kind',
      'schema',
      'generatedAt',
      'host',
      'platform',
      'arch',
      'appVersion',
      'budgetStatus',
      'minSamples',
      'entries',
      'id',
      'metricKind',
      'unit',
      'label',
      'wiring',
      'owner',
      'status',
      'count',
      'value',
      'p50Ms',
      'p95Ms',
      'maxMs',
      'budget',
      'p95Ms',
      'basis',
      'verdict',
      'measuredFrom',
      'measuredTo',
      'snapshot',
      'latencies',
      'counters',
      'peaks',
      ...METRIC_IDS
    ])
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(walk)
      if (value && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) {
          expect(allowedKeys.has(key), `unexpected key ${key}`).toBe(true)
          walk(inner)
        }
      }
    }
    walk(report)
  })

  it('refuses a report that carries an unknown field', () => {
    const report = buildResponsivenessReport(emptySnapshot(), { identity, generatedAt: at })
    expect(() => ResponsivenessReportSchema.parse({ ...report, transcript: 'no' })).toThrow()
  })
})
