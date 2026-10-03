import { describe, expect, it } from 'vitest'
import {
  HISTORY_COMPLETION_FRACTION,
  STRICT_BUDGET_MS,
  assertContentFreeReport,
  activeKindsFromNdjson,
  buildMeetingHistoryReport,
  judgeMeetingHistory,
  scheduleHistoryCycles
} from './meeting-history.mjs'

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
  census: { active: { code: 0 }, post: { code: 0 } },
  growth: { outcome: 'PASS' },
  ...overrides
})

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
      growth: { outcome: 'PASS' }
    })
  })
})
