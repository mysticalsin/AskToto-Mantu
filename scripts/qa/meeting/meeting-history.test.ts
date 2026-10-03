import { describe, expect, it } from 'vitest'
import {
  HISTORY_COMPLETION_FRACTION,
  STRICT_BUDGET_MS,
  assertContentFreeReport,
  activeKindsFromNdjson,
  buildMeetingHistoryReport,
  classifyDriverError,
  deriveLlamaCause,
  deriveThemChannel,
  evaluateMeetingGrowth,
  filteredHistoryRendered,
  hostMemorySnapshot,
  judgeMeetingHistory,
  mergeCensusStreams,
  summarizeAuditEvidence,
  scheduleHistoryCycles
} from './meeting-history.mjs'

const MIB = 1024 * 1024
const MINUTE_MS = 60_000
const START = '2026-10-01T08:00:00.000Z'

const cleanObserved = (overrides: Record<string, unknown> = {}) => ({
  hostFloorOverride: true,
  hostMemory: { totalBytes: 10, freeBytes: 5 },
  asrEngine: 'whisper',
  auditEvent: true,
  meetingFilesBefore: 2,
  meetingFilesAfter: 3,
  savedBytes: 800,
  historyRowsBefore: 2,
  historyRowsAfter: 3,
  maxLines: 12,
  linesReachedMs: 30_000,
  mainLoop: { p99Ms: 12, maxMs: 40 },
  samples: [
    { index: 0, tMs: 0, loopMaxSinceLastMs: 20, writeMs: 5, lookupMs: 4, resources: { Timeout: 2 } },
    { index: 1, tMs: 5_000, loopMaxSinceLastMs: 30, writeMs: 6, lookupMs: 4, resources: { TCPWrap: 1 } }
  ],
  historyActions: [
    {
      index: 0,
      tMs: 30_000,
      durationMs: 100,
      outcome: 'completed',
      loopMaxMs: 20,
      linesBefore: 3,
      linesAfter: 5,
      listRendered: true,
      searchRendered: true,
      rowOpened: true
    }
  ],
  sidecars: { 'whisper-utility': true, 'speaker-utility': false, 'llama-server': false, 'sidecar-supervisor': true },
  sidecarCauses: { 'llama-server': 'not-observed' },
  themChannel: { active: false, cause: 'mic-only-configuration' },
  auditEvidence: { events: {}, floorOverrides: [], captureFailures: [] },
  profile: { kind: 'representative-synthetic', meetingCount: 59, layout: 'bar' },
  timingNotes: { mainLoopWindow: 'capture-start-through-stop' },
  census: { active: { code: 0 }, post: { code: 0 } },
  growth: { outcome: 'PASS' },
  ...overrides
})

type Proc = { pid: number; kind: string; mib: number; cpuSeconds?: number; startedMs?: number }

const steady = (rate: number, tMin: number) => rate * tMin * 60

function base(tMin: number): Proc[] {
  return [
    { pid: 100, kind: 'main', mib: 400, cpuSeconds: steady(0.02, tMin) },
    { pid: 101, kind: 'renderer', mib: 250 + Math.max(0, Math.min(tMin, 60) - 5), cpuSeconds: steady(0.005, tMin) },
    { pid: 102, kind: 'gpu', mib: 120, cpuSeconds: steady(0.003, tMin) },
    { pid: 103, kind: 'utility', mib: 40, cpuSeconds: steady(0.001, tMin) },
    ...(tMin < 60
      ? [
          { pid: 400, kind: 'parakeet-utility', mib: 150 },
          { pid: 401, kind: 'speaker-utility', mib: 80 }
        ]
      : [])
  ]
}

