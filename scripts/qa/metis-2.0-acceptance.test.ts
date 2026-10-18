import { describe, expect, it } from 'vitest'
import { acceptanceSelectionProblems, candidateBindingProblems } from './metis-2.0-acceptance.mjs'

const SOURCE_SHA = 'a'.repeat(40)
const ARCHIVE_SHA = 'b'.repeat(64)
const MEMBER_SHA = 'c'.repeat(64)
const MANIFEST_SHA = 'd'.repeat(64)
const REPORT_SHA = 'e'.repeat(64)

function selection() {
  return {
    schema: 'metis.acceptance-selection.v1',
    candidate: {
      version: '2.0.0',
      run_id: '123456789',
      attempt: 1,
      source_sha: SOURCE_SHA,
      provenance_artifact_id: '456789',
      provenance_artifact_name: 'candidate-provenance',
      provenance_archive_sha256: ARCHIVE_SHA,
      provenance_member_sha256: MEMBER_SHA,
      payload_manifest_sha256: MANIFEST_SHA
    },
    reports: [
      {
        kind: 'installed-lifecycle',
        run_id: '123456789',
        attempt: 1,
        artifact_id: '789012',
        artifact_sha256: 'f'.repeat(64),
        report_member: 'reports/macos/installed.json',
        report_sha256: REPORT_SHA
      }
    ]
  }
}

