import { nearestRankPercentile } from '../../responsiveness-metrics'
import type { ScenarioResult } from './harness'
import { CARD_OUTCOMES } from './harness'

/** Outcomes where a generation call was avoided (held back, adopted, kept or refused). */
const AVOIDED_GENERATION: ReadonlySet<string> = new Set([
  'adopt-speculative',
  'suppressed-quiet',
  'stale-drop',
  'keep-card',
  'refuse-action'
])

export interface JevMetricsCore {
  scenarios: number
  falseInterruptions: number
  missedHelpful: number
  firstUsefulCardLatencyMs: { p50: number | null; p95: number | null }
  meetingMinutes: number
  classifierCallsPerMinute: number | null
  generationCallsAvoided: number
  duplicateCardRate: number | null
  staleDrops: number
  /** Abstract call units (1 per call); currency needs provider pricing (BLOCKED_EXTERNAL, D-15). */
  units: { classifier: number; generator: number }
}

export interface JevMetrics extends JevMetricsCore {
  byLanguage: Record<string, JevMetricsCore>
  byMeetingType: Record<string, JevMetricsCore>
}

function core(results: readonly ScenarioResult[]): JevMetricsCore {
  const runs = results.filter((r) => r.verdict !== 'not_run')
  const records = runs.flatMap((r) => r.records)
  const minutes = runs.reduce((n, r) => n + r.durationMs, 0) / 60_000
  const classifier = records.reduce((n, r) => n + r.classifierCalls, 0)
  const generator = records.reduce((n, r) => n + r.generationCalls, 0)
  const latencies = runs.flatMap((r) => r.firstUsefulLatenciesMs)

  // Duplicate = a card whose content hash was already shown earlier in the same scenario.
  let cards = 0
  let duplicates = 0
  for (const r of runs) {
    const seen = new Set<number>()
    for (const rec of r.records) {
      if (!CARD_OUTCOMES.has(rec.outcome)) continue
      cards += 1
      if (rec.cardHash === undefined) continue
      if (seen.has(rec.cardHash)) duplicates += 1
      seen.add(rec.cardHash)
    }
  }

  return {
    scenarios: runs.length,
    falseInterruptions: runs.reduce((n, r) => n + r.falseInterruptions, 0),
    missedHelpful: runs.reduce((n, r) => n + r.missed, 0),
    firstUsefulCardLatencyMs: {
      p50: nearestRankPercentile(latencies, 50),
      p95: nearestRankPercentile(latencies, 95)
    },
    meetingMinutes: minutes,
    classifierCallsPerMinute: minutes > 0 ? classifier / minutes : null,
    generationCallsAvoided: records.filter((r) => AVOIDED_GENERATION.has(r.outcome)).length,
    duplicateCardRate: cards > 0 ? duplicates / cards : null,
    staleDrops: records.filter((r) => r.outcome === 'stale-drop').length,
    units: { classifier, generator }
  }
}

function groupBy(results: readonly ScenarioResult[], key: 'language' | 'meetingType') {
  const groups = new Map<string, ScenarioResult[]>()
  for (const r of results) groups.set(r[key], [...(groups.get(r[key]) ?? []), r])
  return Object.fromEntries([...groups].map(([k, v]) => [k, core(v)]))
}

export function computeJevMetrics(results: readonly ScenarioResult[]): JevMetrics {
  return {
    ...core(results),
    byLanguage: groupBy(results, 'language'),
    byMeetingType: groupBy(results, 'meetingType')
  }
}
