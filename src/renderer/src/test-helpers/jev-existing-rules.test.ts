import { DEFAULT_SETTINGS } from '@shared/ipc'
import { loadScenarios, runScenario } from '@shared/test-helpers/jev-eval/harness'
import type { Scenario } from '@shared/test-helpers/jev-eval/label-schema'
import { buildShadowCohortReport } from '@shared/test-helpers/jev-eval/shadow-report'
import { describe, expect, it } from 'vitest'
import { createExistingRulesDecider } from './jev-existing-rules'

function lines(...texts: [text: string, tMs: number, kind?: 'partial'][]): Scenario {
  return {
    schemaVersion: 1,
    id: 'JEV-01',
    title: 't',
    synthetic: true,
    language: 'en',
    meetingType: 'internal',
    requires: [],
    steps: texts.map(([text, tMs, kind], i) =>
      kind === 'partial'
        ? { kind: 'partial' as const, utteranceId: `u${i}`, text, tMs }
        : {
            kind: 'final' as const,
            utteranceId: `u${i}`,
            revision: 1,
            speaker: 'them' as const,
            text,
            lang: 'en' as const,
            tMs
          }
    ),
    labels: [],
    expect: {}
  }
}

const outcomes = (s: Scenario) => runScenario(s, createExistingRulesDecider()).records.map((r) => r.outcome)

describe('existing-rules JEV decider', () => {
  it('uses the real isQuestion: a dangling "What is the" holds, the completed question fires', () => {
    expect(outcomes(lines(['What is the', 1000]))).toEqual(['hold'])
    expect(outcomes(lines(['What is the', 1000], ['price of the plan', 2000]))).toEqual(['hold', 'generate'])
  })

  it('respects the DEFAULT_SETTINGS.suggestEverySec cooldown', () => {
    const gap = DEFAULT_SETTINGS.suggestEverySec * 1000
    const q = 'How does billing work?'
    expect(outcomes(lines([q, 1000], [q, 1000 + gap - 1]))).toEqual(['generate', 'hold'])
    expect(outcomes(lines([q, 1000], [q, 1000 + gap]))).toEqual(['generate', 'generate'])
  })

  it('provisional lines never fire', () => {
    expect(outcomes(lines(['How does billing work?', 1000, 'partial']))).toEqual([])
  })

  it('suppresses under a quiet gate instead of generating', () => {
    const quiet = {
      toast: 'allow',
      sound: 'allow',
      spokenReply: 'allow',
      proactiveSuggestion: 'allow',
      autoAnswerCard: 'drop'
    } as const
    const r = runScenario(lines(['How does billing work?', 1000]), createExistingRulesDecider(), { quiet })
    expect(r.records.map((x) => x.outcome)).toEqual(['suppressed-quiet'])
  })

  it('baseline verdicts equal the recorded expectation', () => {
    const report = buildShadowCohortReport(loadScenarios(), [createExistingRulesDecider()])
    const verdicts = Object.fromEntries(report.deciders[0].rows.map((r) => [r.scenarioId, r.verdict]))
    // JEV-02 fails honestly: the rhetorical question ends in "?" and the shipped rules fire on it.
    // Every other scenario needs a capability the shipped rules do not have (owners: G05/G70, G71, G74).
    expect(verdicts).toEqual({
      'JEV-01': 'pass',
      'JEV-02': 'fail',
      'JEV-03': 'not_run',
      'JEV-04': 'not_run',
      'JEV-05': 'not_run',
      'JEV-06': 'not_run',
      'JEV-07': 'not_run',
      'JEV-08': 'not_run',
      'JEV-09': 'not_run',
      'JEV-10': 'not_run',
      'JEV-11': 'not_run',
      'JEV-12': 'not_run'
    })
    const jev02 = report.deciders[0].rows.find((r) => r.scenarioId === 'JEV-02')
    expect(jev02?.falseInterruptions).toBe(1)
    expect(report.deciders[0].metrics.scenarios).toBe(2)
  })
})
