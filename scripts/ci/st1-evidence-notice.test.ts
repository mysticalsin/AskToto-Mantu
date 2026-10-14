import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    expect(annotationMessage({ value: '%\r\n' })).toBe('::notice::{"value":"%25%0D%0A"}')
  })
})
