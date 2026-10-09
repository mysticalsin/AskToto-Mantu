import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ASSERTION_IDS, NOT_COVERED, createFreshOnboardingReport } from './fresh-onboarding-baseline.mjs'
import {
  PIN,
  closedReadbackFailure,
  loadPinnedEvidence,
  readArchive,
  verifyArtifact,
  verifyJob,
  verifyReport,
  verifyRun
} from './candidate-report-readback.mjs'

const secret = 'SYNTHETIC_PRIVATE_VALUE_must_never_be_logged'
const hostedCi = process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true'
const expectedIdentity = {
  candidate_run: PIN.candidateRun,
  producer_commit: PIN.producerCommit,
  installer_sha256: PIN.installerSha,
  version: '1.9.7',
  harness_commit: PIN.head,
  platform: 'win32' as const
}
const report = () =>
  createFreshOnboardingReport({
    outcome: 'FAIL',
    identity: expectedIdentity,
    assertions: ASSERTION_IDS.map((id, index) => ({
      id,
      status: index === ASSERTION_IDS.length - 1 ? 'PASS' : 'NOT_RUN'
    })),
    failure: 'cdp-endpoint-deadline',
    teardown: 'ACKNOWLEDGED',
    cdp_diagnostic: 'NOT_OBSERVED'
  })
const lane = () => ({
  schema: 'metis.fresh-onboarding-lane.v1',
  scenario: 'fresh-onboarding-baseline',
  support_only: true,
  identity: expectedIdentity,
  ci_run_id: PIN.run,
  exit_code: 1,
  outcome: 'FAIL',
  report: 'fresh-onboarding-baseline.json',
  detail: 'scenario-failed',
  not_covered: NOT_COVERED
})
const run = () => ({
  id: PIN.run,
  path: '.github/workflows/candidate-scenarios.yml',
  event: 'workflow_dispatch',
  head_branch: 'main',
  head_sha: PIN.head,
  run_attempt: 1,
  status: 'completed',
  conclusion: 'failure',
  repository: { id: 1282463398, full_name: 'mysticalsin/AskToto-Mantu' },
  head_repository: { id: 1282463398, full_name: 'mysticalsin/AskToto-Mantu' }
})
const job = () => ({
  id: PIN.job,
  name: 'fresh-onboarding-baseline (Windows)',
  run_id: PIN.run,
  head_sha: PIN.head,
  status: 'completed',
  conclusion: 'failure',
  steps: [
    { name: 'Install the Setup silently into a fresh directory', conclusion: 'success' },
    { name: 'Run the scenario', conclusion: 'success' },
    { name: 'Content-free gate', conclusion: 'success' },
    { name: 'Upload only validated fresh-onboarding JSON', conclusion: 'success' },
    { name: 'Fail unless the scenario passed and every file was content-free', conclusion: 'failure' }
  ]
})
const artifact = () => ({
  id: PIN.artifact.id,
  name: PIN.artifact.name,
  size_in_bytes: PIN.artifact.size,
  digest: `sha256:${PIN.artifact.sha}`,
  expired: false,
  workflow_run: {
    id: PIN.run,
    repository_id: 1282463398,
    head_repository_id: 1282463398,
    head_sha: PIN.head
  }
})

