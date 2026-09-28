import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  SECTION_25_COVERAGE_ROWS,
  buildTraceabilityArtifacts,
  buildTraceabilityReport
} from './build-traceability.mjs'
import { m2_0016Problems } from './m2-0016-lock.mjs'

describe('traceability builder M2-0016 coverage rows', () => {
  it('builds the workflow artifact from Section 25 COV rows in traceability.json', () => {
    const { report, m2_0016Artifacts } = buildTraceabilityArtifacts({
      generatedAt: '2026-09-28T00:00:00Z'
    })
    const coverageRows = report.rows.filter((row) => row.family === 'COV' && row.section === 25)

    expect(coverageRows).toHaveLength(SECTION_25_COVERAGE_ROWS.length)
    expect(coverageRows.at(-1)).toMatchObject({
      id: 'COV-44',
      title: 'End-to-end deployed quality, recovery and durable handoff',
      tickets: ['M2-0183'],
      status: 'NOT_STARTED'
    })
    expect(report.check.problems).toEqual([])
    expect(m2_0016Problems(m2_0016Artifacts)).toEqual([])
    expect(m2_0016Artifacts.coverageMap).toContain(
      '| COV-44 | End-to-end deployed quality, recovery and durable handoff | M2-0183 | NOT_STARTED |'
    )
    expect(m2_0016Artifacts.evidence.coverage).toMatchObject({
      section: 25,
      rows: SECTION_25_COVERAGE_ROWS.length,
      all_rows_have_ticket: true
    })
  })

  it('fails the builder path when Section 25 COV rows are absent', () => {
    const { report, m2_0016Artifacts } = buildTraceabilityArtifacts({
      generatedAt: '2026-09-28T00:00:00Z',
      includeSection25Rows: false
    })

    expect(report.check.problems).toContain('traceability rows: missing Section 25 COV rows')
    expect(m2_0016Problems(m2_0016Artifacts)).toContain(
      'M2-0016 artifact missing Section 25 COV rows from traceability.json'
    )
    expect(m2_0016Artifacts.coverageMap).not.toContain('COV-44')
  })

  it('keeps the workflow on the same traceability builder command', () => {
    const workflow = readFileSync('.github/workflows/m2-0016-prd-lock.yml', 'utf8')
    const report = buildTraceabilityReport({ generatedAt: '2026-09-28T00:00:00Z' })

    expect(workflow).toContain('node scripts/trace/build-traceability.mjs --check --out out/m2-0016-prd-lock')
    expect(report.rows.some((row) => row.family === 'COV' && row.section === 25)).toBe(true)
  })
})
