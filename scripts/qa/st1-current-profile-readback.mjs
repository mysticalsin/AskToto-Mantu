#!/usr/bin/env node
// Read one fixed failed ST-1 control artifact and publish only bounded, closed diagnostic notices.
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  closedFailure,
  decodeJson,
  getBytes,
  nativeCanary,
  readMembers,
  summarizeProfile,
  verifyArchiveBytes
} from './retained-profile-analysis.mjs'
import { annotationMessage } from './st1-evidence-notice.mjs'

const REPOSITORY = 'mysticalsin/AskToto-Mantu'
const REPOSITORY_ID = 1282463398
const MAX_NOTICE_BYTES = 3_500
const MAX_WINDOWS = 8
const MAX_BOOT_STAGES = 20
const MAX_WITNESS_INTERVALS = 4
const LOOP_LIMIT_MS = 250
const WRITE_LIMIT_MS = 250
const DNS_LIMIT_MS = 250
const P99_LIMIT_MS = 50
const TIMELINE_LIMIT = 512
const PROFILER_STATUSES = new Set(['answered', 'timed-out', 'error'])
const PROFILER_COMMANDS = ['enable', 'set-sampling-interval', 'start', 'stop']
const BOOT_STAGES = [
  'createTray.loadIcon',
  'createTray.loadIcon.fallback',
  'createTray.newTray',
  'createTray.decorate',
  'createTray.buildMenu',
  'createTray.attachMenu',
  'createWindow.prewarm',
  'createWindow.construct',
  'createWindow.navigate',
  'createWindow.firstShow'
]
const PROFILE_CATEGORIES = [
  'idle',
  'program',
  'gc',
  'window-create-view',
  'other-native-view',
  'tray-create',
  'tray-decorate',
  'sync-fs',
  'other'
]
const CRITERIA = [
  'inspector',
  'has-samples',
  'no-late-samples',
  'loop-p99 < 50',
  'loop-max < 250',
  'async-write < 250',
  'dns-lookup < 250'
]
const SAMPLE_SELECTORS = [
  'worst-loop-since-last',
  'worst-loop-during-write',
  'worst-write',
  'worst-timely-write',
  'worst-dns',
  'worst-round-trip',
  'first-late-or-hung',
  'additional-late-or-hung',
  'threshold-violation'
]
const PUBLIC_KEYS = new Set([
  'originalVerdict',
  'st1Evidence',
  'causalConclusion',
  'preProfileCause',
  'candidateBuildRunId',
  'candidateInstallerSha256',
  'candidateDigestBinding',
  'criteria',
  'name',
  'passed',
  'metrics',
  'sampleCount',
  'lateSampleCount',
  'loopP99Ms',
  'loopMaxMs',
  'timelyWriteMaxMs',
  'timelyDnsMaxMs',
  'violations',
  'loopP99Count',
  'globalLoopMaxCount',
  'loopSinceLastCount',
  'loopDuringWriteCount',
  'timelyWriteCount',
  'allObservedWriteCount',
  'timelyDnsCount',
  'allObservedDnsCount',
  'lateOrHungCount',
  'violatingWindowCount',
  'windows',
  'omittedWindowCount',
  'windowsCoverageComplete',
  'index',
  'stage',
  'selector',
  'selectors',
  'requestAtMs',
  'targetSettledAtMs',
  'observationEndAtMs',
  'status',
  'late',
  'hung',
  'histogram',
  'lowerBoundMs',
  'upperBoundMs',
  'boundsKnown',
  'sampleRoundTrip',
  'startMs',
  'endMs',
  'durationMs',
  'histogramCommandOverlaps',
  'sampleRoundTripCommandOverlaps',
  'command',
  'observedWaitMs',
  'executionBoundKnown',
  'metrics',
  'loopMaxSinceLastMs',
  'loopMaxDuringWriteMs',
  'writeMs',
  'dnsMs',
  'roundTripMs',
  'witness',
  'cpuBusyPct',
  'readRequestedAtMs',
  'readSettledAtMs',
  'writeStartedAtMs',
  'writeSettledAtMs',
  'setup',
  'commands',
  'summary',
  'profiler',
  'requestedAtMs',
  'settledAtMs',
  'startCommandUncertaintyMs',
  'profile',
  'profileBins',
  'firstBinIndex',
  'durationUs',
  'sampledDeltaUs',
  'unaccountedDurationUs',
  'maxSampleGapMs',
  'preProfileIntervalMs',
  'profilerStartIntervalMs',
  'profileEndIntervalMs',
  'profileStartExactMs',
  'coverageInterpretation',
  'categories',
  'category',
  'samples',
  'deltaUs',
  'firstOffsetUs',
  'lastOffsetUs',
  'bins',
  'targetIndex',
  'targetRequestAtMs',
  'coverageComplete',
  'intervals',
  'omittedIntervalCount',
  'probeWrites',
  'omittedProbeWriteCount',
  'startedAtMs',
  'withinTarget',
  'state',
  'stages',
  'occurrence',
  'sinceSpawnUpperBoundMs',
  'over250Ms',
  'omittedCount',
  'timingInterpretation'
])
const PUBLIC_STRINGS = new Set([
  'FAIL',
  'not-established',
  'unknown',
  'answered',
  'timed-out',
  'error',
  'pending',
  'settled',
  'available',
  'unavailable',
  'sampled-deltas-not-exclusive-cpu-time',
  'since-spawn-is-upper-bound-on-stage-end',
  'historical-provenance-report-only',
  ...CRITERIA,
  ...PROFILER_COMMANDS,
  ...SAMPLE_SELECTORS,
  ...PROFILE_CATEGORIES,
  ...BOOT_STAGES
])

