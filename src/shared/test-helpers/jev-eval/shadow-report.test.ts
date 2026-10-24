import { describe, expect, it } from 'vitest'
import { type JevDecider, loadScenarios } from './harness'
import { JevShadowReportSchema, buildShadowCohortReport } from './shadow-report'
import { CAPABILITIES } from './label-schema'

const baseline: JevDecider = {
  name: 'baseline',
  capabilities: new Set(),
  reset: () => {},
  onStep: () => []
}
const candidate: JevDecider = {
  name: 'candidate',
  capabilities: new Set(CAPABILITIES),
  reset: () => {},
  onStep: () => []
}

describe('buildShadowCohortReport', () => {
  const scenarios = loadScenarios()
  const report = buildShadowCohortReport(scenarios, [baseline, candidate])

  it('runs baseline and candidate on the same fixtures', () => {
    expect(report.cohort).toBe('synthetic')
    expect(report.deciders.map((d) => d.name)).toEqual(['baseline', 'candidate'])
    const ids = report.deciders.map((d) => d.rows.map((r) => r.scenarioId))
    expect(ids[0]).toEqual(ids[1])
    expect(ids[0]).toHaveLength(12)
  })

  it('names the missing capability and owner on every not_run row', () => {
    const rows = report.deciders[0].rows.filter((r) => r.verdict === 'not_run')
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.missing.length).toBeGreaterThan(0)
      expect(r.owners.length).toBe(r.missing.length)
    }
  })

  it('marks the real cohort BLOCKED_EXTERNAL D-15', () => {
    expect(report.realCohort.status).toBe('BLOCKED_EXTERNAL')
    expect(report.realCohort.decision).toBe('D-15')
  })

  it('serialized report contains no fixture utterance text', () => {
    const json = JSON.stringify(report)
    for (const s of scenarios) {
      for (const st of s.steps) {
        if ('text' in st) expect(json).not.toContain(st.text)
      }
    }
  })

  it('parses against JevShadowReportSchema and rejects extra keys', () => {
    expect(JevShadowReportSchema.safeParse(report).success).toBe(true)
    expect(JevShadowReportSchema.safeParse({ ...report, transcript: 'x' }).success).toBe(false)
  })
})
