import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ARTIFACT,
  SOURCE,
  analyzeControlEvidence,
  createReadbackNotices,
  verifyArtifactMetadata,
  verifyReportDigest,
  verifyRunMetadata,
  verifyReportScope
} from './st1-current-profile-readback.mjs'
import { findUnpinnedUses } from '../ci/check-workflow-pins.mjs'
import { evaluateCriteria } from './lib/st-1-core.mjs'

function validRun() {
  return {
    id: SOURCE.runId,
    path: SOURCE.workflowPath,
    event: SOURCE.event,
    run_attempt: SOURCE.attempt,
    status: 'completed',
    conclusion: 'failure',
    head_sha: SOURCE.headSha,
    head_branch: SOURCE.headBranch,
    repository: { id: SOURCE.repositoryId, full_name: SOURCE.repository },
    head_repository: { id: SOURCE.repositoryId, full_name: SOURCE.repository }
  }
}

function validArtifact() {
  return {
    id: ARTIFACT.id,
    name: ARTIFACT.name,
    size_in_bytes: ARTIFACT.size,
    digest: `sha256:${ARTIFACT.sha256}`,
    expired: false,
    expires_at: '2030-01-01T00:00:00Z',
    workflow_run: {
      id: SOURCE.runId,
      repository_id: SOURCE.repositoryId,
      head_repository_id: SOURCE.repositoryId,
      head_sha: SOURCE.headSha
    }
  }
}

function profile() {
  const frame = (functionName: string) => ({
    functionName,
    url: 'private://should-never-be-output',
    lineNumber: 1,
    columnNumber: 2,
    scriptId: 'private-script'
  })
  return {
    startTime: 1_000_000,
    endTime: 4_000_000,
    nodes: [
      { id: 1, callFrame: frame('(root)'), children: [2, 3] },
      { id: 2, callFrame: frame('(program)') },
      { id: 3, callFrame: frame('unclassified private function') }
    ],
    samples: [2, 3, 2],
    timeDeltas: [250_000, 1_000_000, 500_000]
  }
}