export const SOURCE = Object.freeze({
  repository: REPOSITORY,
  repositoryId: REPOSITORY_ID,
  runId: 38540537307,
  attempt: 1,
  workflowPath: '.github/workflows/qa-candidate.yml',
  event: 'pull_request',
  status: 'completed',
  conclusion: 'failure',
  headSha: '7dee50c75c8b6598153a4859de9283c83871179d',
  headBranch: 'fix/metis-release-readiness',
  measuredCommit: '52325a32d30d94ec9fdd1ec913cfe36a248ac719',
  reportSha256: 'a4c84aa6199a10d6d9ee869141193c31e9cc6a6d973144ee2664fe4e263c645e'
})

export const ARTIFACT = Object.freeze({
  id: 11883369704,
  name: 'st-1-macos-control',
  size: 156608,
  sha256: '864d306b3cfd3388d5ecfe61e9563ed89d757eaf3ca01c3cbbe8621a9abbe598',
  reportName: 'st-1-macos-none.json',
  profileName: 'st-1-macos-none.cpuprofile',
  reportCap: 4 * 1024 ** 2,
  profileCap: 8 * 1024 ** 2
})

const plain = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
const safeHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const localFailures = new WeakMap()
const PUBLIC_FAILURE_CODES = new Set(['summary-invalid', 'notice-too-large', 'digest-mismatch'])
const readbackFailureCode = (error) => {
  const localCode = error instanceof Error ? localFailures.get(error) : undefined
  return PUBLIC_FAILURE_CODES.has(localCode) ? localCode : closedFailure(error)
}
const fail = (code) => {
  const error = new Error(code)
  localFailures.set(error, code)
  error.code = code
  throw error
}
const requireValue = (condition, code = 'readback-invalid') => {
  if (!condition) fail(code)
}

export function verifyRunMetadata(run) {
  requireValue(
    run?.id === SOURCE.runId &&
      run.path === SOURCE.workflowPath &&
      run.event === SOURCE.event &&
      run.run_attempt === SOURCE.attempt &&
      run.status === SOURCE.status &&
      run.conclusion === SOURCE.conclusion &&
      run.head_sha === SOURCE.headSha &&
      run.head_branch === SOURCE.headBranch &&
      run.repository?.id === SOURCE.repositoryId &&
      run.repository?.full_name === SOURCE.repository &&
      run.head_repository?.id === SOURCE.repositoryId &&
      run.head_repository?.full_name === SOURCE.repository,
    'run-mismatch'
  )
  return true
}

export function verifyArtifactMetadata(artifact, nowMs = Date.now()) {
  const expiresAt = typeof artifact?.expires_at === 'string' ? Date.parse(artifact.expires_at) : Number.NaN
  requireValue(
    artifact?.id === ARTIFACT.id &&
      artifact.name === ARTIFACT.name &&
      artifact.size_in_bytes === ARTIFACT.size &&
      artifact.digest === `sha256:${ARTIFACT.sha256}` &&
      artifact.expired === false &&
      Number.isFinite(expiresAt) &&
      expiresAt > nowMs &&
      artifact.workflow_run?.id === SOURCE.runId &&
      artifact.workflow_run?.repository_id === SOURCE.repositoryId &&
      artifact.workflow_run?.head_repository_id === SOURCE.repositoryId &&
      artifact.workflow_run?.head_sha === SOURCE.headSha,
    'artifact-mismatch'
  )
  return true
}

export function verifyReportDigest(reportSha256) {
  requireValue(reportSha256 === SOURCE.reportSha256, 'report-digest-mismatch')
  return true
}

function validateTiming(value) {
  return (
    plain(value) &&
    finite(value.requestedAtMs) &&
    finite(value.settledAtMs) &&
    value.settledAtMs >= value.requestedAtMs &&
    PROFILER_STATUSES.has(value.status)
  )
}

