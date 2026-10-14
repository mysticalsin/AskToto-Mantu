import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { annotationMessage, createNotice } from '../qa/st1-evidence-notice.mjs'

const runId = 123456
const attempt = 2
const commit = 'a'.repeat(40)
const artifactSha = 'b'.repeat(64)
const installer = 'Metis-QA.zip'
const env = {
  GITHUB_RUN_ID: String(runId),
  GITHUB_RUN_ATTEMPT: String(attempt),
  GITHUB_SHA: commit,
  GITHUB_REPOSITORY: 'owner/repo'
}

let directory = ''
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

function fixture(report: Record<string, unknown> | string, row = 'fifo') {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = mkdtempSync(join(tmpdir(), 'st1-evidence-notice-'))
  const provenancePath = join(directory, 'provenance.json')
  const reportPath = join(directory, 'report.json')
  const provenance = {
    schema: 2,
    repository: env.GITHUB_REPOSITORY,
    commit,
    run: { id: runId, attempt },
    builds: [{ variant: 'mac-qa-identity', assets: [{ name: installer, sha256: artifactSha }] }]
  }
  const reportText = typeof report === 'string' ? report : JSON.stringify(report)
  writeFileSync(provenancePath, JSON.stringify(provenance))
  writeFileSync(reportPath, reportText)
  return {
    reportPath,
    provenancePath,
    reportText,
    argv: ['--report', reportPath, '--provenance', provenancePath, '--row', row]
  }
}

function validReport(row = 'fifo') {
  return {
    harness: 'ST-1',
    platform: 'darwin',
    row,
    installer,
    build_run_id: runId,
    artifact_sha256: artifactSha,
    complete: true,
    verdict: 'FAIL',
    teardown: { state: 'acknowledged' },
    criteria: [
      { name: 'inspector', pass: true },
      { name: 'loop-p99 < 50', pass: false },
      { name: 'loop-max < 250', pass: true },
      { name: 'async-write < 250', pass: true },
      { name: 'dns-lookup < 250', pass: true },
      { name: 'non-regular-fixtures-unopened', pass: true }
    ],
    samples: 298,
    lateSamples: 0,
    loop: { p99Ms: 51.2, maxMs: 214 },
    write: { maxMs: 87 },
    lookup: { maxMs: 120 },
    fixturesOpened: [],
    errors: [{ message: 'private profile path /private/user/meeting title' }],
    mainLog: { error: 'private log path' },
    timeline: [{ private: 'meeting content' }]
  }
}

