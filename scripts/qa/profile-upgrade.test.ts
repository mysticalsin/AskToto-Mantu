import { describe, expect, it } from 'vitest'
import {
  BASELINE,
  CANDIDATE_VERSION,
  REQUIRED_CHECKS,
  assessUpgradeReport,
  verifyCandidateIdentity
} from './profile-upgrade.mjs'

const run = {
  id: 38413517357,
  run_attempt: 1,
  path: '.github/workflows/qa-candidate.yml@refs/heads/main',
  event: 'workflow_dispatch',
  head_branch: 'main',
  head_sha: '85d962bcd00abdf91862187cd16f7dfa863e698c',
  repository: { full_name: 'mysticalsin/AskToto-Mantu' },
  status: 'completed',
  conclusion: 'success'
}
const provenance = {
  schema: 2,
  repository: 'mysticalsin/AskToto-Mantu',
  commit: run.head_sha,
  version: CANDIDATE_VERSION,
  run: { id: run.id, attempt: run.run_attempt, url: 'https://github.com/mysticalsin/AskToto-Mantu/actions/runs/38413517357' },
  builds: [{
    variant: 'win', platform: 'win', version: CANDIDATE_VERSION,
    assets: [{ name: 'Metis-Setup-1.9.7.exe', size: 1234, sha256: 'b'.repeat(64) }]
  }]
}

function completeReport() {
  return {
    schema: 1,
    platform: 'win32',
    baseline: { tag: BASELINE.tag, version: BASELINE.version, sha256: BASELINE.sha256 },
    candidate: { run_id: String(run.id), attempt: 1, commit: run.head_sha, ref: run.head_branch, version: CANDIDATE_VERSION, sha256: 'b'.repeat(64) },
    checks: REQUIRED_CHECKS.map((id) => ({ id, status: 'PASS', evidence: 'verified by synthetic hosted scenario' })),
    error: null
  }
}

describe('hosted in-place Windows profile upgrade acceptance', () => {
  it('pins the exact successful hosted candidate workflow run and Setup bytes', () => {
    expect(verifyCandidateIdentity(run, provenance, run.id, run.head_sha, run.head_branch)).toEqual({
      run_id: String(run.id), attempt: 1, commit: run.head_sha,
      ref: run.head_branch, version: CANDIDATE_VERSION, sha256: 'b'.repeat(64)
    })
    expect(() => verifyCandidateIdentity({ ...run, conclusion: 'failure' }, provenance, run.id, run.head_sha, run.head_branch)).toThrow(/concluded failure/)
    expect(() => verifyCandidateIdentity({ ...run, event: 'pull_request' }, provenance, run.id, run.head_sha, run.head_branch)).toThrow(/workflow_dispatch/)
    expect(() => verifyCandidateIdentity(run, { ...provenance, commit: 'c'.repeat(40) }, run.id, run.head_sha, run.head_branch)).toThrow(/commit differs/)
    expect(() => verifyCandidateIdentity(run, { ...provenance, run: { ...provenance.run, attempt: 2 } }, run.id, run.head_sha, run.head_branch)).toThrow(/provenance run attempt/)
    expect(() => verifyCandidateIdentity({ ...run, head_sha: 'c'.repeat(40) }, provenance, run.id, run.head_sha, run.head_branch)).toThrow(/approved commit/)
    expect(() => verifyCandidateIdentity(run, provenance, run.id, 'c'.repeat(40), run.head_branch)).toThrow(/approved commit/)
    expect(() => verifyCandidateIdentity(run, provenance, run.id, run.head_sha, 'release/1.9.x')).toThrow(/approved ref/)
    expect(() => verifyCandidateIdentity(run, provenance, run.id, undefined, run.head_branch)).toThrow(/explicit approved/)
    expect(() => verifyCandidateIdentity(run, provenance, run.id, run.head_sha, undefined)).toThrow(/explicit approved candidate ref/)
    expect(() => verifyCandidateIdentity(run, { ...provenance, builds: [] }, run.id, run.head_sha, run.head_branch)).toThrow(/no Windows/)
    expect(() => verifyCandidateIdentity(run, {
      ...provenance,
      builds: [{ ...provenance.builds[0], assets: [{ ...provenance.builds[0].assets[0], sha256: 'BAD' }] }]
    }, run.id, run.head_sha, run.head_branch)).toThrow(/exactly one/)
  })

  it('accepts only the complete required report bound to exact installer/run values', () => {
    const report = completeReport()
    expect(assessUpgradeReport(report, { candidateRun: run.id, candidateSha256: 'b'.repeat(64), commit: run.head_sha, ref: run.head_branch, attempt: run.run_attempt })).toEqual({ accepted: true, problems: [] })
    expect(assessUpgradeReport({ ...report, checks: report.checks.slice(1) }).accepted).toBe(false)
    expect(assessUpgradeReport({ ...report, checks: report.checks.map((row, i) => i === 4 ? { ...row, status: 'SKIPPED' } : row) }).accepted).toBe(false)
    expect(assessUpgradeReport({ ...report, checks: [...report.checks, report.checks[0]] }).accepted).toBe(false)
    expect(assessUpgradeReport({ ...report, error: 'installer error' }).accepted).toBe(false)
    expect(assessUpgradeReport({ ...report, baseline: { ...report.baseline, sha256: 'f'.repeat(64) } }, { baselineSha256: BASELINE.sha256 }).accepted).toBe(false)
    expect(assessUpgradeReport(report, { candidateRun: run.id, candidateSha256: 'c'.repeat(64), commit: run.head_sha }).accepted).toBe(false)
    expect(assessUpgradeReport(report, { candidateRun: run.id, candidateSha256: 'b'.repeat(64), commit: run.head_sha, ref: run.head_branch, attempt: 2 }).accepted).toBe(false)
    expect(assessUpgradeReport({ ...report, candidate: { ...report.candidate, ref: 'release/1.9.x' } }, { ref: run.head_branch }).accepted).toBe(false)
  })

  it('requires explicit app-visible saved-note readability for overall acceptance', () => {
    const report = completeReport()
    const note = report.checks.find((row) => row.id === 'note_content_app_visible_after_upgrade')
    if (!note) throw new Error('required note-read row missing')
    note.status = 'BLOCKED'
    note.evidence = 'no saved-note reader is present in the candidate bridge'
    const verdict = assessUpgradeReport(report)
    expect(verdict.accepted).toBe(false)
    expect(verdict.problems.join('\n')).toContain('note_content_app_visible_after_upgrade status is BLOCKED')
  })
})