function validateDiagnostics(value) {
  requireValue(
    plain(value) &&
      value.version === 1 &&
      validateTiming(value.setup) &&
      validateTiming(value.summary) &&
      Array.isArray(value.profilerCommands) &&
      value.profilerCommands.length === PROFILER_COMMANDS.length,
    'diagnostics-invalid'
  )
  let previousSettledAtMs = -1
  value.profilerCommands.forEach((entry, index) => {
    requireValue(
      validateTiming(entry) && entry.command === PROFILER_COMMANDS[index] && entry.requestedAtMs >= previousSettledAtMs,
      'diagnostics-invalid'
    )
    previousSettledAtMs = entry.settledAtMs
  })
}

function validateSample(sample, previousTMs) {
  requireValue(
    plain(sample) &&
      finite(sample.tMs) &&
      sample.tMs >= previousTMs &&
      finite(sample.requestAtMs) &&
      finite(sample.settledAtMs) &&
      sample.settledAtMs >= sample.requestAtMs &&
      PROFILER_STATUSES.has(sample.diagnosticStatus) &&
      (sample.late === undefined || sample.late === true) &&
      (sample.hung === undefined || sample.hung === true),
    'sample-invalid'
  )
  for (const key of ['writeMs', 'lookupMs', 'loopMaxSinceLastMs', 'loopMaxDuringWriteMs']) {
    requireValue(sample[key] === undefined || finite(sample[key]), 'sample-invalid')
  }
  requireValue(
    (sample.histogramLowerBoundMs === null || finite(sample.histogramLowerBoundMs)) &&
      (sample.histogramUpperBoundMs === null || finite(sample.histogramUpperBoundMs)) &&
      typeof sample.histogramBoundsKnown === 'boolean' &&
      (!sample.histogramBoundsKnown ||
        (finite(sample.histogramLowerBoundMs) &&
          finite(sample.histogramUpperBoundMs) &&
          sample.histogramUpperBoundMs >= sample.histogramLowerBoundMs)),
    'sample-invalid'
  )
  if (sample.witness !== undefined) {
    requireValue(plain(sample.witness), 'sample-invalid')
    for (const key of [
      'loopMaxSinceLastMs',
      'writeMs',
      'cpuBusyPct',
      'readRequestedAtMs',
      'readSettledAtMs',
      'writeStartedAtMs',
      'writeSettledAtMs'
    ]) {
      requireValue(
        sample.witness[key] === undefined || sample.witness[key] === null || finite(sample.witness[key]),
        'sample-invalid'
      )
    }
    if (finite(sample.witness.readRequestedAtMs) && finite(sample.witness.readSettledAtMs)) {
      requireValue(sample.witness.readSettledAtMs >= sample.witness.readRequestedAtMs, 'sample-invalid')
    }
    if (finite(sample.witness.writeStartedAtMs) && finite(sample.witness.writeSettledAtMs)) {
      requireValue(sample.witness.writeSettledAtMs >= sample.witness.writeStartedAtMs, 'sample-invalid')
    }
  }
}

export function verifyReportScope(report) {
  requireValue(
    plain(report) &&
      report.harness === 'ST-1' &&
      report.row === 'none' &&
      report.platform === 'darwin' &&
      report.arch === 'arm64' &&
      report.minutes === 5 &&
      report.complete === true &&
      report.verdict === 'FAIL' &&
      plain(report.teardown) &&
      report.teardown.state === 'acknowledged' &&
      report.samples === 294 &&
      report.lateSamples === 1 &&
      plain(report.loop) &&
      report.loop.p99Ms === 18.694143 &&
      report.loop.maxMs === 909.639679 &&
      plain(report.write) &&
      report.write.maxMs === 385.9653330000001 &&
      plain(report.lookup) &&
      report.lookup.maxMs === 14.035041999999521 &&
      Array.isArray(report.criteria) &&
      report.criteria.length === CRITERIA.length &&
      Array.isArray(report.timeline) &&
      report.timeline.length === report.samples + report.lateSamples &&
      report.timeline.length <= TIMELINE_LIMIT &&
      plain(report.cpuProfile) &&
      report.cpuProfile.file === ARTIFACT.profileName &&
      report.cpuProfile.running === false &&
      report.cpuProfile.error === undefined &&
      [
        report.cpuProfile.requestedAtMs,
        report.cpuProfile.answeredAtMs,
        report.cpuProfile.startedAtMs,
        report.cpuProfile.stoppedAtMs
      ].every(finite) &&
      report.cpuProfile.requestedAtMs <= report.cpuProfile.answeredAtMs &&
      report.cpuProfile.startedAtMs === report.cpuProfile.answeredAtMs &&
      report.cpuProfile.answeredAtMs < report.cpuProfile.stoppedAtMs,
    'report-scope-mismatch'
  )
  requireValue(
    report.build_run_id === SOURCE.runId && safeHash(report.artifact_sha256),
    'report-candidate-provenance-invalid'
  )
  const criteria = new Map()
  for (const criterion of report.criteria) {
    requireValue(
      plain(criterion) &&
        CRITERIA.includes(criterion.name) &&
        typeof criterion.pass === 'boolean' &&
        !criteria.has(criterion.name),
      'report-scope-mismatch'
    )
    criteria.set(criterion.name, criterion.pass)
  }
  requireValue(
    criteria.size === CRITERIA.length &&
      criteria.get('inspector') === true &&
      criteria.get('has-samples') === true &&
      criteria.get('no-late-samples') === false &&
      criteria.get('loop-p99 < 50') === true &&
      criteria.get('loop-max < 250') === false &&
      criteria.get('async-write < 250') === false &&
      criteria.get('dns-lookup < 250') === true,
    'report-scope-mismatch'
  )
  validateDiagnostics(report.profilerDiagnostics)
  let previousTMs = -1
  let lateCount = 0
  let timelyCount = 0
  for (const sample of report.timeline) {
    validateSample(sample, previousTMs)
    previousTMs = sample.tMs
    if (sample.late === true || sample.hung === true) lateCount++
    else timelyCount++
  }
  requireValue(timelyCount === report.samples && lateCount === report.lateSamples, 'report-scope-mismatch')
  return true
}

