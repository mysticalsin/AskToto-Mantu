import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EXPECTED_IDS, regressionReport, registryMappingProblems, registryShapeProblems, resultProblems } from './uc-registry.mjs'

const shipped = JSON.parse(readFileSync(join(__dirname, 'uc-registry.json'), 'utf8'))

const mapped = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  tickets: ['M2-0441'],
  tests: [{ id: `t-${id}`, file: 'scripts/qa/x.test.ts' }],
  evidence: 'LOCALLY_TESTED',
  externalBlocker: null,
  ...over
})
const fullRegistry = (over: Record<string, Record<string, unknown>> = {}) => ({
  schema: 1,
  rows: EXPECTED_IDS.map((id) => mapped(id, over[id]))
})
const passAll = (registry: { rows: { id: string; tests: { id: string }[] }[] }) =>
  registry.rows.flatMap((row) => row.tests.map((t) => ({ uc: row.id, testId: t.id, status: 'pass' })))
const statusOf = (report: { rows: { id: string; status: string }[] }, id: string) => report.rows.find((r) => r.id === id)?.status

describe('UC acceptance registry (M2-0441)', () => {
  it('ships exactly one well-formed row per UC-001..UC-112', () => {
    expect(shipped.rows).toHaveLength(112)
    expect(shipped.rows.map((r: { id: string }) => r.id)).toEqual(EXPECTED_IDS)
    expect(registryShapeProblems(shipped)).toEqual([])
  })

  it('rejects a missing, duplicate or range row', () => {
    const rows = shipped.rows.slice(1)
    expect(registryShapeProblems({ rows })).toContain('UC-001: missing row')
    expect(registryShapeProblems({ rows: [...shipped.rows, shipped.rows[0]] })).toContain('UC-001: duplicate row')
    expect(registryShapeProblems({ rows: [...rows, { ...mapped('UC-001'), id: 'UC-001..UC-010' }] }).join('\n')).toMatch(/ranges are not rows/)
  })

  it('fails a row that has no test, ticket or evidence level', () => {
    const registry = fullRegistry({ 'UC-007': { tests: [], tickets: [], evidence: null } })
    expect(registryMappingProblems(registry)).toEqual(['UC-007: no test', 'UC-007: no owning ticket', 'UC-007: no evidence level'])
    const report = regressionReport(registry, passAll(registry))
    expect(statusOf(report, 'UC-007')).toBe('UNMAPPED')
    expect(report.ok).toBe(false)
  })

  it("refuses a range result and a result on another row's test", () => {
    const registry = fullRegistry()
    expect(resultProblems(registry, [{ uc: 'UC-001..UC-010', testId: 't-UC-001', status: 'pass' }]).join('\n')).toMatch(/range cannot be marked passed/)
    expect(resultProblems(registry, [{ uc: 'UC-002', testId: 't-UC-001', status: 'pass' }]).join('\n')).toMatch(/not one of the row's tests/)
    expect(regressionReport(registry, [{ uc: 'UC-001..UC-112', testId: 't-UC-001', status: 'pass' }]).ok).toBe(false)
  })

  it('does not let one representative pass its neighbours', () => {
    const report = regressionReport(fullRegistry(), [{ uc: 'UC-001', testId: 't-UC-001', status: 'pass' }])
    expect(report.rows).toHaveLength(112)
    expect(statusOf(report, 'UC-001')).toBe('PASS')
    expect(statusOf(report, 'UC-002')).toBe('NOT_RUN')
    expect(report.ok).toBe(false)
  })

  it('reports every row and passes only when all rows pass or are BLOCKED_EXTERNAL', () => {
    const registry = fullRegistry({ 'UC-050': { externalBlocker: 'needs a physical QA machine', tests: [] } })
    const results = passAll(registry)
    const report = regressionReport(registry, results)
    expect(report.rows).toHaveLength(112)
    expect(statusOf(report, 'UC-050')).toBe('BLOCKED_EXTERNAL')
    expect(report.ok).toBe(true)
    const failing = regressionReport(registry, [...results.slice(1), { ...results[0], status: 'fail' }])
    expect(statusOf(failing, 'UC-001')).toBe('FAIL')
    expect(failing.ok).toBe(false)
  })

  it('fails the shipped, still-unmapped registry rather than passing it', () => {
    const report = regressionReport(shipped, [])
    expect(report.rows.every((r: { status: string }) => r.status === 'UNMAPPED')).toBe(true)
    expect(report.ok).toBe(false)
  })
})
