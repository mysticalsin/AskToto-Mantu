import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canaryZip } from './retained-profile-analysis.mjs'
import {
  PIN,
  closedReadbackFailure,
  loadPinnedEvidence,
  readArchive,
  verifyArtifact,
  verifyJob,
  verifyReport,
  verifyRun
} from './windows-cdp-diagnostic-readback.mjs'

const secret = 'SYNTHETIC_PRIVATE_VALUE_must_never_be_logged'
const hostedLinux = process.platform === 'linux' && process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true'
const report = () => ({
  schema: 'metis.windows-cdp-diagnostic-spike.v1',
  diagnostic_only: true,
  identity: {
    candidate_run: 37771807736,
    installer_sha256: 'a5459e1f5137710b3f249a21ae372c13395f083a45319a0bd3f8fce7a44d6ff1',
    producer_commit: '2d4ebe7b6698f78abcb74dc426867d95d96e4268',
    harness_commit: PIN.head,
    version: '1.9.7'
  },
  acceptance_15s: 'DEADLINE',
  cdp_45s: 'OWNED_CDP',
  inspector_45s: 'OWNED_PROFILE_AND_VERSION',
  process_at_end: 'RUNNING',
  teardown: 'ACKNOWLEDGED',
  transport_release: 'RELEASED'
})
const run = () => ({
  id: PIN.run,
  path: '.github/workflows/windows-cdp-diagnostic-spike.yml',
  event: 'workflow_dispatch',
  head_branch: 'main',
  head_sha: PIN.head,
  run_attempt: 1,
  status: 'completed',
  conclusion: 'success',
  repository: { id: 1282463398, full_name: 'mysticalsin/AskToto-Mantu' },
  head_repository: { id: 1282463398, full_name: 'mysticalsin/AskToto-Mantu' }
})
const job = () => ({
  id: PIN.job,
  name: 'probe',
  run_id: PIN.run,
  head_sha: PIN.head,
  status: 'completed',
  conclusion: 'success',
  steps: [
    { name: 'Install the pinned Setup into a fresh directory', conclusion: 'success' },
    { name: 'Observe exact owned process with unchanged 15-second boundary', conclusion: 'success' },
    { name: 'Validate the only uploadable fixed-enum report', conclusion: 'success' },
    { name: 'Upload validated diagnostic only', conclusion: 'success' },
    { name: 'Fail unless observation and content-free gate completed', conclusion: 'skipped' }
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

const archivePin = (bytes: Buffer) => ({
  size: bytes.length,
  sha: createHash('sha256').update(bytes).digest('hex')
})
const entry = (value: unknown = report()) => [{ name: 'cdp-probe.json', body: `${JSON.stringify(value)}\n` }]
let directories: string[] = []
const tempDir = () => {
  const path = mkdtempSync(join(tmpdir(), 'metis-cdp-readback-test-'))
  directories.push(path)
  return path
}
afterEach(() => {
  for (const path of directories) rmSync(path, { recursive: true, force: true })
  directories = []
})

describe('one pinned diagnostic artifact', () => {
  it('binds completed run, successful validation job, and exact immutable artifact', () => {
    expect(() => verifyRun(run())).not.toThrow()
    expect(() => verifyJob(job())).not.toThrow()
    expect(() => verifyArtifact(artifact())).not.toThrow()
    for (const change of [
      { head_sha: '0'.repeat(40) },
      { head_branch: 'other' },
      { run_attempt: 2 },
      { path: '.github/workflows/qa-candidate.yml' },
      { repository: { id: 1, full_name: 'other/repo' } }
    ]) {
      expect(() => verifyRun({ ...run(), ...change })).toThrow()
    }
    for (const change of [
      { head_sha: '0'.repeat(40) },
      { conclusion: 'failure' },
      { steps: job().steps.filter((step) => step.name !== 'Validate the only uploadable fixed-enum report') }
    ]) {
      expect(() => verifyJob({ ...job(), ...change })).toThrow()
    }
    for (const change of [
      { id: 1 },
      { size_in_bytes: 503 },
      { digest: `sha256:${'0'.repeat(64)}` },
      { expired: true },
      { workflow_run: { ...artifact().workflow_run, head_sha: '0'.repeat(40) } }
    ]) {
      expect(() => verifyArtifact({ ...artifact(), ...change })).toThrow()
    }
  })

  it('prints only validated diagnostic statuses and never identity or arbitrary content', () => {
    expect(verifyReport(report())).toEqual({
      diagnostic_only: true,
      acceptance_15s: 'DEADLINE',
      cdp_45s: 'OWNED_CDP',
      inspector_45s: 'OWNED_PROFILE_AND_VERSION',
      process_at_end: 'RUNNING',
      teardown: 'ACKNOWLEDGED',
      transport_release: 'RELEASED'
    })
    expect(JSON.stringify(verifyReport(report()))).not.toContain('installer_sha256')
    expect(() => verifyReport({ ...report(), extra: secret })).toThrow()
    expect(() => verifyReport({ ...report(), acceptance_15s: secret })).toThrow()
    expect(() =>
      verifyReport({ ...report(), identity: { ...report().identity, harness_commit: '0'.repeat(40) } })
    ).toThrow()
    expect(() => verifyReport({ ...report(), acceptance_15s: 'OWNED_CDP' })).toThrow()
  })

  it('checks metadata before requesting only the pinned ZIP', async () => {
    const calls: [string, number][] = []
    const values = [run(), job(), artifact()]
    await loadPinnedEvidence(async (route: string, cap: number) => {
      calls.push([route, cap])
      const value = values.shift()
      return value ? Buffer.from(JSON.stringify(value)) : Buffer.alloc(0)
    })
    expect(calls).toEqual([
      [`runs/${PIN.run}`, 65_536],
      [`jobs/${PIN.job}`, 65_536],
      [`artifacts/${PIN.artifact.id}`, 65_536],
      [`artifacts/${PIN.artifact.id}/zip`, PIN.artifact.size]
    ])
    const rejected: string[] = []
    await expect(loadPinnedEvidence(async (route: string) => {
      rejected.push(route)
      return Buffer.from(JSON.stringify({ ...run(), head_sha: secret }))
    })).rejects.toThrow()
    expect(rejected).toEqual([`runs/${PIN.run}`])
  })

  it('keeps the disposable workflow main-only, read-only and bounded', () => {
    const source = readFileSync(
      new URL('../../.github/workflows/windows-cdp-diagnostic-readback.yml', import.meta.url),
      'utf8'
    )
    expect(source).toContain('workflow_dispatch:')
    expect(source).toContain("github.ref == 'refs/heads/main'")
    expect(source).toContain("github.event_name == 'workflow_dispatch'")
    expect(source).toContain('contents: read')
    expect(source).toContain('actions: read')
    expect(source).toContain('2026-10-11T18:00:00Z')
    expect(source).not.toContain('upload-artifact')
  })
})

describe.skipIf(!hostedLinux)('hosted bounded diagnostic ZIP readback', () => {
  it('reads exactly one regular capped member from matching ZIP bytes', async () => {
    const bytes = canaryZip(entry())
    expect(await readArchive(bytes, archivePin(bytes), tempDir(), performance.now() + 60_000)).toEqual(
      verifyReport(report())
    )
    await expect(
      readArchive(bytes, { ...archivePin(bytes), sha: '0'.repeat(64) }, tempDir(), performance.now() + 60_000)
    ).rejects.toThrow()
  })

  it('rejects extra, traversing, link, oversized, corrupt and untrusted members without echoing them', async () => {
    const cases = [
      canaryZip([...entry(), { name: 'extra.txt', body: secret }]),
      canaryZip([...entry(), { name: '../escape', body: secret }]),
      canaryZip([{ ...entry()[0], mode: 0o120777 }]),
      canaryZip(entry({ ...report(), extra: 'X'.repeat(2_049) })),
      canaryZip(entry(), true),
      canaryZip(entry({ ...report(), extra: secret })),
      canaryZip([{ name: 'cdp-probe.json', body: '{' }])
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
})
