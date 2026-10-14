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

function validDiagnostics() {
  return {
    version: 1,
    setup: { requestedAtMs: 10, settledAtMs: 20, status: 'answered' },
    summary: { requestedAtMs: 2_000, settledAtMs: 2_010, status: 'answered' },
    profilerCommands: [
      { command: 'enable', requestedAtMs: 30, settledAtMs: 35, status: 'answered' },
      { command: 'set-sampling-interval', requestedAtMs: 36, settledAtMs: 40, status: 'answered' },
      { command: 'start', requestedAtMs: 41, settledAtMs: 60, status: 'answered' },
      { command: 'stop', requestedAtMs: 1_500, settledAtMs: 1_520, status: 'answered' }
    ],
    samples: [
      {
        selector: 'worst-loop',
        index: 2,
        tMs: 1_000,
        requestAtMs: 990,
        settledAtMs: 1_010,
        status: 'answered',
        late: false,
        hung: false,
        histogram: { lowerBoundMs: 500, upperBoundMs: 1_010, boundsKnown: true },
        overlaps: {
          histogram: [{ command: 'start', observedWaitMs: 19, executionBoundKnown: true }],
          sampleRoundTrip: []
        },
        metrics: { loopMaxSinceLastMs: 700, loopMaxDuringWriteMs: 40, writeMs: 20, lookupMs: 3, roundTripMs: 20 },
        witness: {
          loopMaxSinceLastMs: 5,
          writeMs: 2,
          cpuBusyPct: 20,
          readRequestedAtMs: 995,
          readSettledAtMs: 996,
          writeStartedAtMs: 996,
          writeSettledAtMs: 999
        }
      }
    ]
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
    expect('criteria' in notice ? notice.criteria : undefined).toContainEqual({ name: 'loop-p99 < 50', passed: false })
    expect(notice.reportSha256).toBe(createHash('sha256').update(input.reportText).digest('hex'))
    const serialized = JSON.stringify(notice)
    expect(serialized).not.toContain('private')
    expect(serialized).not.toContain('meeting title')
    expect(serialized).not.toContain('timeline')
    expect(serialized).not.toContain(installer)
    expect(serialized).not.toContain(artifactSha)
  })

  it('keeps old reports valid with a fixed diagnostics-unavailable reason', () => {
    const input = fixture(validReport())
    expect(createNotice({ argv: input.argv, env })).toMatchObject({
      state: 'available',
      verdict: 'FAIL',
      diagnostics: { version: 1, state: 'unavailable', reason: 'diagnostics_unavailable' }
    })
  })

  it('serializes only the closed bounded diagnostic projection', () => {
    const input = fixture({ ...validReport(), profilerDiagnostics: validDiagnostics() })
    const notice = createNotice({ argv: input.argv, env })
    expect(notice).toMatchObject({
      state: 'available',
      verdict: 'FAIL',
      diagnostics: {
        version: 1,
        state: 'available',
        profilerCommands: [{ command: 'enable', requestedAtMs: 30, settledAtMs: 35, status: 'answered' }],
        samples: [
          expect.objectContaining({
            selector: 'worst-loop',
            index: 2,
            histogram: { lowerBoundMs: 500, upperBoundMs: 1_010, boundsKnown: true },
            overlaps: {
              histogram: [{ command: 'start', observedWaitMs: 19, executionBoundKnown: true }],
              sampleRoundTrip: []
            },
            witness: { loopMaxSinceLastMs: 5, writeMs: 2, cpuBusyPct: 20 }
          })
        ]
      }
    })
    const serialized = JSON.stringify(notice)
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(8 * 1024)
    expect(serialized).not.toContain('private')
    expect(serialized).not.toContain('meeting title')
    expect(serialized).not.toContain('resources')
  })

  it.each([
    { ...validDiagnostics(), version: 2 },
    {
      ...validDiagnostics(),
      profilerCommands: [...validDiagnostics().profilerCommands, ...validDiagnostics().profilerCommands.slice(0, 1)]
    },
    {
      ...validDiagnostics(),
      profilerCommands: [{ ...validDiagnostics().profilerCommands[0], command: 'Profiler.start' }]
    },
    { ...validDiagnostics(), profilerCommands: [{ ...validDiagnostics().profilerCommands[0], settledAtMs: 29 }] },
    { ...validDiagnostics(), samples: Array(6).fill(validDiagnostics().samples[0]) },
    { ...validDiagnostics(), samples: [{ ...validDiagnostics().samples[0], index: -1 }] },
    { ...validDiagnostics(), samples: [{ ...validDiagnostics().samples[0], settledAtMs: -1 }] },
    { ...validDiagnostics(), samples: [{ ...validDiagnostics().samples[0], status: 'unknown' }] },
    {
      ...validDiagnostics(),
      samples: [
        { ...validDiagnostics().samples[0], histogram: { lowerBoundMs: 500, upperBoundMs: 400, boundsKnown: true } }
      ]
    },
    { ...validDiagnostics(), samples: [{ ...validDiagnostics().samples[0], metrics: { writeMs: Infinity } }] },
    {
      ...validDiagnostics(),
      samples: [
        {
          ...validDiagnostics().samples[0],
          overlaps: {
            histogram: Array(5).fill({ command: 'start', observedWaitMs: 1, executionBoundKnown: true }),
            sampleRoundTrip: []
          }
        }
      ]
    },
    { ...validDiagnostics(), privateError: 'private meeting transcript' }
  ])('replaces malformed diagnostic input with a fixed unavailable reason', (diagnostics) => {
    const input = fixture({ ...validReport(), profilerDiagnostics: diagnostics })
    const notice = createNotice({ argv: input.argv, env })
    expect(notice).toMatchObject({
      state: 'available',
      verdict: 'FAIL',
      diagnostics: { version: 1, state: 'unavailable', reason: 'diagnostics_invalid' }
    })
    expect(JSON.stringify(notice)).not.toContain('private meeting transcript')
    expect(JSON.stringify(notice)).not.toContain(input.reportPath)
  })

  it('accepts absent setup as unknown instead of inventing timing bounds', () => {
    const diagnostics = {
      ...validDiagnostics(),
      setup: null,
      summary: null,
      samples: [
        { ...validDiagnostics().samples[0], histogram: { lowerBoundMs: null, upperBoundMs: null, boundsKnown: false } }
      ]
    }
    const input = fixture({ ...validReport(), profilerDiagnostics: diagnostics })
    expect(createNotice({ argv: input.argv, env })).toMatchObject({
      state: 'available',
      diagnostics: {
        version: 1,
        state: 'available',
        setup: null,
        samples: [{ histogram: { lowerBoundMs: null, upperBoundMs: null, boundsKnown: false } }]
      }
    })
  })

  it('marks oversized diagnostics unavailable without exceeding the notice size bound', () => {
    const diagnostics = {
      ...validDiagnostics(),
      samples: [
        {
          ...validDiagnostics().samples[0],
          witness: { loopMaxSinceLastMs: 1, writeMs: 2, cpuBusyPct: 3, padding: 'x'.repeat(9_000) }
        }
      ]
    }
    const input = fixture({ ...validReport(), profilerDiagnostics: diagnostics })
    const notice = createNotice({ argv: input.argv, env })
    expect(notice).toMatchObject({
      state: 'available',
      diagnostics: { version: 1, state: 'unavailable', reason: 'diagnostics_too_large' }
    })
    expect(Buffer.byteLength(JSON.stringify(notice))).toBeLessThanOrEqual(8 * 1024)
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
