import { loadScenarios, runScenario, type ScenarioResult } from '@shared/test-helpers/jev-eval/harness'
import type { Scenario, ScenarioId } from '@shared/test-helpers/jev-eval/label-schema'
import { describe, expect, it } from 'vitest'
import { createPolicyDeciderFor } from './jev-policy-decider'

const scenarios = loadScenarios()
const byId = (id: ScenarioId): Scenario => scenarios.find((s) => s.id === id) as Scenario
const run = (id: ScenarioId): ScenarioResult => {
  const scenario = byId(id)
  return runScenario(scenario, createPolicyDeciderFor(scenario))
}

describe('JEV policy decider (G70)', () => {
  it('JEV-04, JEV-05 and JEV-08 pass with the policy decider', () => {
    for (const id of ['JEV-04', 'JEV-05', 'JEV-08'] as const) {
      const r = run(id)
      expect({ id, verdict: r.verdict, failures: r.expectFailures }).toEqual({ id, verdict: 'pass', failures: [] })
    }
  })

  it('JEV-04 drops the corrected and the retracted utterance as stale', () => {
    const dropped = run('JEV-04')
      .records.filter((r) => r.outcome === 'stale-drop')
      .map((r) => r.utteranceId)
    expect(dropped).toEqual(['u1', 'u2'])
  })

  it('JEV-05 never resurfaces the older card and ends on the tree card', () => {
    const r = run('JEV-05')
    const cards = r.records.filter((x) => x.cardKey && x.outcome !== 'stale-drop').map((x) => x.cardKey)
    expect(cards).toEqual(['card-tree'])
  })

  it('JEV-08 rejects every prior-scope candidate', () => {
    const r = run('JEV-08')
    expect(r.records.filter((x) => x.outcome === 'stale-drop')).toHaveLength(5)
    expect(r.records.some((x) => ['generate', 'adopt-speculative', 'replace-card'].includes(x.outcome))).toBe(false)
  })

  it('JEV-01 passes', () => {
    expect(run('JEV-01').verdict).toBe('pass')
  })

  it('JEV-02 fails as with existing rules: the policy does not add a classifier', () => {
    const r = run('JEV-02')
    expect(r.verdict).toBe('fail')
    expect(r.falseInterruptions).toBe(1)
  })

  it('JEV-03 is not_run and names G74', () => {
    const r = run('JEV-03')
    expect(r.verdict).toBe('not_run')
    expect(r.owners).toContain('G74')
  })

  it('every other scenario is not_run with a named owner, never faked as a pass', () => {
    for (const id of ['JEV-06', 'JEV-07', 'JEV-09', 'JEV-10', 'JEV-11', 'JEV-12'] as const) {
      const r = run(id)
      expect(r.verdict, id).toBe('not_run')
      expect(r.owners.length, id).toBeGreaterThan(0)
    }
  })

  it('records carry ids and counters, never utterance or card text', () => {
    const text = JSON.stringify(run('JEV-05').records)
    expect(text).not.toContain('Threads share')
    expect(text).not.toContain('threads share memory')
  })
})
