import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PENDING_GLOBAL,
  buildLaunchFailureReport,
  buildReport,
  emptyRun,
  evaluateCriteria,
  historyEntry,
  pinnedExpression,
  recordSample,
  releaseExpression,
  syntheticDatalessPlan,
  withTimeout
} from './lib/st-1-core.mjs'

/** Runs an expression the way Runtime.evaluate does: in global scope. */
const evaluateGlobally = (expression: string): unknown => (0, eval)(expression)
const globals = globalThis as unknown as Record<string, Record<string, unknown> | undefined>
const pending = (): Record<string, unknown> | undefined => globals[PENDING_GLOBAL]

const candidate = { build_run_id: 1, artifact_sha256: 'a'.repeat(64) }
const goodSample = (tMs: number) => ({ tMs, writeMs: 2, lookupMs: 1, loopMaxSinceLastMs: 12, resources: {} })

function report(overrides: Record<string, unknown> = {}) {
  const measured = { ...emptyRun(), samples: [goodSample(1_000), goodSample(2_000)], loop: { p99Ms: 12, maxMs: 40 } }
  return buildReport({
    row: 'none',
    installer: 'Metis-QA.zip',
    candidate,
    minutes: 5,
    measured,
    evidence: { exercised: null },
    fixtures: [],
    attribution: { mainLog: null, appEvidence: null },
    complete: true,
    harnessError: null,
    ...overrides
  })
}

afterEach(() => {
  vi.useRealTimers()
  delete globals[PENDING_GLOBAL]
})

