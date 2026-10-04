import type { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  CAPTURE_BACKOFF_CONSTANTS,
  FINAL_TAIL_MS,
  INDUCTION_METHOD,
  MAX_BG_FAILURES,
  PARK_MS,
  PROBE_SETTLE_MS,
  bgScreenCaptureFailed,
  buildReport,
  captureProbe,
  captureGateVerdict,
  exitCodeForOutcome,
  readCaptureAudit,
  runCaptureGate
} from './capture-gate.mjs'

const INDUCTION_AT = Date.parse('2026-10-03T12:00:00.000Z')
const reportFor = buildReport as unknown as (input: Record<string, unknown>) => Record<string, unknown>

const ready = Object.freeze({ observed: true, backgroundScreenReady: true, localReady: true })
const parkedCandidate = Object.freeze({
  observed: true,
  aliveAtInduction: true,
  aliveAfterPark: true,
  exitObserved: false,
  exitedBeforeParkComplete: false,
  processErrorObserved: false,
  parkElapsedMs: PARK_MS
})
const measuredAudit = Object.freeze({
  observed: true, baselineComplete: true, baselineValid: true, finalComplete: true, finalValid: true,
  freshProfile: true, startupAnchored: true, readinessAnchored: true, baselineRetained: true,
  lengthNondecreasing: true, parkCovered: true, baselineRecordCount: 2, finalRecordCount: 2
})
const failing = Object.freeze({
  method: INDUCTION_METHOD,
  inductionStarted: true,
  beforeInduction: { captureWorks: true, category: 'ok' },
  afterInduction: { captureWorks: false, category: 'capture_unavailable' },
  afterPark: { captureWorks: false, category: 'capture_unavailable' },
  candidateLivenessProof: parkedCandidate,
  auditProof: measuredAudit
})

class OwnedCandidate extends EventEmitter {
  pid: number | undefined = 4242
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null

  exit() {
    this.exitCode = 0
    this.emit('exit', 0, null)
  }
}

type ProbeProcessResult = {
  status: number | null
  stdout?: string
  stderr?: string
  signal?: NodeJS.Signals | null
  error?: { code: string }
}

const nativeCaptureWorks: ProbeProcessResult = { status: 0, stdout: 'METIS_CAPTURE_OK\r\n' }
const nativeCaptureUnavailable: ProbeProcessResult = { status: 10, stdout: 'METIS_CAPTURE_UNAVAILABLE\r\n' }

type FlowOptions = {
  results?: ProbeProcessResult[]
  child?: OwnedCandidate
  exitAtMs?: number
  processErrorAtMs?: number
  connectFails?: boolean
  maxWaitAdvanceMs?: number
  clockInvalid?: boolean
  clockFrozen?: boolean
  afterParkReady?: { observed: boolean; backgroundScreenReady: boolean | null }
  records?: unknown[]
  auditTexts?: readonly (string | Buffer | Error)[]
  hideAdvanceMs?: number
}

function auditText(records: Record<string, unknown>[]) {
  let previous = 'GENESIS'
  return records.map((record, index) => {
    const line = JSON.stringify({ ...record, seq: index + 1, prev: previous })
    previous = createHash('sha256').update(line, 'utf8').digest('hex')
    return `${line}\r\n`
  }).join('')
}

const startupAudit = () => [
  { ts: new Date(INDUCTION_AT).toISOString(), event: 'app.started', privateMetadata: 'synthetic audit content' },
  { ts: new Date(INDUCTION_AT).toISOString(), event: 'app.renderer.ready' }
]