function stream({ minutes, offsetMinutes = 0 }: { minutes: number; offsetMinutes?: number }): string {
  const lines: object[] = [
    { record: 'header', schema: 'census-stream/1', state: 'active-transcription', platform: 'darwin', productVersion: '1.9.7', mainPid: 100, intervalMs: 30_000, startedAt: START, profileKind: 'representative-synthetic' }
  ]
  let count = 0
  for (let index = 0, tMs = 0; tMs < minutes * MINUTE_MS; index += 1, tMs += 30_000) {
    const tMin = offsetMinutes + tMs / MINUTE_MS
    const bytes = (proc: Proc) => Math.round(proc.mib * MIB)
    lines.push({
      record: 'sample',
      tMs,
      processes: base(tMin).map((proc) => ({
        pid: proc.pid,
        startedMs: proc.startedMs ?? 1_000 + proc.pid,
        kind: proc.kind,
        rssBytes: bytes(proc),
        physFootprintBytes: bytes(proc),
        cpuSeconds: proc.cpuSeconds ?? 0
      })),
      mainAlive: true,
      sampleDurationMs: 40
    })
    count += 1
  }
  lines.push({ record: 'trailer', outcome: 'completed', samples: count, endedAt: START })
  return lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
}

function auditCounts(minutes: number): string {
  const buckets = Array.from({ length: Math.ceil(minutes / 10) }, (_, index) => ({
    index,
    startsAt: new Date(Date.parse(START) + index * 10 * MINUTE_MS).toISOString(),
    counts: { 'scheduler.job:window-open': 1 },
    other: 3
  }))
  return JSON.stringify({ schema: 'audit-counts/1', from: START, bucketMinutes: 10, unparseableLines: 0, buckets })
}

describe('meeting-history cycle scheduler', () => {
  it('schedules every 30 s with deterministic +/- 5 s jitter', () => {
    const a = scheduleHistoryCycles({ durationMs: 125_000, seed: 7 })
    const b = scheduleHistoryCycles({ durationMs: 125_000, seed: 7 })
    expect(a).toEqual(b)
    expect(a).toHaveLength(4)
    expect(a[0]).toBeGreaterThanOrEqual(25_000)
    expect(a[0]).toBeLessThanOrEqual(35_000)
    expect(a[1]).toBeGreaterThanOrEqual(55_000)
    expect(a[1]).toBeLessThanOrEqual(65_000)
  })
})

describe('meeting-history verdict clauses', () => {
  it('passes a clean run', () => {
    expect(judgeMeetingHistory(cleanObserved())).toEqual({ verdict: 'PASS', exitCode: 0, failures: [] })
  })

  it('fails on a strict 250 ms loop sample inside a History window', () => {
    const observed = cleanObserved({
      historyActions: [{ ...(cleanObserved().historyActions as any[])[0], loopMaxMs: STRICT_BUDGET_MS }]
    })
    expect(judgeMeetingHistory(observed).verdict).toBe('FAIL')
    expect(judgeMeetingHistory(observed).failures.join('\n')).toContain('loop max 250 ms >= 250 ms')
  })

  it('fails when transcript lines drop across a History cycle', () => {
    const observed = cleanObserved({
      historyActions: [{ ...(cleanObserved().historyActions as any[])[0], linesBefore: 9, linesAfter: 8 }]
    })
    expect(judgeMeetingHistory(observed).failures.join('\n')).toContain('transcript lines dropped')
  })

  it('fails when no non-empty meeting was saved', () => {
    const outcome = judgeMeetingHistory(cleanObserved({ meetingFilesAfter: 2, savedBytes: 0 }))
    expect(outcome).toMatchObject({ verdict: 'FAIL', exitCode: 1 })
    expect(outcome.failures).toContain('no new non-empty meeting file after Stop')
  })

  it('fails when fewer than 95% of History cycles complete', () => {
    const failed = { ...(cleanObserved().historyActions as any[])[0], index: 1, outcome: 'failed', rowOpened: false }
    const outcome = judgeMeetingHistory(cleanObserved({ historyActions: [...(cleanObserved().historyActions as any[]), failed] }))
    expect(outcome.verdict).toBe('FAIL')
    expect(outcome.failures.some((failure) => failure.startsWith(`History completion 0.5 < ${HISTORY_COMPLETION_FRACTION}`))).toBe(true)
  })

  it('reports a post-precondition driver error as FAIL, not PRECONDITION', () => {
    const observed = cleanObserved()
    classifyDriverError(observed, new Error('Stop control unavailable'), { preconditionCleared: true })
    const outcome = judgeMeetingHistory(observed)
    expect(outcome).toMatchObject({ verdict: 'FAIL', exitCode: 1 })
    expect(outcome.failures).toContain('driver failure after precondition: Stop control unavailable')
  })
})