describe('withTimeout', () => {
  it('resolves with the value when the promise settles in time', async () => {
    await expect(withTimeout(Promise.resolve(7), 1_000)).resolves.toEqual({ ok: true, value: 7 })
  })

  it('resolves with the error message instead of rejecting', async () => {
    await expect(withTimeout(Promise.reject(new Error('Promise was collected')), 1_000)).resolves.toEqual({
      ok: false,
      error: 'Promise was collected'
    })
  })

  it('resolves as timed out when the promise never settles, and leaves no timer behind', async () => {
    vi.useFakeTimers()
    const outcome = withTimeout(new Promise(() => {}), 5_000)
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(outcome).resolves.toEqual({ ok: false, timedOut: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears its timer as soon as the promise settles', async () => {
    vi.useFakeTimers()
    await withTimeout(Promise.resolve('done'), 5_000)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('pinnedExpression', () => {
  it('keeps the awaited promise reachable from a global until it is released', async () => {
    const promise = evaluateGlobally(pinnedExpression('sample-1', '(async () => 41 + 1)()', 1_000))
    expect(pending()?.['sample-1']).toBe(promise)
    await expect(promise).resolves.toEqual({ ok: true, value: 42 })
    evaluateGlobally(releaseExpression('sample-1'))
    expect(pending()).toEqual({})
  })

  it('bounds an expression that never settles and fulfils with a timeout outcome', async () => {
    const promise = evaluateGlobally(pinnedExpression('history-2', 'new Promise(() => {})', 50))
    expect(pending()?.['history-2']).toBe(promise)
    await expect(promise).resolves.toEqual({ ok: false, timedOut: true })
  })

  it('fulfils with the error when the expression throws or rejects, never with an exception', async () => {
    await expect(evaluateGlobally(pinnedExpression('setup-3', '__st1_not_defined.max', 1_000))).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('__st1_not_defined')
    })
    await expect(
      evaluateGlobally(pinnedExpression('sample-4', 'Promise.reject(new Error("write failed"))', 1_000))
    ).resolves.toEqual({ ok: false, error: 'write failed' })
  })

  it('evaluates a synchronous expression and keeps its value', async () => {
    await expect(evaluateGlobally(pinnedExpression('summary-5', '({ p99Ms: 3, maxMs: 9 })', 1_000))).resolves.toEqual({
      ok: true,
      value: { p99Ms: 3, maxMs: 9 }
    })
  })

  it('releasing a key that was never stored is harmless', () => {
    expect(() => evaluateGlobally(releaseExpression('never-stored'))).not.toThrow()
  })
})

describe('recordSample', () => {
  const bounds = { lateAfterMs: 1_000, boundMs: 5_000 }

  it('files an on-time answer as a sample', () => {
    const run = emptyRun()
    recordSample(run, 3_000, { ok: true, value: { writeMs: 2, lookupMs: 1 }, elapsedMs: 40 }, bounds)
    expect(run.samples).toEqual([{ tMs: 3_000, writeMs: 2, lookupMs: 1, answeredMs: 40 }])
    expect(run.late).toEqual([])
    expect(run.errors).toEqual([])
  })

  it('files a slow answer as late, keeping its values', () => {
    const run = emptyRun()
    recordSample(run, 3_000, { ok: true, value: { writeMs: 900, lookupMs: 1 }, elapsedMs: 1_600 }, bounds)
    expect(run.samples).toEqual([])
    expect(run.late).toEqual([{ tMs: 3_000, writeMs: 900, lookupMs: 1, answeredMs: 1_600 }])
  })

  it('files a sample that never answered as late and records the error, so the run can continue', () => {
    const run = emptyRun()
    recordSample(run, 4_000, { ok: false, timedOut: true, elapsedMs: 7_000 }, bounds)
    expect(run.late).toEqual([{ tMs: 4_000, hung: true }])
    expect(run.errors).toEqual([{ step: 'sample', tMs: 4_000, message: 'no answer within 5000 ms' }])
  })

  it('records a failed evaluation as an error only', () => {
    const run = emptyRun()
    recordSample(run, 5_000, { ok: false, error: 'Runtime.evaluate: Promise was collected', elapsedMs: 3 }, bounds)
    expect(run.samples).toEqual([])
    expect(run.late).toEqual([])
    expect(run.errors).toEqual([{ step: 'sample', tMs: 5_000, message: 'Runtime.evaluate: Promise was collected' }])
  })
})

describe('historyEntry', () => {
  it('records a History round trip that never settled as hung, with how long it was waited for', () => {
    expect(historyEntry(25_000, { ok: false, timedOut: true, elapsedMs: 10_004.4 })).toEqual({ tMs: 25_000, hung: true, ms: 10_004 })
  })

  it('records a settled round trip with its in-app latency', () => {
    expect(historyEntry(30_000, { ok: true, value: { ms: 18.5 }, elapsedMs: 25 })).toEqual({ tMs: 30_000, ms: 18.5 })
  })

  it('records a failed probe and a skipped probe as they are', () => {
    expect(historyEntry(35_000, { ok: false, error: 'boom', elapsedMs: 2 })).toEqual({ tMs: 35_000, error: 'boom', ms: 2 })
    expect(historyEntry(40_000, { ok: true, value: { skipped: 'no window' }, elapsedMs: 2 })).toEqual({
      tMs: 40_000,
      skipped: 'no window'
    })
  })
})

describe('evaluateCriteria', () => {
  it('fails every loop criterion when the loop summary is missing', () => {
    const criteria = evaluateCriteria('none', { ...emptyRun(), samples: [goodSample(1)] }, null)
    expect(criteria.find((c) => c.name === 'loop-p99 < 50')?.pass).toBe(false)
    expect(criteria.find((c) => c.name === 'loop-max < 250')?.pass).toBe(false)
  })

  it('adds still-dataless for the dataless row only', () => {
    expect(evaluateCriteria('dataless', emptyRun(), { stillDataless: true }).at(-1)).toEqual({ name: 'still-dataless', pass: true })
    expect(evaluateCriteria('fifo', emptyRun(), {}).map((c) => c.name)).not.toContain('still-dataless')
  })
})

describe('buildReport', () => {
  it('passes a complete run whose criteria all pass, and keeps recorded errors report-only', () => {
    const measured = {
      ...emptyRun(),
      samples: [goodSample(1_000)],
      loop: { p99Ms: 12, maxMs: 40 },
      errors: [{ step: 'history', tMs: 20_000, message: 'no answer within 10000 ms' }]
    }
    const built = report({ measured })
    expect(built.verdict).toBe('PASS')
    expect(built.complete).toBe(true)
    expect(built.errors).toEqual(measured.errors)
  })

  it('fails a complete run on any failing criterion', () => {
    const built = report({ measured: { ...emptyRun(), samples: [goodSample(1_000)], loop: { p99Ms: 12, maxMs: 460 } } })
    expect(built.verdict).toBe('FAIL')
    expect(built.criteria.find((c: { name: string }) => c.name === 'loop-max < 250')).toEqual({ name: 'loop-max < 250', pass: false })
  })

  it('counts late samples, lists them in the timeline and fails no-late-samples', () => {
    const measured = { ...emptyRun(), samples: [goodSample(1_000)], late: [{ tMs: 2_000, hung: true }], loop: { p99Ms: 1, maxMs: 1 } }
    const built = report({ measured })
    expect(built.lateSamples).toBe(1)
    expect(built.timeline).toEqual([goodSample(1_000), { tMs: 2_000, hung: true, late: true }])
    expect(built.verdict).toBe('FAIL')
  })

  it('reports a partial or crashed run as INCOMPLETE with whatever it measured', () => {
    const partial = report({ complete: false, evidence: null })
    expect(partial.verdict).toBe('INCOMPLETE')
    expect(partial.samples).toBe(2)
    expect(partial.exercised).toBeNull()

    const crashed = report({ complete: false, harnessError: 'socket closed' })
    expect(crashed.verdict).toBe('INCOMPLETE')
    expect(crashed.harnessError).toBe('socket closed')
  })

  it('reports a fifo row no FIFO reader reached as NOT_EXERCISED, naming the opened fixtures', () => {
    const built = report({ row: 'fifo', evidence: { exercised: false, fixturesOpened: [] } })
    expect(built.verdict).toBe('NOT_EXERCISED')
    expect(built.fixturesOpened).toEqual([])
  })

  it('reports the main.log offset or the reason it is unknown', () => {
    expect(report({ attribution: { mainLog: { path: 'x', fromByte: 5, exactLaunchOffset: false }, appEvidence: null } }).mainLog).toEqual({
      fromByte: 5,
      exactLaunchOffset: false
    })
    expect(report({ attribution: { mainLog: { error: 'no require' }, appEvidence: null } }).mainLog).toEqual({ error: 'no require' })
  })
})

describe('buildLaunchFailureReport', () => {
  it('fails on the inspector criterion', () => {
    const built = buildLaunchFailureReport({ row: 'fifo', installer: 'Metis-QA.zip', candidate, fixtures: [1, 2, 3], reason: 'no inspector' })
    expect(built.verdict).toBe('FAIL')
    expect(built.criteria).toEqual([{ name: 'inspector', pass: false }])
    expect(built.fixtures).toBe(3)
  })
})

describe('syntheticDatalessPlan', () => {
  const plan = syntheticDatalessPlan()

  it('has the representative-profile shape: 59 meetings, 6 of them blocking, a blocking index and 3+ entity files', () => {
    expect(plan.local).toHaveLength(53)
    expect(plan.fifos.filter((path) => path.endsWith('.md'))).toHaveLength(6)
    expect(plan.fifos).toContain('.brain/index.json')
    expect(plan.fifos.filter((path) => path.startsWith('.brain/entities/')).length).toBeGreaterThanOrEqual(3)
    expect(plan.counts).toEqual({ localMeetings: 53, fifoMeetings: 6, brainFifos: 5 })
  })

  it('never places two files at one path', () => {
    const all = [...plan.local, ...plan.fifos]
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('synthetic-dataless and history reports', () => {
  const synthetic = (overrides: Record<string, unknown> = {}) =>
    report({
      row: 'synthetic-dataless',
      fixtures: Array.from({ length: 11 }, (_, i) => `fifo-${i}`),
      fixtureCounts: syntheticDatalessPlan().counts,
      evidence: { exercised: true, fixturesOpened: ['a.md'], sfDatalessSet: false },
      ...overrides
    })

  it('records the fixture kind, the counts and that SF_DATALESS was set on none', () => {
    const built = synthetic()
    expect(built.fixtureKind).toBe('synthetic-dataless')
    expect(built.fixtureCounts).toEqual({ localMeetings: 53, fifoMeetings: 6, brainFifos: 5 })
    expect(built.sfDatalessSet).toBe(false)
    expect(built.verdict).toBe('PASS')
  })

  it('uses the fifo row exercised rule and the same criteria', () => {
    expect(synthetic({ evidence: { exercised: false, fixturesOpened: [], sfDatalessSet: false } }).verdict).toBe('NOT_EXERCISED')
    expect(synthetic().criteria).toEqual(report().criteria)
    expect(synthetic({ measured: { ...emptyRun(), samples: [goodSample(1_000)], loop: { p99Ms: 12, maxMs: 460 } } }).verdict).toBe('FAIL')
  })

  it('reports historyMode on by default and off when asked, and adds nothing to other rows', () => {
    expect(report().historyMode).toBe('on')
    expect(report({ historyMode: 'off' }).historyMode).toBe('off')
    expect(report({ historyMode: 'off' }).history).toEqual([])
    expect(report({ row: 'fifo', evidence: { exercised: true, fixturesOpened: [] } })).not.toHaveProperty('fixtureKind')
    expect(report()).not.toHaveProperty('sfDatalessSet')
  })
})