function projectedTiming(value) {
  return {
    requestedAtMs: value.requestedAtMs,
    settledAtMs: value.settledAtMs,
    status: value.status
  }
}

function metric(sample, key) {
  return finite(sample[key]) ? sample[key] : null
}

function addSelection(map, index, selector) {
  if (!map.has(index)) map.set(index, [])
  const selectors = map.get(index)
  if (!selectors.includes(selector)) selectors.push(selector)
}

function indexOfMax(samples, selector, valueFn, predicate = () => true) {
  let result = -1
  let maximum = -Infinity
  for (let index = 0; index < samples.length; index++) {
    if (!predicate(samples[index])) continue
    const value = valueFn(samples[index])
    if (finite(value) && value > maximum) {
      maximum = value
      result = index
    }
  }
  return result
}

function violationSummary(report) {
  const rows = report.timeline
  const timely = rows.filter((sample) => sample.late !== true && sample.hung !== true)
  const count = (entries, key, limit) => entries.filter((sample) => finite(sample[key]) && sample[key] >= limit).length
  const sampleViolations = rows
    .map((sample, index) => ({ sample, index }))
    .filter(
      ({ sample }) =>
        sample.late === true ||
        sample.hung === true ||
        (finite(sample.loopMaxSinceLastMs) && sample.loopMaxSinceLastMs >= LOOP_LIMIT_MS) ||
        (finite(sample.loopMaxDuringWriteMs) && sample.loopMaxDuringWriteMs >= LOOP_LIMIT_MS) ||
        (finite(sample.writeMs) && sample.writeMs >= WRITE_LIMIT_MS) ||
        (finite(sample.lookupMs) && sample.lookupMs >= DNS_LIMIT_MS)
    )
    .map(({ index }) => index)
  return {
    loopP99Count: report.loop.p99Ms >= P99_LIMIT_MS ? 1 : 0,
    globalLoopMaxCount: report.loop.maxMs >= LOOP_LIMIT_MS ? 1 : 0,
    loopSinceLastCount: count(rows, 'loopMaxSinceLastMs', LOOP_LIMIT_MS),
    loopDuringWriteCount: count(rows, 'loopMaxDuringWriteMs', LOOP_LIMIT_MS),
    timelyWriteCount: count(timely, 'writeMs', WRITE_LIMIT_MS),
    allObservedWriteCount: count(rows, 'writeMs', WRITE_LIMIT_MS),
    timelyDnsCount: count(timely, 'lookupMs', DNS_LIMIT_MS),
    allObservedDnsCount: count(rows, 'lookupMs', DNS_LIMIT_MS),
    lateOrHungCount: rows.filter((sample) => sample.late === true || sample.hung === true).length,
    violatingWindowCount: sampleViolations.length,
    violatingIndices: sampleViolations
  }
}

function selectWindows(report, violations) {
  const rows = report.timeline
  const selected = new Map()
  const picks = [
    ['worst-loop-since-last', (sample) => sample.loopMaxSinceLastMs],
    ['worst-loop-during-write', (sample) => sample.loopMaxDuringWriteMs],
    ['worst-write', (sample) => sample.writeMs],
    ['worst-timely-write', (sample) => sample.writeMs, (sample) => sample.late !== true && sample.hung !== true],
    ['worst-dns', (sample) => sample.lookupMs],
    [
      'worst-round-trip',
      (sample) => sample.settledAtMs - sample.requestAtMs,
      (sample) => sample.diagnosticStatus === 'answered'
    ]
  ]
  for (const [selector, value, predicate] of picks) {
    const index = indexOfMax(rows, selector, value, predicate)
    if (index >= 0) addSelection(selected, index, selector)
  }
  const lateIndices = rows.flatMap((sample, index) => (sample.late === true || sample.hung === true ? [index] : []))
  lateIndices.forEach((index, ordinal) =>
    addSelection(selected, index, ordinal === 0 ? 'first-late-or-hung' : 'additional-late-or-hung')
  )
  for (const index of violations.violatingIndices) addSelection(selected, index, 'threshold-violation')
  const all = [...selected.entries()]
  const included = all.slice(0, MAX_WINDOWS)
  const omitted = all.length - included.length
  const windows = included.map(([index, selectors]) =>
    projectWindow(rows[index], index, selectors, report.profilerDiagnostics)
  )
  return { windows, omitted, coverageComplete: omitted === 0 }
}

