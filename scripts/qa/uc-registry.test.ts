import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  EXPECTED_IDS,
  regressionReport,
  registryMappingProblems,
  registryShapeProblems,
  registryTestFiles,
  resultProblems,
  resultsFromVitest
} from './uc-registry.mjs'

const shipped = JSON.parse(readFileSync(join(__dirname, 'uc-registry.json'), 'utf8'))

const mapped = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  tickets: ['M2-0441'],
  tests: [{ id: `t-${id}`, file: 'scripts/qa/x.test.mjs' }],
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
    const registry = fullRegistry({ 'UC-007': { tests: [], tickets: [], evidence: null, note: 'LEAD_ACTION: map from the tracker' } })
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

  it('refuses an unmapped row that carries no LEAD_ACTION note', () => {
    const bare = fullRegistry({ 'UC-007': { tests: [], tickets: [], evidence: null } })
    expect(registryShapeProblems(bare)).toEqual(['UC-007: an unmapped row needs a "LEAD_ACTION: <exact step>" note'])
    expect(regressionReport(bare, []).ok).toBe(false)
    const vague = fullRegistry({ 'UC-007': { tests: [], tickets: [], evidence: null, note: 'todo' } })
    expect(registryShapeProblems(vague)).toHaveLength(1)
  })

  it('derives per-row results from a vitest report, keyed by test id and file', () => {
    const registry = fullRegistry()
    const report = {
      testResults: [
        {
          name: '/work/repo/scripts/qa/x.test.mjs',
          assertionResults: [
            { fullName: 't-UC-001', status: 'passed' },
            { fullName: 't-UC-002', status: 'failed' },
            { fullName: 't-UC-003', status: 'skipped' }
          ]
        }
      ]
    }
    const results = resultsFromVitest(registry, report)
    expect(results).toEqual([
      { uc: 'UC-001', testId: 't-UC-001', status: 'pass' },
      { uc: 'UC-002', testId: 't-UC-002', status: 'fail' },
      { uc: 'UC-003', testId: 't-UC-003', status: 'fail' }
    ])
    const rows = regressionReport(registry, results)
    expect(statusOf(rows, 'UC-001')).toBe('PASS')
    expect(statusOf(rows, 'UC-002')).toBe('FAIL')
    expect(statusOf(rows, 'UC-004')).toBe('NOT_RUN')
    expect(resultsFromVitest(registry, { testResults: [{ name: '/w/other/x.test.mjs', assertionResults: [{ fullName: 't-UC-001', status: 'passed' }] }] })).toEqual([])
  })

  it('lists each test file the registry names once, sorted', () => {
    const registry = fullRegistry({ 'UC-002': { tests: [{ id: 'a', file: 'scripts/qa/a.test.mjs' }] } })
    expect(registryTestFiles(registry)).toEqual(['scripts/qa/a.test.mjs','scripts/qa/x.test.mjs'])
  })

  it('exits non-zero when --results names a file that does not exist', () => {
    const run = spawnSync(process.execPath, [join(__dirname, 'uc-registry.mjs'), '--results', join(tmpdir(), 'uc-missing-results.json'), '--out', mkdtempSync(join(tmpdir(), 'uc-'))], { encoding: 'utf8' })
    expect(run.status).toBe(2)
    expect(run.stderr).toMatch(/results file not found/)
  })

  it('explains every shipped unmapped row with a LEAD_ACTION note', () => {
    for (const row of shipped.rows) {
      if (row.tests.length === 0) expect(row.note).toMatch(/^LEAD_ACTION: \S/)
    }
  })

  it('fails the shipped, still-unmapped registry rather than passing it', () => {
    const report = regressionReport(shipped, [])
    expect(report.rows.every((r: { status: string }) => r.status === 'UNMAPPED')).toBe(true)
    expect(report.ok).toBe(false)
  })
})