function flowFixture({
  results = [nativeCaptureWorks, nativeCaptureUnavailable, nativeCaptureUnavailable],
  child = new OwnedCandidate(),
  exitAtMs = Number.POSITIVE_INFINITY,
  processErrorAtMs = Number.POSITIVE_INFINITY,
  connectFails = false,
  maxWaitAdvanceMs = Number.POSITIVE_INFINITY,
  clockInvalid = false,
  clockFrozen = false,
  afterParkReady = { observed: true, backgroundScreenReady: false },
  records = [],
  auditTexts,
  hideAdvanceMs = 0
}: FlowOptions = {}) {
  const clock = { elapsed: 0 }
  const waits: number[] = []
  let probes = 0
  let auditReads = 0
  const spawnProbe = vi.fn(() => {
    const result = results[probes++]
    if (!result) throw new Error('Unexpected probe invocation')
    return result
  })
  const hide = vi.fn(async () => { clock.elapsed += hideAdvanceMs })
  const run = () => runCaptureGate({
    child,
    maxBgFailures: MAX_BG_FAILURES,
    connect: async () => {
      if (connectFails) throw new Error('synthetic connection failure')
      return {}
    },
    readAudit: (phase?: string) => readCaptureAudit('owned-capture-profile', () => {
      const ordinal = auditReads++
      const stage = phase ?? (ordinal === 0 ? 'baseline' : 'final')
      const selected = auditTexts ? stage === 'baseline' ? auditTexts[0] : stage === 'park'
        ? auditTexts[auditTexts.length > 2 ? 1 : 0] : auditTexts[auditTexts.length - 1] : undefined
      const currentRecords = stage === 'baseline' ? [] : stage === 'park'
        ? records.filter((record) => Date.parse(String((record as { ts?: unknown }).ts)) <= INDUCTION_AT + clock.elapsed) : records
      const snapshot = selected ?? (auditTexts ? undefined : auditText([...startupAudit(), ...currentRecords as Record<string, unknown>[]]))
      if (snapshot instanceof Error) throw snapshot
      if (snapshot === undefined) throw new Error('Unexpected audit invocation')
      return Buffer.isBuffer(snapshot) ? Buffer.from(snapshot) : Buffer.from(snapshot, 'utf8')
    }),
    probe: () => captureProbe(spawnProbe as unknown as typeof spawnSync),
    induce: () => ({ ok: true, category: 'ok' }),
    proveReady: async () => ready,
    hide,
    readAfterPark: async () => afterParkReady,
    now: () => INDUCTION_AT + clock.elapsed,
    monotonicNow: () => clockInvalid ? Number.NaN : clockFrozen ? 0 : clock.elapsed,
    wait: async (ms: number) => {
      waits.push(ms)
      clock.elapsed += Math.min(ms, maxWaitAdvanceMs)
      if (clock.elapsed >= exitAtMs && child.exitCode === null) child.exit()
      if (clock.elapsed >= processErrorAtMs) child.emit('error', new Error('private process transport diagnostic'))
    }
  })
  return { run, child, clock, waits, spawnProbe, hide, auditReads: () => auditReads }
}