describe('meeting-history History search proof', () => {
  it('requires the search result list to be non-empty and smaller than the unfiltered list', () => {
    expect(filteredHistoryRendered(59, 1)).toBe(true)
    expect(filteredHistoryRendered(59, 59)).toBe(false)
    expect(filteredHistoryRendered(59, 0)).toBe(false)
    expect(filteredHistoryRendered(0, 0)).toBe(false)
  })
})

describe('meeting-history report', () => {
  it('summarizes active sidecar kinds from census samples without process details', () => {
    const text = [
      JSON.stringify({ record: 'header', schema: 'census-stream/1' }),
      JSON.stringify({ record: 'sample', tMs: 0, processes: [{ kind: 'main' }, { kind: 'whisper-utility' }, { kind: 'sidecar-supervisor' }] })
    ].join('\n')
    expect(activeKindsFromNdjson(text)).toEqual({
      'parakeet-utility': false,
      'whisper-utility': true,
      'speaker-utility': false,
      'llama-server': false,
      'sidecar-supervisor': true
    })
  })

  it('is content-free and keeps only counts, timings, kinds and event names', () => {
    const observed = cleanObserved()
    const report = buildMeetingHistoryReport(observed, judgeMeetingHistory(observed))
    expect(assertContentFreeReport(report)).toEqual([])
    const text = JSON.stringify(report).toLowerCase()
    for (const forbidden of ['/users/', '/private/', 'capture-meetings', 'synthetic capture', 'qa-capture.wav']) {
      expect(text).not.toContain(forbidden)
    }
    expect(report).toMatchObject({
      verdict: 'PASS',
      hostFloorOverride: true,
      counts: { meetingFilesBefore: 2, meetingFilesAfter: 3, savedBytes: 800 },
      themChannel: { active: false, cause: 'mic-only-configuration' },
      sidecarCauses: { 'llama-server': 'not-observed' },
      profile: { kind: 'representative-synthetic', meetingCount: 59, layout: 'bar' },
      timingNotes: { mainLoopWindow: 'capture-start-through-stop' },
      growth: { outcome: 'PASS' }
    })
  })

  it('gets host memory from the driver process', () => {
    expect(hostMemorySnapshot()).toEqual({
      totalBytes: expect.any(Number),
      freeBytes: expect.any(Number)
    })
  })

  it('derives missing sidecar causes from audit evidence', () => {
    const floorEvidence = summarizeAuditEvidence([
      { event: 'local.host-floor-override', floor: 'advertised-ram', hostTotalBytes: 1, hostAvailableBytes: 1 }
    ])
    expect(deriveLlamaCause({ 'llama-server': false }, floorEvidence)).toBe('floor-refused-despite-override')
    expect(deriveLlamaCause({ 'llama-server': false }, summarizeAuditEvidence([{ event: 'local.runtime.missing' }]))).toBe('local-runtime-missing')
    expect(deriveLlamaCause({ 'llama-server': true }, floorEvidence)).toBeNull()
  })

  it('reports the them channel cause from configuration or capture audit evidence', () => {
    expect(deriveThemChannel({ audioSource: 'mic' }, summarizeAuditEvidence([]))).toEqual({
      active: false,
      cause: 'mic-only-configuration'
    })
    expect(deriveThemChannel({ audioSource: 'system' }, summarizeAuditEvidence([{ event: 'capture.failed', reason: 'screen_permission_denied' }]))).toEqual({
      active: false,
      cause: 'no-screen-recording-grant'
    })
  })
})

describe('meeting-history growth wiring', () => {
  it('feeds MEETING-GROWTH-1 active and post samples with post samples after measured Stop', () => {
    const active = stream({ minutes: 60 })
    const post = stream({ minutes: 10, offsetMinutes: 60 })
    const merged = mergeCensusStreams({ active, post, stopMs: 60 * MINUTE_MS })
    const verdict = evaluateMeetingGrowth({
      active,
      post,
      auditCounts: auditCounts(70),
      captureStartMs: 0,
      stopMs: 60 * MINUTE_MS
    })
    expect(merged).toContain('"tMs":3600000')
    expect(verdict.outcome).toBe('PASS')
    expect(verdict.validity.find((entry: { id: string }) => entry.id === 'V-POST')).toMatchObject({ pass: true })
  })
})