function overlaps(bounds, commands) {
  if (!bounds) return []
  return commands.flatMap((command) => {
    const unknown = command.status === 'timed-out'
    const intersects = unknown
      ? command.requestedAtMs <= bounds[1]
      : command.requestedAtMs <= bounds[1] && command.settledAtMs >= bounds[0]
    return intersects
      ? [
          {
            command: command.command,
            observedWaitMs: command.settledAtMs - command.requestedAtMs,
            executionBoundKnown: !unknown
          }
        ]
      : []
  })
}

function projectWindow(sample, index, selectors, diagnostics) {
  const targetCompleted = sample.diagnosticStatus === 'answered'
  const trip = targetCompleted ? [sample.requestAtMs, sample.settledAtMs] : null
  const histogram =
    sample.histogramBoundsKnown === true ? [sample.histogramLowerBoundMs, sample.histogramUpperBoundMs] : null
  const witness = plain(sample.witness) ? sample.witness : {}
  const projected = {
    index,
    selector: selectors.includes('first-late-or-hung') ? 'first-late-or-hung' : selectors[0],
    selectors,
    requestAtMs: sample.requestAtMs,
    targetSettledAtMs: targetCompleted ? sample.settledAtMs : null,
    observationEndAtMs: sample.settledAtMs,
    status: sample.diagnosticStatus,
    late: sample.late === true,
    hung: sample.hung === true,
    histogram: {
      lowerBoundMs: sample.histogramLowerBoundMs ?? null,
      upperBoundMs: sample.histogramUpperBoundMs ?? null,
      boundsKnown: sample.histogramBoundsKnown === true
    },
    sampleRoundTrip: trip ? { startMs: trip[0], endMs: trip[1], durationMs: trip[1] - trip[0] } : null,
    histogramCommandOverlaps: overlaps(histogram, diagnostics.profilerCommands),
    sampleRoundTripCommandOverlaps: overlaps(trip, diagnostics.profilerCommands),
    metrics: {
      loopMaxSinceLastMs: metric(sample, 'loopMaxSinceLastMs'),
      loopMaxDuringWriteMs: metric(sample, 'loopMaxDuringWriteMs'),
      writeMs: metric(sample, 'writeMs'),
      dnsMs: metric(sample, 'lookupMs'),
      roundTripMs: trip ? trip[1] - trip[0] : null
    },
    witness: {
      loopMaxSinceLastMs: metric(witness, 'loopMaxSinceLastMs'),
      cpuBusyPct: metric(witness, 'cpuBusyPct'),
      readRequestedAtMs: metric(witness, 'readRequestedAtMs'),
      readSettledAtMs: metric(witness, 'readSettledAtMs'),
      writeStartedAtMs: metric(witness, 'writeStartedAtMs'),
      writeSettledAtMs: metric(witness, 'writeSettledAtMs'),
      writeMs: metric(witness, 'writeMs')
    }
  }
  return projected
}