describe('capture-gate actual audit measurement', () => {
  it.each(['baseline', 'final'] as const)('keeps an unavailable %s audit unproven', async (phase) => {
    const snapshots: (string | Error)[] = [auditText(startupAudit()), auditText(startupAudit())]
    snapshots[phase === 'baseline' ? 0 : 1] = new Error('synthetic private audit IO diagnosis')
    const report = await flowFixture({ auditTexts: snapshots }).run()
    expect(report).toMatchObject({ outcome: 'PRECONDITION', reasons: ['audit_unproven'] })
    expect(exitCodeForOutcome(report.outcome)).toBe(2)
    expect(JSON.stringify(report)).not.toContain('synthetic private audit IO diagnosis')
  })

  it.each(['', 'not JSON\r\n', '{}\r\n', 'null\r\n', '[]\r\n'])('does not turn invalid baseline bytes into a zero-failure PASS', async (unproven) => {
    expect(await flowFixture({ auditTexts: [unproven, auditText(startupAudit())] }).run()).toMatchObject({
      outcome: 'PRECONDITION', reasons: ['audit_unproven']
    })
  })

  it.each([
    () => '',
    () => 'not JSON\r\n',
    () => `${auditText(startupAudit())}not JSON\r\n`,
    () => `${auditText(startupAudit())}{"ts":`,
    () => auditText(startupAudit()).trimEnd(),
    () => auditText(startupAudit().slice(0, 1)),
    () => auditText([{ ts: new Date(INDUCTION_AT + PARK_MS).toISOString(), event: 'capture.blocked' }]),
    () => auditText([{ ...startupAudit()[0], privateMetadata: 'replacement audit' }, startupAudit()[1]]),
    () => auditText([...startupAudit(), { ts: 'invalid', event: 'capture.failed', phase: 'bg-screen' }])
  ])('rejects a malformed, incomplete, rotated, truncated or replaced final audit', async (finalSnapshot) => {
    expect(await flowFixture({ auditTexts: [auditText(startupAudit()), finalSnapshot()] }).run()).toMatchObject({
      outcome: 'PRECONDITION', reasons: ['audit_unproven']
    })
  })

  it.each([
    { records: startupAudit().slice(0, 1) },
    { records: startupAudit().slice(1) },
    { records: startupAudit().map((record) => ({ ...record, ts: new Date(INDUCTION_AT - 1).toISOString() })) }
  ])('requires fresh startup and readiness anchors before induction', async ({ records }) => {
    const text = auditText(records)
    expect(await flowFixture({ auditTexts: [text, text] }).run()).toMatchObject({ outcome: 'PRECONDITION', reasons: ['audit_unproven'] })
  })

  it('does not ignore an appended audit chain gap', async () => {
    const baseline = auditText(startupAudit())
    const final = `${baseline}${JSON.stringify({ ts: new Date(INDUCTION_AT + 1).toISOString(), event: 'capture.blocked', seq: 99, prev: 'GENESIS' })}\r\n`
    expect(await flowFixture({ auditTexts: [baseline, final] }).run()).toMatchObject({ outcome: 'PRECONDITION', reasons: ['audit_unproven'] })
  })

  it('does not normalize invalid UTF-8 into ignored audit bytes', async () => {
    const baseline = auditText(startupAudit())
    const final = Buffer.concat([Buffer.from(baseline), Buffer.from([0xff]), Buffer.from('\r\n')])
    expect(await flowFixture({ auditTexts: [baseline, final] }).run()).toMatchObject({ outcome: 'PRECONDITION', reasons: ['audit_unproven'] })
  })

  it('rejects a grown trail truncated back to its still-valid startup baseline', async () => {
    const baseline = auditText(startupAudit())
    const grown = auditText([...startupAudit(), failedAt(6_000)])
    expect(await flowFixture({ auditTexts: [baseline, grown, baseline] }).run()).toMatchObject({ outcome: 'PRECONDITION', reasons: ['audit_unproven'] })
  })

  it('does not omit newly appended failure rows whose timestamps precede the induction', async () => {
    expect(await flowFixture({ hideAdvanceMs: 1_000, records: [failedAt(500)] }).run()).toMatchObject({
      outcome: 'PRECONDITION', reasons: ['audit_unproven']
    })
  })

  it('accepts continuous, readable anchored zero-failure audit coverage and publishes only counts and booleans', async () => {
    const fixture = flowFixture()
    const report = await fixture.run()
    expect(report).toMatchObject({
      outcome: 'PASS',
      bgScreenCaptureFailedTotal: 0,
      bgScreenCaptureFailedFinal15Minutes: 0,
      failingStateProof: { auditProof: {
        observed: true, baselineComplete: true, baselineValid: true, finalComplete: true, finalValid: true,
        freshProfile: true, startupAnchored: true, readinessAnchored: true, baselineRetained: true,
        lengthNondecreasing: true, parkCovered: true, baselineRecordCount: 2, finalRecordCount: 2
      } }
    })
    expect(fixture.auditReads()).toBeGreaterThan(2)
    expect(JSON.stringify(report)).not.toMatch(/synthetic audit content|owned-capture-profile|GENESIS|privateMetadata|exitedAtMs|baselineAt/i)
  })
})

