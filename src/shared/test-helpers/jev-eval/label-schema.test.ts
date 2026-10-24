import { describe, expect, it } from 'vitest'
import { loadScenarios } from './harness'
import { DecisionRecordSchema, ScenarioSchema } from './label-schema'

describe('JEV label schema', () => {
  const scenarios = loadScenarios()

  it('accepts every JEV fixture', () => {
    expect(scenarios.map((s) => s.id)).toEqual(
      Array.from({ length: 12 }, (_, i) => `JEV-${String(i + 1).padStart(2, '0')}`)
    )
    for (const s of scenarios) expect(ScenarioSchema.safeParse(s).success).toBe(true)
  })

  it('rejects an unknown key', () => {
    expect(ScenarioSchema.safeParse({ ...scenarios[0], surprise: 1 }).success).toBe(false)
    const step = { ...scenarios[0].steps[1], extra: true }
    expect(ScenarioSchema.safeParse({ ...scenarios[0], steps: [step] }).success).toBe(false)
  })

  it('rejects synthetic:false', () => {
    expect(ScenarioSchema.safeParse({ ...scenarios[0], synthetic: false }).success).toBe(false)
  })

  it('rejects a text field on DecisionRecord', () => {
    const ok = {
      scenarioId: 'JEV-01',
      stepIndex: 0,
      outcome: 'hold',
      reason: 'cooldown',
      classifierCalls: 0,
      generationCalls: 0
    }
    expect(DecisionRecordSchema.safeParse(ok).success).toBe(true)
    for (const key of ['text', 'cardText', 'transcript', 'answer']) {
      expect(DecisionRecordSchema.safeParse({ ...ok, [key]: 'x' }).success).toBe(false)
    }
  })

  it('covers en, fr, pt-BR and es at least twice each, with a code-switch', () => {
    for (const lang of ['en', 'fr', 'pt-BR', 'es']) {
      expect(scenarios.filter((s) => s.language === lang).length).toBeGreaterThanOrEqual(2)
    }
    const switched = scenarios.filter(
      (s) => new Set(s.steps.flatMap((st) => (st.kind === 'final' ? [st.lang] : []))).size > 1
    )
    expect(switched.length).toBeGreaterThanOrEqual(1)
  })
})