function witnessProjection(report, target) {
  const rows = report.timeline
    .map((sample, index) => ({ sample, index, witness: sample.witness }))
    .filter(({ witness }) => plain(witness) && finite(witness.readRequestedAtMs) && finite(witness.readSettledAtMs))
    .sort((left, right) => left.witness.readRequestedAtMs - right.witness.readRequestedAtMs || left.index - right.index)
  const intervals = []
  for (let index = 1; index < rows.length; index++) {
    const previous = rows[index - 1]
    const current = rows[index]
    const startMs = previous.witness.readSettledAtMs
    const endMs = current.witness.readRequestedAtMs
    if (endMs < startMs) continue
    const intersects = endMs >= target.requestAtMs && startMs <= target.settledAtMs
    if (!intersects) continue
    intervals.push({
      index: current.index,
      startMs,
      endMs,
      loopMaxSinceLastMs: metric(current.witness, 'loopMaxSinceLastMs'),
      cpuBusyPct: metric(current.witness, 'cpuBusyPct')
    })
  }
  let cursor = target.requestAtMs
  for (const interval of intervals) {
    if (interval.startMs > cursor) break
    cursor = Math.max(cursor, interval.endMs)
  }
  const covered = target.diagnosticStatus === 'answered' && cursor >= target.settledAtMs
  const neighboringIndices = new Set(intervals.map((interval) => interval.index))
  neighboringIndices.add(report.timeline.indexOf(target))
  const probeWrites = rows.flatMap(({ index, witness }) => {
    if (!neighboringIndices.has(index)) return []
    if (!finite(witness.writeStartedAtMs)) return []
    const settled = finite(witness.writeSettledAtMs) ? witness.writeSettledAtMs : null
    const withinTarget =
      (settled === null && witness.writeStartedAtMs <= target.settledAtMs) ||
      (settled !== null && witness.writeStartedAtMs <= target.settledAtMs && settled >= target.requestAtMs)
    return [
      {
        index,
        status: settled === null ? 'pending' : 'settled',
        startedAtMs: witness.writeStartedAtMs,
        settledAtMs: settled,
        writeMs: metric(witness, 'writeMs'),
        withinTarget
      }
    ]
  })
  return {
    targetIndex: report.timeline.indexOf(target),
    targetRequestAtMs: target.requestAtMs,
    targetSettledAtMs: target.diagnosticStatus === 'answered' ? target.settledAtMs : null,
    coverageComplete: covered,
    intervals: intervals.slice(0, MAX_WITNESS_INTERVALS),
    omittedIntervalCount: Math.max(0, intervals.length - MAX_WITNESS_INTERVALS),
    probeWrites: probeWrites.slice(0, MAX_WITNESS_INTERVALS),
    omittedProbeWriteCount: Math.max(0, probeWrites.length - MAX_WITNESS_INTERVALS)
  }
}

function profileProjection(report, profile, firstLate, peakObservation) {
  const firstLateObservation = firstLate
    ? {
        tMs: firstLate.requestAtMs,
        answeredMs: firstLate.diagnosticStatus === 'answered' ? firstLate.settledAtMs - firstLate.requestAtMs : null
      }
    : null
  const peak = peakObservation
    ? {
        tMs: peakObservation.requestAtMs,
        answeredMs:
          peakObservation.diagnosticStatus === 'answered'
            ? peakObservation.settledAtMs - peakObservation.requestAtMs
            : null
      }
    : null
  let summary
  try {
    summary = summarizeProfile(profile, report.cpuProfile, { firstLate: firstLateObservation, peakObservation: peak })
  } catch {
    fail('profile-invalid')
  }
  const maxGapUs = profile.timeDeltas.reduce((maximum, value) => Math.max(maximum, value), 0)
  const start = report.cpuProfile.requestedAtMs
  const answered = report.cpuProfile.answeredAtMs
  const durationMs = summary.durationUs / 1000
  return {
    durationUs: summary.durationUs,
    sampledDeltaUs: summary.deltaUs,
    unaccountedDurationUs: summary.residualUs,
    sampleCount: summary.samples,
    maxSampleGapMs: maxGapUs / 1000,
    preProfileIntervalMs: [0, start],
    profilerStartIntervalMs: [start, answered],
    profileEndIntervalMs: [start + durationMs, answered + durationMs],
    profileStartExactMs: null,
    coverageInterpretation: 'sampled-deltas-not-exclusive-cpu-time',
    preProfileCause: 'unknown',
    candidateBuildRunId: report.build_run_id,
    candidateInstallerSha256: report.artifact_sha256,
    candidateDigestBinding: 'historical-provenance-report-only',
    categories: summary.categories.map(({ category, samples, deltaUs, firstOffsetUs, lastOffsetUs }) => ({
      category,
      samples,
      deltaUs,
      firstOffsetUs,
      lastOffsetUs
    })),
    bins: summary.bins
  }
}

function bootProjection(report) {
  const input = plain(report.bootStages) && Array.isArray(report.bootStages.stages) ? report.bootStages.stages : null
  if (!input) return { state: 'unavailable', stages: [], omittedCount: 0, coverageComplete: false }
  const stages = []
  let rejectedCount = 0
  for (const item of input) {
    if (!plain(item) || !BOOT_STAGES.includes(item.stage) || !finite(item.ms) || !finite(item.sinceSpawnMs)) {
      rejectedCount++
      continue
    }
    stages.push({
      stage: item.stage,
      occurrence: stages.filter((stage) => stage.stage === item.stage).length,
      durationMs: item.ms,
      sinceSpawnUpperBoundMs: item.sinceSpawnMs,
      over250Ms: item.ms >= 250
    })
  }
  return {
    state: 'available',
    stages: stages.slice(0, MAX_BOOT_STAGES),
    omittedCount: rejectedCount + Math.max(0, stages.length - MAX_BOOT_STAGES),
    coverageComplete: rejectedCount === 0 && stages.length <= MAX_BOOT_STAGES,
    timingInterpretation: 'since-spawn-is-upper-bound-on-stage-end'
  }
}