describe('capture-gate production flow', () => {
  it.each(['afterInduction', 'afterPark'] as const)('does not prove unavailable capture from a timeout at %s', async (phase) => {
    const results = [nativeCaptureWorks, nativeCaptureUnavailable, nativeCaptureUnavailable]
    results[phase === 'afterInduction' ? 1 : 2] = { status: null, error: { code: 'ETIMEDOUT' } }
    const report = await flowFixture({ results }).run()
    expect(report).toMatchObject({
      outcome: 'PRECONDITION',
      reasons: ['failing_state_unproven'],
      failingStateProof: { [phase]: { captureWorks: null, category: 'timeout' } }
    })
    expect(exitCodeForOutcome(report.outcome)).toBe(2)
  })

  it.each(['afterInduction', 'afterPark'] as const)('does not prove unavailable capture from a process error at %s', async (phase) => {
    const results = [nativeCaptureWorks, nativeCaptureUnavailable, nativeCaptureUnavailable]
    results[phase === 'afterInduction' ? 1 : 2] = { status: null, error: { code: 'ENOENT' } }
    expect(await flowFixture({ results }).run()).toMatchObject({
      outcome: 'PRECONDITION',
      reasons: ['failing_state_unproven'],
      failingStateProof: { [phase]: { captureWorks: null, category: 'process_error' } }
    })
  })

  it.each([
    { status: 1, stderr: 'private setup failure with user path and account name' },
    { status: 10, stdout: '' },
    { status: 10, stdout: 'METIS_CAPTURE_OK\r\n' },
    { status: null, signal: 'SIGTERM' as const },
    { status: 0, stdout: 'METIS_CAPTURE_UNAVAILABLE\r\n' }
  ])('requires a completed, matching capture result for native process status $status', async (unproven) => {
    const report = await flowFixture({ results: [nativeCaptureWorks, unproven, nativeCaptureUnavailable] }).run()
    expect(report).toMatchObject({
      outcome: 'PRECONDITION',
      reasons: ['failing_state_unproven'],
      failingStateProof: { afterInduction: { captureWorks: null, category: 'process_error' } }
    })
    expect(JSON.stringify(report)).not.toMatch(/private setup failure|user path|account name|stderr|stdout/i)
  })

  it('requires a completed capture success before induction', async () => {
    expect(await flowFixture({ results: [{ status: 0, stdout: '' }, nativeCaptureUnavailable, nativeCaptureUnavailable] }).run()).toMatchObject({
      outcome: 'PRECONDITION',
      reasons: ['failing_state_unproven'],
      failingStateProof: { beforeInduction: { captureWorks: null, category: 'process_error' } }
    })
  })

  it('rejects an owned candidate that exits during the park despite a silent audit tail', async () => {
    const fixture = flowFixture({ exitAtMs: PROBE_SETTLE_MS + PARK_MS / 2 })
    const report = await fixture.run()
    expect(report).toMatchObject({
      outcome: 'FAIL',
      reasons: ['candidate_exited'],
      candidateLivenessProof: { observed: true, aliveAfterPark: false, exitedBeforeParkComplete: true },
      backgroundScreenReadyAfterPark: { observed: true, backgroundScreenReady: false }
    })
    expect(exitCodeForOutcome(report.outcome)).toBe(1)
    expect(fixture.child.listenerCount('exit')).toBe(0)
    expect(fixture.child.listenerCount('error')).toBe(0)
  })

  it('requires owned-candidate identity for liveness proof', async () => {
    const child = new OwnedCandidate()
    child.pid = undefined
    expect(await flowFixture({ child }).run()).toMatchObject({
      outcome: 'PRECONDITION',
      reasons: ['candidate_liveness_unproven']
    })
  })

  it('latches the original owned candidate exit even if its numeric identity appears live later', async () => {
    const child = new OwnedCandidate()
    child.exit = () => {
      child.emit('exit', 0, null)
      child.exitCode = null
    }
    const report = await flowFixture({ child, exitAtMs: PROBE_SETTLE_MS + PARK_MS / 2 }).run()
    expect(report).toMatchObject({ outcome: 'FAIL', reasons: ['candidate_exited'] })
  })

  it('keeps a candidate process transport error unproven and content-free', async () => {
    const fixture = flowFixture({ processErrorAtMs: PROBE_SETTLE_MS + PARK_MS / 2 })
    const report = await fixture.run()
    expect(report).toMatchObject({ outcome: 'PRECONDITION', reasons: ['candidate_liveness_unproven'] })
    expect(JSON.stringify(report)).not.toContain('private process transport diagnostic')
    expect(fixture.child.listenerCount('exit')).toBe(0)
    expect(fixture.child.listenerCount('error')).toBe(0)
  })

  it('removes only its own lifetime observers on a failed connection', async () => {
    const child = new OwnedCandidate()
    const otherExitObserver = vi.fn()
    const otherErrorObserver = vi.fn()
    child.on('exit', otherExitObserver)
    child.on('error', otherErrorObserver)
    await expect(flowFixture({ child, connectFails: true }).run()).rejects.toThrow('synthetic connection failure')
    expect(child.listeners('exit')).toEqual([otherExitObserver])
    expect(child.listeners('error')).toEqual([otherErrorObserver])
  })

  it('measures the actual park rather than trusting an early-resolving wait', async () => {
    const fixture = flowFixture({ maxWaitAdvanceMs: 60_000 })
    const report = await fixture.run()
    expect(fixture.clock.elapsed).toBeGreaterThanOrEqual(PROBE_SETTLE_MS + PARK_MS)
    expect(report).toMatchObject({
      outcome: 'PASS',
      parkMs: PARK_MS,
      finalTailMs: FINAL_TAIL_MS,
      candidateLivenessProof: { observed: true, aliveAtInduction: true, aliveAfterPark: true, exitedBeforeParkComplete: false, parkElapsedMs: PARK_MS }
    })
  })

  it('does not accept an unmeasurable park', async () => {
    expect(await flowFixture({ clockInvalid: true }).run()).toMatchObject({
      outcome: 'PRECONDITION',
      reasons: ['candidate_liveness_unproven']
    })
  })

  it('fails closed when the measured clock does not advance after a positive wait', async () => {
    expect(await flowFixture({ clockFrozen: true }).run()).toMatchObject({
      outcome: 'PRECONDITION',
      reasons: ['candidate_liveness_unproven']
    })
  })

  it.each([
    { observed: true, backgroundScreenReady: false },
    { observed: false, backgroundScreenReady: null }
  ])('keeps post-park readiness informational after a live, measured park', async (afterParkReady) => {
    const fixture = flowFixture({ afterParkReady })
    const report = await fixture.run()
    expect(report).toMatchObject({ outcome: 'PASS', reasons: [], backgroundScreenReadyAfterPark: afterParkReady })
    expect(fixture.hide).toHaveBeenCalledOnce()
    expect(fixture.spawnProbe).toHaveBeenCalledTimes(3)
    expect(fixture.clock.elapsed).toBeGreaterThanOrEqual(PROBE_SETTLE_MS + PARK_MS)
  })

  it('retains the final-tail failure gate through the actual parked flow', async () => {
    expect(await flowFixture({ records: [failedAt(PARK_MS - 1)] }).run()).toMatchObject({
      outcome: 'FAIL',
      reasons: ['bg_screen_failed_final_tail'],
      bgScreenCaptureFailedFinal15Minutes: 1
    })
  })
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
  const allRecords = [...startupAudit(), ...records]
  return captureGateVerdict({
    records: allRecords,
    inductionAtMs: INDUCTION_AT,
    readinessProof: ready,
    failingStateProof: { ...failing, auditProof: { ...measuredAudit, finalRecordCount: allRecords.length } },
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

  it('does not accept false capture booleans with transport-error categories', () => {
    expect(captureGateVerdict({
      records: [],
      inductionAtMs: INDUCTION_AT,
      readinessProof: ready,
      failingStateProof: { ...failing, afterPark: { captureWorks: false, category: 'timeout' } },
      maxBgFailures: MAX_BG_FAILURES
    })).toMatchObject({ outcome: 'PRECONDITION', reasons: ['failing_state_unproven'] })
  })

  it.each([undefined, { ...parkedCandidate, parkElapsedMs: PARK_MS - 1 }])('requires full measured owned lifetime even with a silent audit tail', (candidateLivenessProof) => {
    expect(captureGateVerdict({
      records: [],
      inductionAtMs: INDUCTION_AT,
      readinessProof: ready,
      failingStateProof: { ...failing, candidateLivenessProof },
      maxBgFailures: MAX_BG_FAILURES
    })).toMatchObject({ outcome: 'PRECONDITION', reasons: ['candidate_liveness_unproven'] })
  })

  it('maps exits and emits the lane report fields without raw failure text', () => {
    expect(exitCodeForOutcome('PASS')).toBe(0)
    expect(exitCodeForOutcome('FAIL')).toBe(1)
    expect(exitCodeForOutcome('PRECONDITION')).toBe(2)
    const report = reportFor({
      records: [...startupAudit(), failedAt(0), suspendedAt(90_000)],
      readinessProof: ready,
      failingStateProof: { ...failing, auditProof: { ...measuredAudit, finalRecordCount: 4 } },
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
      failingStateProof: { ...failing, auditProof: { ...measuredAudit, finalRecordCount: 4 } },
      candidateLivenessProof: parkedCandidate,
      bgScreenCaptureFailedTotal: 1,
      bgScreenCaptureFailedFinal15Minutes: 0,
      screenPreprocessSuspended: { count: 1, latched: true, reasons: ['permission'] },
      backgroundScreenReadyAfterPark: { observed: true, backgroundScreenReady: false }
    })
    expect(JSON.stringify(report)).not.toMatch(/Users|window title|fixed-test-category/i)
  })
})
