import { describe, expect, it } from 'vitest'
import {
  M2_0016_COVERAGE_ROWS,
  M2_0016_POLICY_ANSWERS,
  buildM2_0016Artifacts,
  coverageRowsFromTraceability,
  m2_0016Problems
} from './m2-0016-lock.mjs'

describe('M2-0016 PRD lock artifacts', () => {
  it('copies the approved policy answers into the PRD lock evidence', () => {
    const artifacts = buildM2_0016Artifacts({ rows: [] })
    const combined = [artifacts.prdLock, JSON.stringify(artifacts.evidence)].join('\n')

    for (const policy of Object.values(M2_0016_POLICY_ANSWERS)) {
      expect(combined).toContain(policy.answer)
      expect(combined).toContain(policy.text)
    }
    expect(m2_0016Problems(artifacts)).toEqual([])
  })

  it('locks the required PRD scope, release lanes and retention wording', () => {
    const artifacts = buildM2_0016Artifacts({ rows: [] })

    expect(artifacts.prdLock).toContain('| Version | 1.0 |')
    expect(artifacts.prdLock).toContain('Cloudflare-hosted speech through the Operator session broker')
    expect(artifacts.prdLock).toContain('local speech is optional and never a silent fallback')
    expect(artifacts.prdLock).toContain('Authorized usage metadata is retained for administration')
    expect(artifacts.prdLock).toContain('Apple public signing are out of scope')
    expect(artifacts.evidence.gates_other_tickets).toBe(false)
  })

  it('adds TB6 and sidecar ownership boundaries to the threat model', () => {
    const artifacts = buildM2_0016Artifacts({ rows: [] })

    expect(artifacts.threatModel).toContain('| TB6 | Development and test execution to user data |')
    expect(artifacts.threatModel).toContain('## Sidecar Ownership')
    expect(artifacts.evidence.threat_model_additions).toEqual(['TB6', 'sidecar ownership boundaries'])
  })

  it('builds the Section 25 coverage map from traceability rows when supplied', () => {
    const rows = [
      { id: 'COV-01', family: 'COV', title: 'Owner commitment one', tickets: ['M2-0001'], status: 'DONE' },
      { id: 'UC-001', family: 'UC', title: 'Not a coverage row', tickets: ['M2-9999'], status: 'TODO' }
    ]
    const artifacts = buildM2_0016Artifacts({ rows })

    expect(coverageRowsFromTraceability({ rows })).toEqual([
      ['COV-01', 'Owner commitment one', ['M2-0001'], 'DONE']
    ])
    expect(artifacts.coverageMap).toContain('| COV-01 | Owner commitment one | M2-0001 | DONE |')
    expect(artifacts.coverageMap).not.toContain('UC-001')
  })

  it('falls back to the complete Section 25 map in public-safe checkouts', () => {
    const artifacts = buildM2_0016Artifacts({ rows: [] })

    expect(M2_0016_COVERAGE_ROWS).toHaveLength(44)
    expect(artifacts.coverageMap).toContain('| COV-44 | End-to-end deployed quality, recovery and durable handoff | M2-0183 | NOT_STARTED |')
    expect(artifacts.evidence.coverage).toMatchObject({
      section: 25,
      rows: 44,
      all_rows_have_ticket: true
    })
  })

  it('rejects user path and email leaks in generated artifacts', () => {
    const userPath = ['', 'Users', 'example', 'person'].join('/')
    const email = ['someone', 'example.test'].join('@')
    expect(m2_0016Problems({ prdLock: `${userPath} ${email}` })).toContain(
      'M2-0016 artifact contains a user path or email address'
    )
  })
})