function storedZip(entries: { name: string; body: string; mode?: number }[], badCrc = false) {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const { name, body, mode = 0o100600 } of entries) {
    const filename = Buffer.from(name)
    const bytes = Buffer.from(body)
    let crc = 0xffffffff
    for (const byte of bytes) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    crc = ((crc ^ 0xffffffff) + (badCrc ? 1 : 0)) >>> 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(33, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(bytes.length, 18)
    local.writeUInt32LE(bytes.length, 22)
    local.writeUInt16LE(filename.length, 26)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50)
    entry.writeUInt16LE(0x0314, 4)
    local.copy(entry, 6, 4, 28)
    entry.writeUInt32LE((mode << 16) >>> 0, 38)
    entry.writeUInt32LE(offset, 42)
    locals.push(local, filename, bytes)
    central.push(entry, filename)
    offset += local.length + filename.length + bytes.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

// Negative fixtures intentionally contain invalid report/lane shapes. Serialize unknown input here;
// the production reader must reject those bytes through its own closed schemas.
const entries = (r: unknown = report(), l: unknown = lane()) => [
  { name: 'fresh-onboarding-baseline.json', body: JSON.stringify(r) ?? 'null' },
  { name: 'lane.json', body: JSON.stringify(l) ?? 'null' }
]
const archivePin = (bytes: Buffer) => ({
  size: bytes.length,
  sha: createHash('sha256').update(bytes).digest('hex')
})
let dirs: string[] = []
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'metis-readback-test-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

describe('one pinned failed Windows run', () => {
  it('requires exact completed failure identity and successful upload gate', () => {
    expect(() => verifyRun(run())).not.toThrow()
    expect(() => verifyJob(job())).not.toThrow()
    expect(() => verifyArtifact(artifact())).not.toThrow()
    for (const change of [
      { head_sha: '0'.repeat(40) },
      { head_branch: 'codex/other' },
      { run_attempt: 2 },
      { conclusion: 'success' },
      { path: '.github/workflows/qa-candidate.yml' },
      { head_repository: { id: 1, full_name: 'foreign/repo' } }
    ]) {
      expect(() => verifyRun({ ...run(), ...change })).toThrow()
    }
    for (const change of [
      { run_id: 1 },
      { head_sha: '0'.repeat(40) },
      { conclusion: 'success' },
      { steps: job().steps.filter((row) => row.name !== 'Content-free gate') }
    ]) {
      expect(() => verifyJob({ ...job(), ...change })).toThrow()
    }
    for (const change of [
      { id: 1 },
      { size_in_bytes: PIN.artifact.size + 1 },
      { digest: `sha256:${'0'.repeat(64)}` },
      { expired: true },
      { workflow_run: { ...artifact().workflow_run, head_sha: '0'.repeat(40) } }
    ]) {
      expect(() => verifyArtifact({ ...artifact(), ...change })).toThrow()
    }
  })

  it('accepts a failed bound report for diagnosis but never calls it PASS', () => {
    const result = verifyReport(report(), lane())
    expect(result).toEqual({
      outcome: 'FAIL',
      failure: 'cdp-endpoint-deadline',
      teardown: 'ACKNOWLEDGED',
      cdp_diagnostic: 'NOT_OBSERVED',
      assertions: report().assertions
    })
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(() => verifyReport({ ...report(), extra: secret }, lane())).toThrow()
    expect(() =>
      verifyReport({ ...report(), identity: { ...expectedIdentity, harness_commit: '0'.repeat(40) } }, lane())
    ).toThrow()
    expect(() => verifyReport(report(), { ...lane(), ci_run_id: 1 })).toThrow()
    expect(() => verifyReport(report(), { ...lane(), outcome: 'PASS' })).toThrow()
    expect(() => verifyReport(report(), { ...lane(), detail: 'none' })).toThrow()
    expect(() => verifyReport(report(), { ...lane(), not_covered: [{ row: secret }] })).toThrow()
    expect(() => verifyReport({ ...report(), outcome: 'PASS' }, lane())).toThrow()
  })

  it('uses only fixed bounded GitHub routes, with metadata checked before downloading the ZIP', async () => {
    const calls: [string, number][] = []
    const values = [run(), job(), artifact()]
    const returned = await loadPinnedEvidence(async (route: string, cap: number) => {
      calls.push([route, cap])
      const value = values.shift()
      return value ? Buffer.from(JSON.stringify(value)) : Buffer.alloc(0)
    })
    expect(returned).toEqual(Buffer.alloc(0))
    expect(calls).toEqual([
      [`runs/${PIN.run}`, 65_536],
      [`jobs/${PIN.job}`, 65_536],
      [`artifacts/${PIN.artifact.id}`, 65_536],
      [`artifacts/${PIN.artifact.id}/zip`, PIN.artifact.size]
    ])
    const rejectedCalls: string[] = []
    await expect(
      loadPinnedEvidence(async (route: string) => {
        rejectedCalls.push(route)
        return Buffer.from(JSON.stringify({ ...run(), head_sha: secret }))
      })
    ).rejects.toThrow()
    expect(rejectedCalls).toEqual([`runs/${PIN.run}`])
  })

  it('keeps the manual workflow read-only, main-only and without artifact upload', () => {
    const source = readFileSync(
      new URL('../../.github/workflows/candidate-report-readback.yml', import.meta.url),
      'utf8'
    )
    expect(source).toContain('workflow_dispatch:')
    expect(source).toContain('pull_request:')
    expect(source).toContain('- .github/workflows/candidate-report-readback.yml')
    expect(source).toContain("github.event_name == 'workflow_dispatch'")
    expect(source).toContain("github.ref == 'refs/heads/main'")
    expect(source).toContain('contents: read')
    expect(source).toContain('actions: read')
    expect(source).not.toContain('upload-artifact')
  })
})

describe.skipIf(process.platform !== 'linux' || !hostedCi)('hosted bounded ZIP readback', () => {
  it('reads only the two regular JSON members from an exact digest', async () => {
    const bytes = storedZip(entries())
    const result = await readArchive(bytes, archivePin(bytes), tempDir(), performance.now() + 60_000)
    expect(result.failure).toBe('cdp-endpoint-deadline')
    expect(result.outcome).toBe('FAIL')
    await expect(
      readArchive(bytes, { ...archivePin(bytes), sha: '0'.repeat(64) }, tempDir(), performance.now() + 60_000)
    ).rejects.toThrow()
  })

  it('rejects extra, traversal, case-collision, link, oversized, corrupt CRC and malformed members', async () => {
    const cases = [
      storedZip([...entries(), { name: 'extra.txt', body: secret }]),
      storedZip([...entries(), { name: '../escape', body: secret }]),
      storedZip([...entries(), { name: 'LANE.JSON', body: secret }]),
      storedZip([{ ...entries()[0], mode: 0o120777 }, entries()[1]]),
      storedZip([{ name: entries()[0].name, body: 'X'.repeat(65_537) }, entries()[1]]),
      storedZip(entries(), true),
      storedZip(entries({ ...report(), extra: secret })),
      storedZip([{ name: entries()[0].name, body: '{' }, entries()[1]])
    ]
    for (const bytes of cases) {
      let thrown: unknown
      try {
        await readArchive(bytes, archivePin(bytes), tempDir(), performance.now() + 60_000)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeDefined()
      expect(closedReadbackFailure(thrown)).toMatch(/^[a-z-]+$/)
      expect(closedReadbackFailure(thrown)).not.toContain(secret)
    }
  })

  it('rejects a swapped producer or CI identity inside otherwise valid members', async () => {
    const swaps = [
      entries({ ...report(), identity: { ...expectedIdentity, producer_commit: '0'.repeat(40) } }),
      entries(report(), { ...lane(), ci_run_id: 1 }),
      entries(report(), { ...lane(), identity: { ...expectedIdentity, installer_sha256: '0'.repeat(64) } })
    ]
    for (const files of swaps) {
      const bytes = storedZip(files)
      await expect(readArchive(bytes, archivePin(bytes), tempDir(), performance.now() + 60_000)).rejects.toThrow()
    }
  })
})