describe('strict ST-1 GitHub notice serializer', () => {
  it('publishes only whitelisted context, criteria, and finite metrics, retaining the actual failed status', () => {
    const input = fixture(validReport())
    const notice = createNotice({ argv: input.argv, env })

    expect(notice).toMatchObject({
      state: 'available',
      mode: 'strict-hosted',
      verdict: 'FAIL',
      complete: true,
      teardownAcknowledged: true,
      context: { runId, attempt, commit, row: 'fifo' },
      metrics: {
        sampleCount: { actual: 298 },
        lateSampleCount: { actual: 0, limit: 0 },
        loopP99Ms: { actual: 51.2, limit: 50 },
        loopMaxMs: { actual: 214, limit: 250 },
        asyncWriteMaxMs: { actual: 87, limit: 250 },
        dnsLookupMaxMs: { actual: 120, limit: 250 },
        openedFixtureCount: { actual: 0, limit: 0 }
      }
    })
    expect(notice.criteria).toContainEqual({ name: 'loop-p99 < 50', passed: false })
    expect(notice.reportSha256).toBe(createHash('sha256').update(input.reportText).digest('hex'))
    const serialized = JSON.stringify(notice)
    expect(serialized).not.toContain('private')
    expect(serialized).not.toContain('meeting title')
    expect(serialized).not.toContain('timeline')
    expect(serialized).not.toContain(installer)
    expect(serialized).not.toContain(artifactSha)
  })

  it('emits a fixed typed diagnostic for malformed, missing, oversized, and unknown-criterion reports', () => {
    const malformed = fixture('{not json')
    expect(createNotice({ argv: malformed.argv, env })).toMatchObject({
      state: 'unavailable',
      reason: 'report_malformed'
    })

    const missing = fixture(validReport())
    rmSync(missing.reportPath)
    expect(createNotice({ argv: missing.argv, env })).toMatchObject({ state: 'unavailable', reason: 'report_missing' })

    const oversized = fixture('x'.repeat(4 * 1024 * 1024 + 1))
    expect(createNotice({ argv: oversized.argv, env })).toMatchObject({
      state: 'unavailable',
      reason: 'report_too_large'
    })

    const unknownCriterion = fixture({
      ...validReport(),
      criteria: [{ name: 'unexpected private string', pass: false }]
    })
    expect(createNotice({ argv: unknownCriterion.argv, env })).toMatchObject({
      state: 'unavailable',
      reason: 'report_schema_invalid'
    })

    const malformedProvenance = fixture(validReport())
    writeFileSync(
      malformedProvenance.provenancePath,
      JSON.stringify({ schema: 2, repository: env.GITHUB_REPOSITORY, commit, run: { id: runId, attempt }, builds: {} })
    )
    expect(() => createNotice({ argv: malformedProvenance.argv, env })).not.toThrow()
    expect(createNotice({ argv: malformedProvenance.argv, env })).toMatchObject({
      state: 'unavailable',
      reason: 'context_invalid'
    })
  })

  it('rejects symlinks and non-regular inputs without following or blocking on them', () => {
    const input = fixture(validReport())
    if (process.platform !== 'win32') {
      const target = join(dirname(input.reportPath), 'target.json')
      const symlink = join(dirname(input.reportPath), 'linked-report.json')
      writeFileSync(target, input.reportText)
      symlinkSync(target, symlink)
      const linked = ['--report', symlink, '--provenance', input.provenancePath, '--row', 'fifo']
      expect(createNotice({ argv: linked, env })).toMatchObject({ state: 'unavailable' })

      const fifo = join(dirname(input.reportPath), 'fifo-report.json')
      execFileSync('mkfifo', [fifo])
      const fifoArgs = ['--report', fifo, '--provenance', input.provenancePath, '--row', 'fifo']
      expect(createNotice({ argv: fifoArgs, env })).toMatchObject({ state: 'unavailable' })
    }
  })

  it('prints a notice through the real CLI and keeps malformed input out of stderr', () => {
    const input = fixture(validReport())
    const script = resolve(__dirname, '..', 'qa', 'st1-evidence-notice.mjs')
    const result = spawnSync(process.execPath, [script, ...input.argv], {
      encoding: 'utf8',
      env: { ...process.env, ...env }
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('::notice::{')
    expect(result.stdout).toContain('"verdict":"FAIL"')
    expect(result.stdout).not.toContain('private')

    const malformed = fixture('{broken private input')
    const failed = spawnSync(process.execPath, [script, ...malformed.argv], {
      encoding: 'utf8',
      env: { ...process.env, ...env }
    })
    expect(failed.error).toBeUndefined()
    expect(failed.status).toBe(0)
    expect(failed.stderr).toBe('')
    expect(failed.stdout).toContain('"reason":"report_malformed"')
    expect(failed.stdout).not.toContain('broken private input')
    expect(failed.stdout).not.toContain(input.reportPath)

    const unknownShape = fixture({
      ...validReport(),
      criteria: [{ name: 'unexpected private criterion', pass: false }],
      errors: [{ message: 'private path /private/meeting-content' }]
    })
    const rejected = spawnSync(process.execPath, [script, ...unknownShape.argv], {
      encoding: 'utf8',
      env: { ...process.env, ...env }
    })
    expect(rejected.error).toBeUndefined()
    expect(rejected.status).toBe(0)
    expect(rejected.stderr).toBe('')
    expect(rejected.stdout).toContain('"reason":"report_schema_invalid"')
    expect(rejected.stdout).not.toContain('private criterion')
    expect(rejected.stdout).not.toContain('/private/meeting-content')
    expect(rejected.stdout).not.toContain(unknownShape.reportPath)
  })

  it('rejects mismatched workflow context and escapes annotation control characters', () => {
    const input = fixture(validReport())
    expect(createNotice({ argv: input.argv, env: { ...env, GITHUB_SHA: 'c'.repeat(40) } })).toMatchObject({
      state: 'unavailable',
      reason: 'context_invalid'
    })

    const windowEvidence = fixture({ ...validReport(), purpose: 'window-construction', st1Evidence: false })
    expect(createNotice({ argv: windowEvidence.argv, env })).toMatchObject({
      state: 'unavailable',
      reason: 'report_context_mismatch'
    })
    expect(annotationMessage({ value: '%\r\n' })).toBe('::notice::{"value":"%25\\r\\n"}')
  })
})
