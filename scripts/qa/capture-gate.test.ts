import { describe, expect, it } from 'vitest'
import {
  CAPTURE_BACKOFF_CONSTANTS,
  FINAL_TAIL_MS,
  INDUCTION_METHOD,
  MAX_BG_FAILURES,
  PARK_MS,
  bgScreenCaptureFailed,
  buildReport,
  captureGateVerdict,
  exitCodeForOutcome
} from './capture-gate.mjs'

const INDUCTION_AT = Date.parse('2026-10-03T12:00:00.000Z')
const reportFor = buildReport as unknown as (input: Record<string, unknown>) => Record<string, unknown>

const ready = Object.freeze({ observed: true, backgroundScreenReady: true, localReady: true })
const failing = Object.freeze({
  method: INDUCTION_METHOD,
  inductionStarted: true,
  beforeInduction: { captureWorks: true },
  afterInduction: { captureWorks: false },
  afterPark: { captureWorks: false }
})

function failedAt(ms: number) {
  return { ts: new Date(INDUCTION_AT + ms).toISOString(), event: 'capture.failed', phase: 'bg-screen', reason: 'fixed-test-category' }
}

function suspendedAt(ms: number, failures = CAPTURE_BACKOFF_CONSTANTS.BACKOFF_LATCH_AFTER) {
  return {
    ts: new Date(INDUCTION_AT + ms).toISOString(),
    event: 'screen.preprocess.suspended',
    failures,
    reason: 'permission',
    latched: true
  }
}

function verdict(records: unknown[]) {
  return captureGateVerdict({
    records,
    inductionAtMs: INDUCTION_AT,
    readinessProof: ready,
    failingStateProof: failing,
    maxBgFailures: MAX_BG_FAILURES
  })
}

describe('capture-gate oracle', () => {
  it('pins the hosted park tail and total ceiling to the production backoff constants', () => {
    expect(FINAL_TAIL_MS).toBeGreaterThanOrEqual(1.5 * CAPTURE_BACKOFF_CONSTANTS.BACKOFF_MAX_MS)
    expect(MAX_BG_FAILURES).toBe(CAPTURE_BACKOFF_CONSTANTS.BACKOFF_LATCH_AFTER + 1)
  })

  it('counts only bg-screen capture.failed events', () => {
    expect(
      bgScreenCaptureFailed([
        failedAt(0),
        { ...failedAt(1), phase: 'listen' },
        { ...failedAt(2), event: 'capture.screen' },
        { event: 'capture.failed' }
      ])
    ).toHaveLength(1)
  })

  it('FAILs an unbacked 6 s tick', () => {
    const records = Array.from({ length: Math.floor(PARK_MS / 6_000) + 1 }, (_, index) => failedAt(index * 6_000))
    expect(verdict(records)).toMatchObject({
      outcome: 'FAIL',
      reasons: ['bg_screen_failed_total', 'bg_screen_failed_final_tail']
    })
  })

  it('FAILs a ceiling-only 600-606 s period at every phase offset', () => {
    for (const period of [CAPTURE_BACKOFF_CONSTANTS.BACKOFF_MAX_MS, CAPTURE_BACKOFF_CONSTANTS.BACKOFF_MAX_MS + 6_000]) {
      for (const offset of [0, Math.floor(period / 3), period - 1]) {
        const records: unknown[] = []
        for (let t = offset; t <= PARK_MS; t += period) records.push(failedAt(t))
        expect(verdict(records), `period ${period}, offset ${offset}`).toMatchObject({
          outcome: 'FAIL',
          reasons: ['bg_screen_failed_final_tail']
        })
      }
    }
  })

  it('PASSes when failures latch after the production latch count', () => {
    const records: unknown[] = [0, 6_000, 18_000, 42_000, 90_000].map(failedAt)
    records.push(suspendedAt(90_000))
    expect(verdict(records)).toMatchObject({
      outcome: 'PASS',
      bgScreenCaptureFailedTotal: CAPTURE_BACKOFF_CONSTANTS.BACKOFF_LATCH_AFTER,
      bgScreenCaptureFailedFinal15Minutes: 0,
      screenPreprocessSuspended: { count: 1, latched: true, reasons: ['permission'] }
    })
  })

  it('PASSes one failure followed by a live eligibility gate', () => {
    expect(verdict([failedAt(0)])).toMatchObject({
      outcome: 'PASS',
      bgScreenCaptureFailedTotal: 1,
      bgScreenCaptureFailedFinal15Minutes: 0,
      screenPreprocessSuspended: { count: 0, latched: false, reasons: [] }
    })
  })

  it('returns PRECONDITION when readiness is unproven', () => {
    expect(
      captureGateVerdict({
        records: [failedAt(0)],
        inductionAtMs: INDUCTION_AT,
        readinessProof: { observed: false, backgroundScreenReady: true, localReady: true },
        failingStateProof: failing,
        maxBgFailures: MAX_BG_FAILURES
      })
    ).toMatchObject({ outcome: 'PRECONDITION', reasons: ['readiness_unproven'] })
  })

  it('returns PRECONDITION when the failing state is unproven', () => {
    expect(
      captureGateVerdict({
        records: [failedAt(0)],
        inductionAtMs: INDUCTION_AT,
        readinessProof: ready,
        failingStateProof: { ...failing, afterPark: { captureWorks: true } },
        maxBgFailures: MAX_BG_FAILURES
      })
    ).toMatchObject({ outcome: 'PRECONDITION', reasons: ['failing_state_unproven'] })
  })

  it('maps exits and emits the lane report fields without raw failure text', () => {
    expect(exitCodeForOutcome('PASS')).toBe(0)
    expect(exitCodeForOutcome('FAIL')).toBe(1)
    expect(exitCodeForOutcome('PRECONDITION')).toBe(2)
    const report = reportFor({
      records: [failedAt(0), suspendedAt(90_000)],
      readinessProof: ready,
      failingStateProof: failing,
      inductionAtMs: INDUCTION_AT,
      maxBgFailures: MAX_BG_FAILURES,
      backgroundScreenReadyAfterPark: { observed: true, backgroundScreenReady: false }
    })
    expect(report).toMatchObject({
      schema: 1,
      ticket: 'M2-0559',
      outcome: 'PASS',
      reasons: [],
      inductionMethod: INDUCTION_METHOD,
      readinessProof: ready,
      failingStateProof: failing,
      bgScreenCaptureFailedTotal: 1,
      bgScreenCaptureFailedFinal15Minutes: 0,
      screenPreprocessSuspended: { count: 1, latched: true, reasons: ['permission'] },
      backgroundScreenReadyAfterPark: { observed: true, backgroundScreenReady: false }
    })
    expect(JSON.stringify(report)).not.toMatch(/Users|window title|fixed-test-category/i)
  })
})