function validReport() {
  const timeline: Record<string, unknown>[] = []
  timeline.push({
    tMs: 3_297,
    requestAtMs: 3_297,
    settledAtMs: 5_044,
    diagnosticStatus: 'answered',
    histogramLowerBoundMs: 1_105,
    histogramUpperBoundMs: 5_044,
    histogramBoundsKnown: true,
    late: true,
    writeMs: 1_386.700625,
    lookupMs: 320.467584,
    loopMaxSinceLastMs: 909.639679,
    loopMaxDuringWriteMs: 571.473919,
    witness: {
      readRequestedAtMs: 1_000,
      readSettledAtMs: 1_001,
      loopMaxSinceLastMs: 11,
      cpuBusyPct: 20,
      writeStartedAtMs: 3_301,
      writeSettledAtMs: 3_302,
      writeMs: 1
    }
  })
  for (let index = 1; index <= 294; index += 1) {
    const requestAtMs = 6_000 + index * 1_000
    const worstTimely = index === 1
    timeline.push({
      tMs: requestAtMs,
      requestAtMs,
      settledAtMs: requestAtMs + 20,
      diagnosticStatus: 'answered',
      histogramLowerBoundMs: requestAtMs - 1_000,
      histogramUpperBoundMs: requestAtMs + 20,
      histogramBoundsKnown: true,
      writeMs: worstTimely ? 385.9653330000001 : 10,
      lookupMs: worstTimely ? 14.035041999999521 : 2,
      loopMaxSinceLastMs: 18,
      loopMaxDuringWriteMs: 8,
      witness: {
        readRequestedAtMs: requestAtMs,
        readSettledAtMs: requestAtMs + 1,
        loopMaxSinceLastMs: 3,
        cpuBusyPct: 10,
        writeStartedAtMs: requestAtMs + 1,
        writeSettledAtMs: requestAtMs + 2,
        writeMs: 1
      }
    })
  }
  const profilerDiagnostics = {
    version: 1,
    setup: { requestedAtMs: 1_105, settledAtMs: 2_752, status: 'answered' },
    summary: { requestedAtMs: 303_207, settledAtMs: 303_209, status: 'answered' },
    profilerCommands: [
      { command: 'enable', requestedAtMs: 2_753, settledAtMs: 3_134, status: 'answered' },
      { command: 'set-sampling-interval', requestedAtMs: 3_134, settledAtMs: 3_156, status: 'answered' },
      { command: 'start', requestedAtMs: 3_156, settledAtMs: 3_296, status: 'answered' },
      { command: 'stop', requestedAtMs: 300_144, settledAtMs: 300_186, status: 'answered' }
    ]
  }
  return {
    harness: 'ST-1',
    build_run_id: SOURCE.runId,
    artifact_sha256: 'd'.repeat(64),
    row: 'none',
    platform: 'darwin',
    arch: 'arm64',
    minutes: 5,
    complete: true,
    verdict: 'FAIL',
    teardown: { state: 'acknowledged' },
    samples: 294,
    lateSamples: 1,
    loop: { p99Ms: 18.694143, maxMs: 909.639679 },
    write: { maxMs: 385.9653330000001 },
    lookup: { maxMs: 14.035041999999521 },
    criteria: [
      { name: 'inspector', pass: true },
      { name: 'has-samples', pass: true },
      { name: 'no-late-samples', pass: false },
      { name: 'loop-p99 < 50', pass: true },
      { name: 'loop-max < 250', pass: false },
      { name: 'async-write < 250', pass: false },
      { name: 'dns-lookup < 250', pass: true }
    ],
    timeline,
    profilerDiagnostics,
    cpuProfile: {
      file: ARTIFACT.profileName,
      running: false,
      requestedAtMs: 3_156,
      answeredAtMs: 3_296,
      startedAtMs: 3_296,
      stoppedAtMs: 300_144
    },
    bootStages: {
      stages: [
        { stage: 'createWindow.construct', ms: 180, sinceSpawnMs: 2_900 },
        { stage: 'untrusted function name', ms: 300, sinceSpawnMs: 3_500 }
      ]
    }
  }
}

describe('fixed failed control run binding', () => {
  it('accepts the exact completed failed pull-request run, not a successful or nearby run', () => {
    expect(() => verifyRunMetadata(validRun())).not.toThrow()
    for (const [field, value] of [
      ['id', SOURCE.runId + 1],
      ['path', 'workflow.yml'],
      ['event', 'workflow_dispatch'],
      ['run_attempt', SOURCE.attempt + 1],
      ['status', 'in_progress'],
      ['conclusion', 'success'],
      ['head_sha', 'a'.repeat(40)],
      ['head_branch', 'main']
    ] as const) {
      expect(() => verifyRunMetadata({ ...validRun(), [field]: value })).toThrow()
    }
    expect(() => verifyRunMetadata({ ...validRun(), repository: { id: 1, full_name: SOURCE.repository } })).toThrow()
    expect(() =>
      verifyRunMetadata({ ...validRun(), head_repository: { id: 1, full_name: SOURCE.repository } })
    ).toThrow()
  })

  it('binds immutable artifact metadata, unexpired status and matching run identity', () => {
    expect(() => verifyArtifactMetadata(validArtifact(), Date.parse('2029-01-01T00:00:00Z'))).not.toThrow()
    for (const [field, value] of [
      ['id', ARTIFACT.id + 1],
      ['name', 'other-artifact'],
      ['size_in_bytes', ARTIFACT.size + 1],
      ['digest', `sha256:${'a'.repeat(64)}`],
      ['expired', true],
      ['expires_at', '2020-01-01T00:00:00Z']
    ] as const) {
      expect(() => verifyArtifactMetadata({ ...validArtifact(), [field]: value }, Date.parse('2029-01-01Z'))).toThrow()
    }
    expect(() =>
      verifyArtifactMetadata(
        { ...validArtifact(), workflow_run: { ...validArtifact().workflow_run, id: SOURCE.runId + 1 } },
        Date.parse('2029-01-01Z')
      )
    ).toThrow()
  })

  it('accepts only the pinned raw report bytes digest', () => {
    expect(() => verifyReportDigest(SOURCE.reportSha256)).not.toThrow()
    expect(() => verifyReportDigest('a'.repeat(64))).toThrow()
  })
})