function observation() {
  return {
    repository: { full_name: 'mysticalsin/AskToto-Mantu', id: 1282463398 },
    workflow: { path: '.github/workflows/qa-candidate.yml' },
    run: {
      id: 123456789,
      event: 'workflow_dispatch',
      head_branch: 'main',
      status: 'completed',
      conclusion: 'success',
      run_attempt: 1,
      head_sha: SOURCE_SHA
    },
    artifact: {
      id: 456789,
      name: 'candidate-provenance',
      expired: false,
      digest: `sha256:${ARCHIVE_SHA}`,
      workflow_run: { id: 123456789, head_sha: SOURCE_SHA }
    },
    provenance: {
      schema: 2,
      repository: 'mysticalsin/AskToto-Mantu',
      version: '2.0.0',
      commit: SOURCE_SHA,
      run: { id: 123456789, attempt: 1, url: 'https://github.com/mysticalsin/AskToto-Mantu/actions/runs/123456789' },
      builds: [
        ['mac', 'mac', ['Metis-2.0.0.dmg', 'Metis-2.0.0.zip']],
        ['mac-qa-identity', 'mac', ['Metis-QA-2.0.0.zip']],
        ['win', 'win', ['Metis-Setup-2.0.0.exe']],
        ['win-portable', 'win', ['Metis-Portable-2.0.0.exe']]
      ].map(([variant, platform, names]) => ({
        variant,
        platform,
        assets: names.map((name) => ({ name, size: 1, sha256: REPORT_SHA }))
      }))
    },
    provenance_member_sha256: MEMBER_SHA,
    payload_manifest_sha256: MANIFEST_SHA
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

describe('metis-2.0 acceptance selection Stage A', () => {
  it('accepts a closed canonical selection shape without claiming qualification', () => {
    expect(acceptanceSelectionProblems(selection())).toEqual([])
    expect(candidateBindingProblems(selection(), observation())).toEqual([])
  })

  it('is pure and leaves frozen input and observed values unchanged', () => {
    const input = deepFreeze(selection())
    const observed = deepFreeze(observation())
    expect(acceptanceSelectionProblems(input)).toEqual([])
    expect(candidateBindingProblems(input, observed)).toEqual([])
    expect(input).toEqual(selection())
    expect(observed).toEqual(observation())
  })

  it.each([null, undefined, [], 'selection', 2, true])('rejects non-object selection input: %s', (value) => {
    expect(acceptanceSelectionProblems(value)).toContain('SELECTION_SHAPE')
  })

  it.each([
    { authorized: true },
    { verdict: 'PASS' },
    { authorization: 'approved' },
    { selector: { authorized: true } }
  ])('rejects unknown authority-shaped top-level fields: %j', (extra) => {
    expect(acceptanceSelectionProblems({ ...selection(), ...extra })).toContain('SELECTION_KEYS')
  })

  it('rejects missing required envelope and candidate fields', () => {
    const { reports: _reports, ...missingReports } = selection()
    expect(acceptanceSelectionProblems(missingReports)).toContain('SELECTION_KEYS')
    const { provenance_artifact_id: _artifactId, ...missingCandidateField } = selection().candidate
    expect(acceptanceSelectionProblems({ ...selection(), candidate: missingCandidateField })).toContain(
      'SELECTION_CANDIDATE'
    )
  })

  it.each([
    '1.9.7',
    '2.00.0',
    '2.0.00',
    '02.0.0',
    '2.0.0+build.1',
    '2.0.0\nspoof',
    '2.0.0\n',
    '2.0.0\r\n'
  ])('rejects noncanonical or cross-version selection version %s', (version) => {
    expect(acceptanceSelectionProblems({ ...selection(), candidate: { ...selection().candidate, version } })).toContain(
      'SELECTION_VERSION'
    )
  })

  it.each(['2.0.1', '2.0.0-rc.1'])('accepts canonical 2.0 release or prerelease %s', (version) => {
    expect(acceptanceSelectionProblems({ ...selection(), candidate: { ...selection().candidate, version } })).toEqual(
      []
    )
  })

  it('rejects numeric prerelease identifiers with leading zeroes', () => {
    expect(
      acceptanceSelectionProblems({
        ...selection(),
        candidate: { ...selection().candidate, version: '2.0.0-01' }
      })
    ).toContain('SELECTION_VERSION')
  })

  it.each([
    { run_id: 123456789 },
    { run_id: '0123456789' },
    { run_id: '123456789\n' },
    { run_id: 0 },
    { attempt: 2 },
    { attempt: '1' },
    { source_sha: SOURCE_SHA.toUpperCase() },
    { source_sha: 'f'.repeat(39) },
    { source_sha: `${SOURCE_SHA}\r\n` },
    { provenance_artifact_id: 456789 },
    { provenance_artifact_id: '0456789' },
    { provenance_artifact_id: '456789\r\n' },
    { provenance_artifact_id: 0 },
    { provenance_artifact_name: 'other-artifact' },
    { provenance_archive_sha256: 'sha256:' + ARCHIVE_SHA },
    { provenance_archive_sha256: `${ARCHIVE_SHA}\n` },
    { provenance_member_sha256: 'A'.repeat(64) },
    { provenance_member_sha256: `${MEMBER_SHA}\n` },
    { payload_manifest_sha256: null },
    { version: '1.9.7' },
    { extra: 'unknown' }
  ])('rejects invalid candidate fields: %j', (override) => {
    expect(
      acceptanceSelectionProblems({ ...selection(), candidate: { ...selection().candidate, ...override } })
    ).toContain('SELECTION_CANDIDATE')
  })

  it('rejects selection JSON larger than the fixed size cap', () => {
    expect(acceptanceSelectionProblems({ ...selection(), extra: 'x'.repeat(33 * 1024) }).sort()).toEqual([
      'SELECTION_KEYS',
      'SELECTION_TOO_LARGE'
    ])
  })

  it('accepts 64 unique bounded reports and rejects empty or excessive report arrays', () => {
    const reports = Array.from({ length: 64 }, (_, index) => ({
      kind: 'installed-lifecycle',
      run_id: '123456789',
      attempt: 1,
      artifact_id: String(789012 + index),
      artifact_sha256: 'f'.repeat(64),
      report_member: `reports/macos/item-${index}.json`,
      report_sha256: REPORT_SHA
    }))
    expect(acceptanceSelectionProblems({ ...selection(), reports })).toEqual([])
    expect(acceptanceSelectionProblems({ ...selection(), reports: [] })).toContain('SELECTION_REPORTS')
    expect(acceptanceSelectionProblems({ ...selection(), reports: [...reports, reports[0]] })).toContain(
      'SELECTION_REPORTS'
    )
  })

  it.each([
    '../escape.json',
    'reports/../escape.json',
    '/reports/evidence.json',
    'C:/reports/evidence.json',
    'reports\\evidence.json',
    'https://example.invalid/report.json',
    'reports/%2e%2e/escape.json',
    'reports//empty-segment.json',
    'reports/./dot.json',
    'reports/../dotdot.json',
    'reports/trailing/',
    'reports/control\u0000.json',
    'reports/file.json\n',
    'reports/file.json\r\n',
    'x'.repeat(241),
    'reports/no-extension'
  ])('rejects unsafe report locator %j', (locator) => {
    expect(
      acceptanceSelectionProblems({ ...selection(), reports: [{ ...selection().reports[0], report_member: locator }] })
    ).toContain('SELECTION_REPORT')
  })

  it('rejects malformed kind/hash and extra report keys', () => {
    const base = selection().reports[0]
    expect(acceptanceSelectionProblems({ ...selection(), reports: [{ ...base, kind: 'PASS' }] })).toContain(
      'SELECTION_REPORT'
    )
    expect(acceptanceSelectionProblems({ ...selection(), reports: [{ ...base, report_sha256: 'bad' }] })).toContain(
      'SELECTION_REPORT'
    )
    expect(acceptanceSelectionProblems({ ...selection(), reports: [{ ...base, result: 'PASS' }] })).toContain(
      'SELECTION_REPORT'
    )
  })

  it('rejects missing report keys and noncanonical report IDs', () => {
    const base = selection().reports[0]
    const { artifact_sha256: _artifactSha, ...missing } = base
    expect(acceptanceSelectionProblems({ ...selection(), reports: [missing] })).toContain('SELECTION_REPORT')
    expect(acceptanceSelectionProblems({ ...selection(), reports: [{ ...base, run_id: 123456789 }] })).toContain(
      'SELECTION_REPORT'
    )
    expect(acceptanceSelectionProblems({ ...selection(), reports: [{ ...base, run_id: '123456789\n' }] })).toContain(
      'SELECTION_REPORT'
    )
    expect(acceptanceSelectionProblems({ ...selection(), reports: [{ ...base, run_id: '0' }] })).toContain(
      'SELECTION_REPORT'
    )
    expect(acceptanceSelectionProblems({ ...selection(), reports: [{ ...base, artifact_id: 789012 }] })).toContain(
      'SELECTION_REPORT'
    )
    expect(acceptanceSelectionProblems({ ...selection(), reports: [{ ...base, artifact_id: '0' }] })).toContain(
      'SELECTION_REPORT'
    )
    expect(
      acceptanceSelectionProblems({ ...selection(), reports: [{ ...base, report_sha256: `${REPORT_SHA}\r\n` }] })
    ).toContain('SELECTION_REPORT')
  })

  it('rejects duplicate report identity even when kind and hashes differ', () => {
    const first = selection().reports[0]
    const second = {
      ...first,
      kind: 'rollback',
      artifact_sha256: 'a'.repeat(64),
      report_sha256: 'f'.repeat(64)
    }
    expect(acceptanceSelectionProblems({ ...selection(), reports: [first, second] })).toContain(
      'SELECTION_DUPLICATE_REPORT'
    )
  })

  it('returns only bounded problem codes and validates malformed observed input independently', () => {
    const problems = candidateBindingProblems(selection(), { authorized: true, result: 'PASS' })
    expect(problems).toContain('OBSERVED_SHAPE')
    expect(problems.every((problem) => /^[A-Z_]+$/.test(problem))).toBe(true)
  })

  it.each([
    ['repository', (value: ReturnType<typeof observation>) => (value.repository.id = 1), 'OBSERVED_REPOSITORY'],
    ['workflow', (value: ReturnType<typeof observation>) => (value.workflow.path = 'other.yml'), 'OBSERVED_WORKFLOW'],
    ['event', (value: ReturnType<typeof observation>) => (value.run.event = 'push'), 'OBSERVED_RUN'],
    ['branch', (value: ReturnType<typeof observation>) => (value.run.head_branch = 'release'), 'OBSERVED_RUN'],
    ['status', (value: ReturnType<typeof observation>) => (value.run.status = 'queued'), 'OBSERVED_RUN'],
    ['conclusion', (value: ReturnType<typeof observation>) => (value.run.conclusion = 'failure'), 'OBSERVED_RUN'],
    ['attempt', (value: ReturnType<typeof observation>) => (value.run.run_attempt = 2), 'OBSERVED_RUN'],
    ['source', (value: ReturnType<typeof observation>) => (value.run.head_sha = 'f'.repeat(40)), 'OBSERVED_RUN'],
    ['artifact id', (value: ReturnType<typeof observation>) => (value.artifact.id = '1'), 'OBSERVED_ARTIFACT'],
    ['artifact name', (value: ReturnType<typeof observation>) => (value.artifact.name = 'other'), 'OBSERVED_ARTIFACT'],
    [
      'expired artifact',
      (value: ReturnType<typeof observation>) => (value.artifact.expired = true),
      'OBSERVED_ARTIFACT'
    ],
    [
      'artifact digest',
      (value: ReturnType<typeof observation>) => (value.artifact.digest = 'bad'),
      'OBSERVED_ARTIFACT'
    ],
    [
      'artifact run',
      (value: ReturnType<typeof observation>) => (value.artifact.workflow_run.id = '1'),
      'OBSERVED_ARTIFACT'
    ],
    [
      'artifact workflow source',
      (value: ReturnType<typeof observation>) => (value.artifact.workflow_run.head_sha = 'f'.repeat(40)),
      'OBSERVED_ARTIFACT'
    ],
    [
      'provenance schema',
      (value: ReturnType<typeof observation>) => (value.provenance.schema = 1),
      'OBSERVED_PROVENANCE'
    ],
    [
      'provenance version',
      (value: ReturnType<typeof observation>) => (value.provenance.version = '1.9.7'),
      'OBSERVED_PROVENANCE'
    ],
    [
      'provenance repository',
      (value: ReturnType<typeof observation>) => (value.provenance.repository = 'other/repository'),
      'OBSERVED_PROVENANCE'
    ],
    [
      'provenance asset digest with newline',
      (value: ReturnType<typeof observation>) => (value.provenance.builds[0].assets[0].sha256 = `${REPORT_SHA}\n`),
      'OBSERVED_PROVENANCE'
    ],
    [
      'provenance asset digest array',
      (value: ReturnType<typeof observation>) =>
        (value.provenance.builds[0].assets[0].sha256 = [REPORT_SHA] as unknown as string),
      'OBSERVED_PROVENANCE'
    ],
    ['provenance run', (value: ReturnType<typeof observation>) => (value.provenance.run.id = 1), 'OBSERVED_PROVENANCE'],
    [
      'provenance attempt',
      (value: ReturnType<typeof observation>) => (value.provenance.run.attempt = 2),
      'OBSERVED_PROVENANCE'
    ],
    [
      'provenance source',
      (value: ReturnType<typeof observation>) => (value.provenance.commit = 'f'.repeat(40)),
      'OBSERVED_PROVENANCE'
    ],
    [
      'member hash',
      (value: ReturnType<typeof observation>) => (value.provenance_member_sha256 = 'f'.repeat(64)),
      'OBSERVED_PROVENANCE_BYTES'
    ],
    [
      'manifest hash',
      (value: ReturnType<typeof observation>) => (value.payload_manifest_sha256 = 'f'.repeat(64)),
      'OBSERVED_PAYLOAD_MANIFEST'
    ]
  ])('reports a bounded mismatch for observed %s', (_label, mutate, code) => {
    const observed = observation()
    mutate(observed)
    expect(candidateBindingProblems(selection(), observed)).toContain(code)
  })

  it('does not coerce candidate or observation ids and rejects unknown observed fields', () => {
    const invalidSelection = selection()
    invalidSelection.candidate.run_id = 123456789 as unknown as string
    expect(acceptanceSelectionProblems(invalidSelection)).toContain('SELECTION_CANDIDATE')

    const invalidObservation = observation()
    invalidObservation.run.id = '123456789' as unknown as number
    expect(candidateBindingProblems(selection(), invalidObservation)).toContain('OBSERVED_RUN')
    expect(candidateBindingProblems(selection(), { ...observation(), authorized: true })).toContain('OBSERVED_SHAPE')
  })
})