export function analyzeControlEvidence(report, profile) {
  verifyReportScope(report)
  requireValue(plain(profile), 'profile-invalid')
  const violation = violationSummary(report)
  const selected = selectWindows(report, violation)
  const windows = selected.windows
  const firstLate = report.timeline.find((sample) => sample.late === true || sample.hung === true) ?? null
  const worstLoopIndex = indexOfMax(report.timeline, 'worst-loop-since-last', (sample) =>
    Math.max(sample.loopMaxSinceLastMs ?? -1, sample.loopMaxDuringWriteMs ?? -1)
  )
  const peakObservation = worstLoopIndex >= 0 ? report.timeline[worstLoopIndex] : null
  const profileData = profileProjection(report, profile, firstLate, peakObservation)
  const witness = firstLate
    ? witnessProjection(report, firstLate)
    : { coverageComplete: false, intervals: [], probeWrites: [] }
  const diagnostics = report.profilerDiagnostics
  return {
    originalVerdict: 'FAIL',
    st1Evidence: false,
    causalConclusion: 'not-established',
    preProfileCause: 'unknown',
    criteria: CRITERIA.map((name) => ({
      name,
      passed: report.criteria.find((criterion) => criterion.name === name).pass
    })),
    metrics: {
      sampleCount: report.samples,
      lateSampleCount: report.lateSamples,
      loopP99Ms: report.loop.p99Ms,
      loopMaxMs: report.loop.maxMs,
      timelyWriteMaxMs: report.write.maxMs,
      timelyDnsMaxMs: report.lookup.maxMs
    },
    violations: {
      loopP99Count: violation.loopP99Count,
      globalLoopMaxCount: violation.globalLoopMaxCount,
      loopSinceLastCount: violation.loopSinceLastCount,
      loopDuringWriteCount: violation.loopDuringWriteCount,
      timelyWriteCount: violation.timelyWriteCount,
      allObservedWriteCount: violation.allObservedWriteCount,
      timelyDnsCount: violation.timelyDnsCount,
      allObservedDnsCount: violation.allObservedDnsCount,
      lateOrHungCount: violation.lateOrHungCount,
      violatingWindowCount: violation.violatingWindowCount
    },
    windows,
    omittedWindowCount: selected.omitted,
    windowsCoverageComplete: selected.coverageComplete,
    profiler: {
      setup: projectedTiming(diagnostics.setup),
      commands: diagnostics.profilerCommands.map((entry) => ({ command: entry.command, ...projectedTiming(entry) })),
      summary: projectedTiming(diagnostics.summary),
      startCommandUncertaintyMs: (() => {
        const command = diagnostics.profilerCommands.find((entry) => entry.command === 'start')
        return [command.requestedAtMs, command.settledAtMs]
      })()
    },
    profile: profileData,
    witness,
    bootStages: bootProjection(report)
  }
}

function validateDigestContext(context) {
  requireValue(
    plain(context) &&
      context.runId === SOURCE.runId &&
      context.attempt === SOURCE.attempt &&
      context.reportSha256 === SOURCE.reportSha256 &&
      context.archiveSha256 === ARTIFACT.sha256 &&
      safeHash(context.profileSha256),
    'digest-mismatch'
  )
}

function publicParts(summary) {
  const {
    bins,
    candidateBuildRunId,
    candidateInstallerSha256,
    candidateDigestBinding,
    ...profile
  } = summary.profile
  return [
    {
      originalVerdict: summary.originalVerdict,
      st1Evidence: summary.st1Evidence,
      causalConclusion: summary.causalConclusion,
      preProfileCause: summary.preProfileCause,
      candidateBuildRunId,
      candidateInstallerSha256,
      candidateDigestBinding,
      criteria: summary.criteria,
      metrics: summary.metrics,
      violations: summary.violations,
      profiler: summary.profiler
    },
    {
      windows: summary.windows.slice(0, 4),
      omittedWindowCount: summary.omittedWindowCount,
      windowsCoverageComplete: summary.windowsCoverageComplete
    },
    { windows: summary.windows.slice(4, 8), windowsCoverageComplete: summary.windowsCoverageComplete },
    { profile },
    { profileBins: bins.slice(0, 10), firstBinIndex: 0 },
    { profileBins: bins.slice(10, 20), firstBinIndex: 10 },
    { witness: summary.witness, bootStages: summary.bootStages }
  ]
}

export function createReadbackNotices(summary, context) {
  validateDigestContext(context)
  requireValue(
    plain(summary) &&
      summary.originalVerdict === 'FAIL' &&
      summary.st1Evidence === false &&
      summary.causalConclusion === 'not-established' &&
      summary.preProfileCause === 'unknown' &&
      Array.isArray(summary.windows) &&
      summary.windows.length <= MAX_WINDOWS,
    'summary-invalid'
  )
  validatePublicTree(summary)
  const parts = publicParts(summary)
  const summarySha256 = sha256(Buffer.from(JSON.stringify(parts), 'utf8'))
  const notices = parts.map((part, index) => {
    const payload = {
      schema: 1,
      runId: context.runId,
      attempt: context.attempt,
      sourceHeadSha: SOURCE.headSha,
      measuredCommit: SOURCE.measuredCommit,
      artifactSha256: context.archiveSha256,
      reportSha256: context.reportSha256,
      profileSha256: context.profileSha256,
      originalVerdict: 'FAIL',
      st1Evidence: false,
      causalConclusion: 'not-established',
      summarySha256,
      part: index + 1,
      partCount: parts.length,
      ...part
    }
    const notice = annotationMessage(payload)
    requireValue(Buffer.byteLength(notice, 'utf8') <= MAX_NOTICE_BYTES, 'notice-too-large')
    return notice
  })
  return notices
}

