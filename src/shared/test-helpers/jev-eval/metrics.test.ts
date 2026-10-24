import { describe, expect, it } from 'vitest'
import type { ScenarioResult } from './harness'
import { computeJevMetrics } from './metrics'
import type { DecisionRecord } from './label-schema'

function rec(over: Partial<DecisionRecord>): DecisionRecord {
  return {
    scenarioId: 'JEV-01',
    stepIndex: 0,
    outcome: 'hold',
    reason: 'other',
    classifierCalls: 0,
    generationCalls: 0,
    ...over
  }
}

function result(over: Partial<ScenarioResult>): ScenarioResult {
  return {
    scenarioId: 'JEV-01',
    deciderName: 'd',
    language: 'en',
    meetingType: 'sales',
    verdict: 'pass',
    missing: [],
    owners: [],
    records: [],
    durationMs: 60_000,
    falseInterruptions: 0,
    missed: 0,
    firstUsefulLatenciesMs: [],
    expectFailures: [],
    ...over
  }
}

describe('computeJevMetrics', () => {
  it('computes p50/p95 first-useful-card latency with nearestRankPercentile', () => {
    const m = computeJevMetrics([
      result({ firstUsefulLatenciesMs: [100, 200, 300] }),
      result({ firstUsefulLatenciesMs: [400, 1000] })
    ])
    expect(m.firstUsefulCardLatencyMs).toEqual({ p50: 300, p95: 1000 })
  })

  it('classifier calls per meeting minute uses the scenario duration', () => {
    const m = computeJevMetrics([
      result({ durationMs: 120_000, records: [rec({ classifierCalls: 3 })] }),
      result({ durationMs: 60_000, records: [rec({ classifierCalls: 3 })] })
    ])
    expect(m.meetingMinutes).toBe(3)
    expect(m.classifierCallsPerMinute).toBe(2)
  })

  it('keeps classifier and generator units separate', () => {
    const m = computeJevMetrics([
      result({
        records: [rec({ classifierCalls: 2 }), rec({ outcome: 'generate', generationCalls: 1 })]
      })
    ])
    expect(m.units).toEqual({ classifier: 2, generator: 1 })
  })

  it('counts false interruptions, misses, stale drops, avoided generations and duplicates', () => {
    const m = computeJevMetrics([
      result({
        falseInterruptions: 2,
        missed: 1,
        records: [
          rec({ outcome: 'generate', cardHash: 7, generationCalls: 1 }),
          rec({ outcome: 'generate', cardHash: 7, generationCalls: 1 }),
          rec({ outcome: 'stale-drop' }),
          rec({ outcome: 'suppressed-quiet' }),
          rec({ outcome: 'adopt-speculative', cardHash: 9 })
        ]
      })
    ])
    expect(m.falseInterruptions).toBe(2)
    expect(m.missedHelpful).toBe(1)
    expect(m.staleDrops).toBe(1)
    expect(m.generationCallsAvoided).toBe(3)
    expect(m.duplicateCardRate).toBeCloseTo(1 / 3)
  })

  it('breaks down by language and meeting type', () => {
    const m = computeJevMetrics([
      result({ language: 'fr', meetingType: 'sales', falseInterruptions: 1 }),
      result({ language: 'es', meetingType: 'support', falseInterruptions: 2 })
    ])
    expect(m.byLanguage.fr?.falseInterruptions).toBe(1)
    expect(m.byLanguage.es?.falseInterruptions).toBe(2)
    expect(m.byMeetingType.support?.falseInterruptions).toBe(2)
  })

  it('skips not_run results', () => {
    const m = computeJevMetrics([result({ verdict: 'not_run', falseInterruptions: 5 })])
    expect(m.scenarios).toBe(0)
    expect(m.falseInterruptions).toBe(0)
  })

  it('empty input yields null latencies and rates, not zero', () => {
    const m = computeJevMetrics([])
    expect(m.firstUsefulCardLatencyMs).toEqual({ p50: null, p95: null })
    expect(m.classifierCallsPerMinute).toBeNull()
    expect(m.duplicateCardRate).toBeNull()
  })
})
