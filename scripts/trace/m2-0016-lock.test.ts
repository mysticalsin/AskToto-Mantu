import { describe, expect, it } from 'vitest'
import {
  M2_0016_POLICY_ANSWERS,
  buildM2_0016Artifacts,
  coverageRowsFromTraceability,
  m2_0016Problems
} from './m2-0016-lock.mjs'

const coverageRows = [
  { id: 'COV-01', family: 'COV', section: 25, title: 'Owner commitment one', tickets: ['M2-0001'], status: 'DONE' },
  { id: 'COV-44', family: 'COV', section: 25, title: 'Owner commitment forty-four', tickets: ['M2-0044'], status: 'NOT_STARTED' },
  { id: 'UC-001', family: 'UC', section: 25, title: 'Not a coverage row', tickets: ['M2-9999'], status: 'TODO' },
  { id: 'COV-99', family: 'COV', section: 24, title: 'Wrong section', tickets: ['M2-0099'], status: 'TODO' }
]

describe('M2-0016 PRD lock artifacts', () => {
  it('copies the approved policy answers into the PRD lock evidence', () => {
    const artifacts = buildM2_0016Artifacts({ rows: coverageRows })
    const combined = [artifacts.prdLock, JSON.stringify(artifacts.evidence)].join('\n')

    for (const policy of Object.values(M2_0016_POLICY_ANSWERS)) {
      expect(combined).toContain(policy.answer)
      expect(combined).toContain(policy.text)
    }
    expect(m2_0016Problems(artifacts)).toEqual([])
  })

  it('locks the required PRD scope, release lanes and retention wording', () => {
    const artifacts = buildM2_0016Artifacts({ rows: coverageRows })

    expect(artifacts.prdLock).toContain('| Version | 1.0 |')
    expect(artifacts.prdLock).toContain('Cloudflare-hosted speech through the Operator session broker')
    expect(artifacts.prdLock).toContain('local speech is optional and never a silent fallback')
    expect(artifacts.prdLock).toContain('Authorized usage metadata is retained for administration')
    expect(artifacts.prdLock).toContain('Apple public signing are out of scope')
    expect(artifacts.evidence.gates_other_tickets).toBe(false)
  })

  it('adds TB6 and sidecar ownership boundaries to the threat model', () => {
    const artifacts = buildM2_0016Artifacts({ rows: coverageRows })

    expect(artifacts.threatModel).toContain('| TB6 | Development and test execution to user data |')
    expect(artifacts.threatModel).toContain('## Sidecar Ownership')
    expect(artifacts.evidence.threat_model_additions).toEqual(['TB6', 'sidecar ownership boundaries'])
  })

  it('builds the Section 25 coverage map from traceability COV rows only', () => {
    const artifacts = buildM2_0016Artifacts({ rows: coverageRows })

    expect(coverageRowsFromTraceability({ rows: coverageRows })).toEqual([
      ['COV-01', 'Owner commitment one', ['M2-0001'], 'DONE'],
      ['COV-44', 'Owner commitment forty-four', ['M2-0044'], 'NOT_STARTED']
    ])
    expect(artifacts.coverageMap).toContain('| COV-01 | Owner commitment one | M2-0001 | DONE |')
    expect(artifacts.coverageMap).toContain('| COV-44 | Owner commitment forty-four | M2-0044 | NOT_STARTED |')
    expect(artifacts.coverageMap).not.toContain('UC-001')
    expect(artifacts.coverageMap).not.toContain('COV-99')
  })

  it('fails closed when traceability has no Section 25 COV rows', () => {
    const artifacts = buildM2_0016Artifacts({ rows: [] })

    expect(artifacts.coverageMap).not.toContain('COV-44')
    expect(artifacts.evidence.coverage).toMatchObject({
      section: 25,
      rows: 0,
      all_rows_have_ticket: true
    })
    expect(m2_0016Problems(artifacts)).toContain('M2-0016 artifact missing Section 25 COV rows from traceability.json')
  })

  it('rejects user path and email leaks in generated artifacts', () => {
    const userPath = ['', 'Users', 'example', 'person'].join('/')
    const email = ['someone', 'example.test'].join('@')
    expect(m2_0016Problems({ prdLock: `${userPath} ${email}` })).toContain(
      'M2-0016 artifact contains a user path or email address'
    )
  })
})