function validatePublicTree(value, depth = 0, key = undefined) {
  requireValue(depth <= 10, 'summary-invalid')
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'number') {
    requireValue(Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER, 'summary-invalid')
    return
  }
  if (typeof value === 'string') {
    requireValue(
      PUBLIC_STRINGS.has(value) || (key === 'candidateInstallerSha256' && safeHash(value)),
      'summary-invalid'
    )
    return
  }
  if (Array.isArray(value)) {
    requireValue(value.length <= 512, 'summary-invalid')
    for (const item of value) validatePublicTree(item, depth + 1)
    return
  }
  requireValue(plain(value) && Object.keys(value).length <= 64, 'summary-invalid')
  for (const [key, item] of Object.entries(value)) {
    requireValue(PUBLIC_KEYS.has(key), 'summary-invalid')
    validatePublicTree(item, depth + 1, key)
  }
}

let readbackStage = 'owner'

async function main() {
  const env = process.env
  requireValue(
    process.platform === 'linux' &&
      env.CI === 'true' &&
      env.GITHUB_ACTIONS === 'true' &&
      env.GITHUB_REPOSITORY === REPOSITORY &&
      env.GITHUB_EVENT_NAME === 'push' &&
      env.GITHUB_REF === 'refs/heads/m2/M2-0433-st1-current-profile-readback' &&
      env.GH_TOKEN &&
      isAbsolute(env.RUNNER_TEMP ?? '') &&
      process.argv.length === 2,
    'owner-state-invalid'
  )
  const deadline = performance.now() + 240_000
  const directory = mkdtempSync(join(env.RUNNER_TEMP, 'st1-current-profile-readback-'))
  chmodSync(directory, 0o700)
  let cleanupAllowed = true
  try {
    readbackStage = 'canary'
    await nativeCanary(directory, deadline)
    const json = async (route) =>
      decodeJson(await getBytes(route, { cap: 64 * 1024, deadline, token: env.GH_TOKEN }), 64 * 1024)
    readbackStage = 'run-metadata'
    verifyRunMetadata(await json(`runs/${SOURCE.runId}`))
    readbackStage = 'artifact-metadata'
    const artifact = await json(`artifacts/${ARTIFACT.id}`)
    verifyArtifactMetadata(artifact)
    readbackStage = 'archive-download'
    const archive = await getBytes(`artifacts/${ARTIFACT.id}/zip`, {
      cap: ARTIFACT.size,
      deadline,
      token: env.GH_TOKEN
    })
    readbackStage = 'archive-verification'
    verifyArchiveBytes(archive, { size: ARTIFACT.size, sha: ARTIFACT.sha256 })
    const archivePath = join(directory, 'control.zip')
    writeFileSync(archivePath, archive, { flag: 'wx', mode: 0o600 })
    readbackStage = 'archive-members'
    const members = await readMembers(
      archivePath,
      { [ARTIFACT.reportName]: ARTIFACT.reportCap, [ARTIFACT.profileName]: ARTIFACT.profileCap },
      { size: ARTIFACT.size, sha: ARTIFACT.sha256 },
      directory,
      deadline
    )
    readbackStage = 'report-verification'
    verifyReportDigest(members[ARTIFACT.reportName].sha)
    const report = members[ARTIFACT.reportName].value
    const profile = members[ARTIFACT.profileName].value
    verifyReportScope(report)
    readbackStage = 'profile-analysis'
    const summary = analyzeControlEvidence(report, profile)
    readbackStage = 'public-summary'
    const notices = createReadbackNotices(summary, {
      runId: SOURCE.runId,
      attempt: SOURCE.attempt,
      reportSha256: SOURCE.reportSha256,
      profileSha256: members[ARTIFACT.profileName].sha,
      archiveSha256: ARTIFACT.sha256
    })
    requireValue(performance.now() < deadline, 'deadline')
    process.stdout.write(`${notices.join('\n')}\n`)
  } catch (error) {
    cleanupAllowed = closedFailure(error) !== 'native-unacknowledged'
    throw error
  } finally {
    if (cleanupAllowed) rmSync(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(
      `::error title=ST-1 readback failure::stage=${readbackStage};code=${readbackFailureCode(error)}\n`
    )
    process.exitCode = 1
  })
}