describe('current control profile projection', () => {
  it('requires the immutable complete failed no-history report and acknowledged teardown', () => {
    expect(() => verifyReportScope(validReport())).not.toThrow()
    for (const change of [
      { row: 'fifo' },
      { complete: false },
      { verdict: 'PASS' },
      { build_run_id: SOURCE.runId + 1 },
      { artifact_sha256: 'not-a-digest' },
      { teardown: { state: 'unknown' } },
      { cpuProfile: { ...validReport().cpuProfile, running: true } },
      { cpuProfile: { ...validReport().cpuProfile, file: 'private path' } }
    ]) {
      expect(() => verifyReportScope({ ...validReport(), ...change })).toThrow()
    }
  })

  it('selects the worst timely write separately from the late window and retains original failure verdict', () => {
    const report = validReport()
    const result = analyzeControlEvidence(report, profile())
    expect(result).toMatchObject({
      originalVerdict: 'FAIL',
      st1Evidence: false,
      causalConclusion: 'not-established',
      profile: expect.objectContaining({
        preProfileCause: 'unknown',
        candidateBuildRunId: SOURCE.runId,
        candidateInstallerSha256: 'd'.repeat(64),
        candidateDigestBinding: 'historical-provenance-report-only'
      }),
      metrics: {
        sampleCount: 294,
        lateSampleCount: 1,
        loopP99Ms: 18.694143,
        loopMaxMs: 909.639679,
        timelyWriteMaxMs: 385.9653330000001,
        timelyDnsMaxMs: 14.035041999999521
      },
      windows: expect.arrayContaining([
        expect.objectContaining({
          selector: 'first-late-or-hung',
          index: 0,
          requestAtMs: 3_297,
          targetSettledAtMs: 5_044
        }),
        expect.objectContaining({
          selector: 'worst-timely-write',
          index: 1,
          requestAtMs: 7_000,
          targetSettledAtMs: 7_020
        })
      ])
    })
    expect(result.windows.find((window: { index: number }) => window.index === 0)?.selectors).toContain('worst-write')
  })

  it('keeps timeout observation separate from unknown target completion and histogram bounds', () => {
    const report = validReport()
    const sample = report.timeline[0]
    sample.diagnosticStatus = 'timed-out'
    sample.hung = true
    sample.late = true
    const result = analyzeControlEvidence(report, profile())
    const late = result.windows.find((window: { selector: string }) => window.selector === 'first-late-or-hung')
    expect(late).toBeDefined()
    if (!late) throw new Error('late window missing')
    expect(late).toMatchObject({ targetSettledAtMs: null, observationEndAtMs: 5_044 })
    expect(late.sampleRoundTrip).toBeNull()
    expect(late.histogram).toEqual({ lowerBoundMs: 1_105, upperBoundMs: 5_044, boundsKnown: true })
  })

  it('reports profiler start uncertainty and never fabricates execution before profile collection', () => {
    const result = analyzeControlEvidence(validReport(), profile())
    expect(result.profile).toMatchObject({
      profilerStartIntervalMs: [3_156, 3_296],
      preProfileIntervalMs: [0, 3_156],
      maxSampleGapMs: 1_000,
      coverageInterpretation: 'sampled-deltas-not-exclusive-cpu-time'
    })
    expect(result.profile).not.toHaveProperty('profileStartExactMs')
  })

  it('uses neighboring witness read/reset timestamps and marks absent coverage incomplete', () => {
    const report = validReport()
    const nextWitness = report.timeline[1].witness as Record<string, number>
    nextWitness.readRequestedAtMs = 5_044
    nextWitness.readSettledAtMs = 5_045
    const withCoverage = analyzeControlEvidence(report, profile())
    expect(withCoverage.witness).toMatchObject({
      coverageComplete: true,
      intervals: [expect.objectContaining({ index: 1 })]
    })

    const priorWitness = report.timeline[0].witness as Record<string, number>
    priorWitness.readSettledAtMs = 6_000
    nextWitness.readRequestedAtMs = 9_000
    nextWitness.readSettledAtMs = 9_001
    const withoutCoverage = analyzeControlEvidence(report, profile())
    expect(withoutCoverage.witness.coverageComplete).toBe(false)
  })

  it('keeps boot-stage publication as an upper bound and excludes unknown stage strings', () => {
    const result = analyzeControlEvidence(validReport(), profile())
    expect(result.bootStages).toMatchObject({
      stages: [{ stage: 'createWindow.construct', durationMs: 180, sinceSpawnUpperBoundMs: 2_900 }]
    })
    expect(JSON.stringify(result.bootStages)).not.toContain('untrusted function name')
    expect(JSON.stringify(result.bootStages)).not.toContain('stageStartMs')
  })

  it('publishes recognized boot-stage names and validated historical profile binding in closed notices', () => {
    const report = validReport()
    report.bootStages.stages = [
      { stage: 'createTray.loadIcon', ms: 4, sinceSpawnMs: 40 },
      { stage: 'createTray.newTray', ms: 5, sinceSpawnMs: 45 },
      { stage: 'createTray.decorate', ms: 6, sinceSpawnMs: 51 },
      { stage: 'createTray.buildMenu', ms: 7, sinceSpawnMs: 58 },
      { stage: 'createTray.attachMenu', ms: 8, sinceSpawnMs: 66 },
      { stage: 'createWindow.prewarm', ms: 9, sinceSpawnMs: 75 },
      { stage: 'createWindow.construct', ms: 10, sinceSpawnMs: 85 },
      { stage: 'createWindow.navigate', ms: 11, sinceSpawnMs: 96 },
      { stage: 'createWindow.firstShow', ms: 12, sinceSpawnMs: 108 },
      { stage: 'https://private.invalid/secret', ms: 13, sinceSpawnMs: 121 }
    ]
    const result = analyzeControlEvidence(report, profile())
    const notices = createReadbackNotices(result, {
      runId: SOURCE.runId,
      attempt: SOURCE.attempt,
      reportSha256: SOURCE.reportSha256,
      profileSha256: 'c'.repeat(64),
      archiveSha256: ARTIFACT.sha256
    })
    expect(notices).toHaveLength(7)
    const first = JSON.parse(notices[0].slice('::notice::'.length))
    expect(first).toMatchObject({
      candidateBuildRunId: SOURCE.runId,
      candidateInstallerSha256: 'd'.repeat(64),
      candidateDigestBinding: 'historical-provenance-report-only'
    })
    const boot = JSON.parse(notices[6].slice('::notice::'.length)).bootStages
    expect(boot.stages).toHaveLength(9)
    expect(boot.stages[0]).toMatchObject({ stage: 'createTray.loadIcon', durationMs: 4 })
    expect(boot).toMatchObject({ omittedCount: 1, coverageComplete: false })
    expect(JSON.stringify(notices)).not.toContain('https://private.invalid/secret')
    for (const notice of notices) expect(Buffer.byteLength(notice, 'utf8')).toBeLessThanOrEqual(3_500)
  })

  it('bounds notices and prevents untrusted profile/report strings from entering them', () => {
    const report = Object.assign(validReport(), {
      untrusted: '::error::private path /home/person/meeting transcript'
    })
    const result = analyzeControlEvidence(report, profile())
    const notices = createReadbackNotices(result, {
      runId: SOURCE.runId,
      attempt: SOURCE.attempt,
      reportSha256: SOURCE.reportSha256,
      profileSha256: 'c'.repeat(64),
      archiveSha256: ARTIFACT.sha256
    })
    expect(notices).toHaveLength(7)
    for (const notice of notices) expect(Buffer.byteLength(notice, 'utf8')).toBeLessThanOrEqual(3_500)
    const text = notices.join('\n')
    expect(text).toContain('not-established')
    expect(text).toContain('FAIL')
    expect(text).not.toContain('private://')
    expect(text).not.toContain('untrusted function name')
    expect(text).not.toContain('/home/person')
    expect(text).not.toContain('meeting transcript')
    expect(() =>
      createReadbackNotices(result, {
        runId: SOURCE.runId,
        attempt: SOURCE.attempt,
        reportSha256: 'a'.repeat(64),
        profileSha256: 'c'.repeat(64),
        archiveSha256: ARTIFACT.sha256
      })
    ).toThrow()

    const fullWindow = result.windows[0]
    const expanded = {
      ...result,
      windows: Array.from({ length: 8 }, () => ({
        ...fullWindow,
        selectors: [
          'worst-loop-since-last',
          'worst-loop-during-write',
          'worst-write',
          'worst-timely-write',
          'worst-dns',
          'worst-round-trip',
          'first-late-or-hung',
          'additional-late-or-hung',
          'threshold-violation'
        ],
        histogramCommandOverlaps: Array.from({ length: 4 }, (_, index) => ({
          command: ['enable', 'set-sampling-interval', 'start', 'stop'][index],
          observedWaitMs: 100_000,
          executionBoundKnown: true
        })),
        sampleRoundTripCommandOverlaps: Array.from({ length: 4 }, (_, index) => ({
          command: ['enable', 'set-sampling-interval', 'start', 'stop'][index],
          observedWaitMs: 100_000,
          executionBoundKnown: true
        }))
      }))
    }
    expect(() =>
      createReadbackNotices(expanded, {
        runId: SOURCE.runId,
        attempt: SOURCE.attempt,
        reportSha256: SOURCE.reportSha256,
        profileSha256: 'c'.repeat(64),
        archiveSha256: ARTIFACT.sha256
      })
    ).toThrow()
  })

  it('detects workflow runtime guards and retains the existing strict QA workflow unchanged', () => {
    const workflow = readFileSync(join(__dirname, '../../.github/workflows/st1-current-profile-readback.yml'), 'utf8')
    const strict = readFileSync(join(__dirname, '../../.github/workflows/qa-candidate.yml'), 'utf8')
    expect(workflow).toContain('      - m2/M2-0433-st1-current-profile-readback')
    expect(workflow).toContain("github.ref == 'refs/heads/m2/M2-0433-st1-current-profile-readback'")
    expect(workflow).toContain("github.event_name == 'push'")
    expect(workflow).toContain('  contents: read\n  actions: read')
    expect(workflow).toContain('    timeout-minutes: 5')
    expect(workflow).toContain('          persist-credentials: false')
    expect(workflow).toContain('node scripts/qa/st1-current-profile-readback.mjs')
    expect(findUnpinnedUses(workflow)).toEqual([])
    expect(strict).toContain('all(.[]; .pass == true)')
  })

  it('keeps the actual late, loop, write and lookup thresholds strict', () => {
    const clean = { samples: [{ writeMs: 249, lookupMs: 249 }], late: [], loop: { p99Ms: 49, maxMs: 249 } }
    expect(evaluateCriteria('none', clean, {}).every((criterion) => criterion.pass)).toBe(true)
    for (const [name, measured] of [
      ['no-late-samples', { ...clean, late: [{}] }],
      ['loop-p99 < 50', { ...clean, loop: { ...clean.loop, p99Ms: 50 } }],
      ['loop-max < 250', { ...clean, loop: { ...clean.loop, maxMs: 250 } }],
      ['async-write < 250', { ...clean, samples: [{ writeMs: 250, lookupMs: 249 }] }],
      ['dns-lookup < 250', { ...clean, samples: [{ writeMs: 249, lookupMs: 250 }] }]
    ]) {
      expect(evaluateCriteria('none', measured, {}).find((criterion) => criterion.name === name)?.pass).toBe(false)
    }
  })
})
