import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOOT_WINDOW_VARIANTS } from '../../src/main/infra/observability/projection'
import {
  PENDING_GLOBAL,
  WINDOW_VARIANTS,
  bootStagesFromAudit,
  buildLaunchFailureReport,
  buildReport,
  candidateEnv,
  cpuBusyPct,
  emptyRun,
  evaluateCriteria,
  historyEntry,
  historySummary,
  parseArgs,
  pinnedExpression,
  recordSample,
  releaseExpression,
  runPurpose,
  withTimeout,
  witnessSummary
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

  it('gives every timeline entry it files, late and hung ones included, the runner witness (M2-0515)', () => {
    const witness = { loopMaxSinceLastMs: 310, writeMs: 4, cpuBusyPct: 97.5 }
    const run = emptyRun()
    recordSample(run, 1_000, { ok: true, value: { writeMs: 2, lookupMs: 1 }, elapsedMs: 40 }, { ...bounds, witness })
    recordSample(run, 2_000, { ok: true, value: { writeMs: 900, lookupMs: 1 }, elapsedMs: 1_600 }, { ...bounds, witness })
    recordSample(run, 3_000, { ok: false, timedOut: true, elapsedMs: 7_000 }, { ...bounds, witness })
    expect(run.samples).toEqual([{ tMs: 1_000, writeMs: 2, lookupMs: 1, answeredMs: 40, witness }])
    expect(run.late).toEqual([
      { tMs: 2_000, writeMs: 900, lookupMs: 1, answeredMs: 1_600, witness },
      { tMs: 3_000, hung: true, witness }
    ])
  })
})

describe('bootStagesFromAudit (M2-0515)', () => {
  it('lifts every app.boot.stage record out of the audit trail in order, rounds ms and skips other events and torn lines', () => {
    const text = [
      JSON.stringify({ ts: '2026-09-29T10:00:00.000Z', seq: 1, event: 'app.started', bootId: 'b' }),
      JSON.stringify({ ts: '2026-09-29T10:00:00.400Z', seq: 2, event: 'app.boot.stage', bootId: 'b', stage: 'createWindow.construct', ms: 170.26, transparent: true }),
      JSON.stringify({ ts: '2026-09-29T10:00:00.520Z', seq: 3, event: 'app.boot.stage', bootId: 'b', stage: 'createWindow.firstShow', ms: 12 }),
      // A foreign record that only mentions the event name, and a torn last line.
      JSON.stringify({ ts: '2026-09-29T10:00:00.600Z', seq: 4, event: 'app.stall', phase: 'app.boot.stage' }),
      JSON.stringify({ ts: '2026-09-29T10:00:01.000Z', seq: 5, event: 'app.boot.stage', bootId: 'b', stage: 'createTray.newTray', ms: 312 }),
      '{"ts":"2026-09-29T10:00:01.100Z","event":"app.boot.stage","stage":"createTray.attach',
      ''
    ].join('\n')
    expect(bootStagesFromAudit(text, Date.parse('2026-09-29T10:00:00.000Z'))).toEqual([
      { stage: 'createWindow.construct', ms: 170.3, ts: '2026-09-29T10:00:00.400Z', transparent: true, sinceSpawnMs: 400 },
      { stage: 'createWindow.firstShow', ms: 12, ts: '2026-09-29T10:00:00.520Z', sinceSpawnMs: 520 },
      { stage: 'createTray.newTray', ms: 312, ts: '2026-09-29T10:00:01.000Z', sinceSpawnMs: 1_000 }
    ])
  })

  it('leaves sinceSpawnMs out without a spawn time, and ms null when the record has none', () => {
    const text = JSON.stringify({ ts: '2026-09-29T10:00:00.400Z', event: 'app.boot.stage', stage: 'createTray.loadIcon' })
    expect(bootStagesFromAudit(text)).toEqual([{ stage: 'createTray.loadIcon', ms: null, ts: '2026-09-29T10:00:00.400Z' }])
  })

  it('keeps the variant a window stage was built under, and the navigation stage (M2-0516)', () => {
    const text = [
      JSON.stringify({ ts: '2026-09-29T10:00:00.400Z', event: 'app.boot.stage', stage: 'createWindow.construct', ms: 760, transparent: false, windowVariant: 'spellcheck-off' }),
      JSON.stringify({ ts: '2026-09-29T10:00:00.450Z', event: 'app.boot.stage', stage: 'createWindow.navigate', ms: 31.04 })
    ].join('\n')
    expect(bootStagesFromAudit(text)).toEqual([
      { stage: 'createWindow.construct', ms: 760, ts: '2026-09-29T10:00:00.400Z', transparent: false, windowVariant: 'spellcheck-off' },
      { stage: 'createWindow.navigate', ms: 31, ts: '2026-09-29T10:00:00.450Z' }
    ])
  })
})

describe('window-construction runs (M2-0516)', () => {
  it('knows exactly the variants the app can build', () => {
    expect(WINDOW_VARIANTS).toEqual([...BOOT_WINDOW_VARIANTS])
  })

  it('makes a run without a purpose an ST-1 run on the shipped window, and refuses a variant there', () => {
    expect(runPurpose({})).toEqual({ purpose: 'st-1', windowVariant: 'shipped' })
    expect(runPurpose({ windowVariant: 'paint-when-hidden' }).error).toMatch(/--window-variant needs --purpose window-construction/)
  })

  it('takes a window-construction run with one known variant, and refuses an unknown purpose or variant', () => {
    expect(runPurpose({ purpose: 'window-construction', windowVariant: 'prewarm-view' })).toEqual({
      purpose: 'window-construction',
      windowVariant: 'prewarm-view'
    })
    expect(runPurpose({ purpose: 'window-construction' }).error).toMatch(/--window-variant must be one of shipped, /)
    expect(runPurpose({ purpose: 'window-construction', windowVariant: 'transparent' }).error).toMatch(/got "transparent"/)
    expect(runPurpose({ purpose: 'st-2', windowVariant: 'shipped' }).error).toMatch(/--purpose must be window-construction/)
  })

  it('always sets the variant for the candidate, so an inherited value never reaches an ST-1 run', () => {
    const env = candidateEnv({ PATH: '/bin', METIS_QA_WINDOW_VARIANT: 'prewarm-view' }, '/tmp/profile', 'shipped')
    expect(env).toEqual({ PATH: '/bin', ASKTOTO_USERDATA: '/tmp/profile', METIS_QA_WINDOW_VARIANT: 'shipped' })
  })

  it('marks its report and launch failure as never ST-1 evidence, whatever the verdict; an ST-1 report carries no mark', () => {
    const built = report({ purpose: 'window-construction', windowVariant: 'spellcheck-off' })
    expect(built).toMatchObject({ purpose: 'window-construction', st1Evidence: false, windowVariant: 'spellcheck-off', verdict: 'PASS' })
    const failed = buildLaunchFailureReport({
      row: 'none',
      installer: 'Metis-QA.zip',
      candidate,
      fixtures: [],
      reason: 'no inspector',
      purpose: 'window-construction',
      windowVariant: 'prewarm-view'
    })
    expect(failed).toMatchObject({ purpose: 'window-construction', st1Evidence: false, windowVariant: 'prewarm-view', verdict: 'FAIL' })
    for (const st1 of [report({ purpose: 'st-1', windowVariant: 'shipped' }), report()]) {
      expect(st1).not.toHaveProperty('purpose')
      expect(st1).not.toHaveProperty('st1Evidence')
      expect(st1).not.toHaveProperty('windowVariant')
    }
  })
})

describe('cpuBusyPct (M2-0515)', () => {
  const core = (user: number, nice: number, sys: number, idle: number, irq: number) => ({ model: 'x', speed: 1, times: { user, nice, sys, idle, irq } })

  it('is user + nice + sys + irq over all time since the previous snapshot, summed over every core', () => {
    const previous = [core(100, 0, 50, 850, 0), core(200, 0, 0, 800, 0)]
    // Core 1: +300 busy, +100 idle. Core 2: +10 user, +5 nice, +5 irq busy, +180 idle. 320 busy of 600.
    const current = [core(300, 0, 150, 950, 0), core(210, 5, 0, 980, 5)]
    expect(cpuBusyPct(previous, current)).toBe(53.3)
  })

  it('is null without a previous snapshot or elapsed time', () => {
    const snapshot = [core(100, 0, 50, 850, 0)]
    expect(cpuBusyPct(null, snapshot)).toBeNull()
    expect(cpuBusyPct(snapshot, snapshot)).toBeNull()
  })
})

describe('witnessSummary (M2-0515)', () => {
  it("sums up the timeline's witnesses and the harness's own loop delay, skipping entries without a value", () => {
    const timeline = [
      { tMs: 1_000, witness: { loopMaxSinceLastMs: 20, writeMs: 3, cpuBusyPct: 40 } },
      { tMs: 2_000, hung: true, witness: { loopMaxSinceLastMs: 300, writeMs: null, cpuBusyPct: 99.5 } },
      { tMs: 3_000, witness: { loopMaxSinceLastMs: 15, writeMs: 180, cpuBusyPct: null } },
      { tMs: 4_000 }
    ]
    expect(witnessSummary(timeline, { p99Ms: 21, maxMs: 300 })).toEqual({
      loop: { p99Ms: 21, maxMs: 300 },
      write: { maxMs: 180 },
      cpuBusyMaxPct: 99.5
    })
  })

  it('reports null for what nothing measured', () => {
    expect(witnessSummary([], null)).toEqual({ loop: null, write: { maxMs: null }, cpuBusyMaxPct: null })
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

  it('returns identical criteria and verdict with and without witness data, and carries bootStages and witness (M2-0515)', () => {
    // A machine that stalled everywhere: the witness alone must never change the verdict either way.
    const witness = { loopMaxSinceLastMs: 2_500, writeMs: 900, cpuBusyPct: 100 }
    const verdicts: string[] = []
    for (const { loop, late } of [
      { loop: { p99Ms: 12, maxMs: 40 }, late: [] as { tMs: number; hung: boolean }[] },
      { loop: { p99Ms: 12, maxMs: 460 }, late: [{ tMs: 3_000, hung: true }] }
    ]) {
      const plain = { ...emptyRun(), samples: [goodSample(1_000), goodSample(2_000)], loop }
      const witnessed = {
        ...plain,
        samples: plain.samples.map((sample) => ({ ...sample, witness })),
        late: late.map((entry) => ({ ...entry, witness })),
        witnessLoop: { p99Ms: 30, maxMs: 2_500 }
      }
      const bootStages = { stages: [{ stage: 'createWindow.construct', ms: 1_663, ts: 't', sinceSpawnMs: 1_900 }] }
      const without = report({ measured: { ...plain, late } })
      const withWitness = report({ measured: witnessed, attribution: { mainLog: null, appEvidence: null, bootStages } })
      expect(withWitness.criteria).toEqual(without.criteria)
      expect(withWitness.verdict).toBe(without.verdict)
      expect(withWitness.bootStages).toEqual(bootStages)
      expect(withWitness.witness).toEqual({ loop: { p99Ms: 30, maxMs: 2_500 }, write: { maxMs: 900 }, cpuBusyMaxPct: 100 })
      expect(withWitness.timeline.every((entry: { witness?: unknown }) => entry.witness === witness)).toBe(true)
      expect(without.bootStages).toBeNull()
      verdicts.push(withWitness.verdict)
    }
    expect(verdicts).toEqual(['PASS', 'FAIL'])
  })
})

describe('parseArgs (M2-0193)', () => {
  it('reads valued flags as camelCase keys over the defaults, and a bare flag as true wherever it stands', () => {
    expect(parseArgs(['--history', '--fixtures', 'fifo', '--cloud-dir', 'x'], { minutes: '5' })).toEqual({
      minutes: '5',
      history: 'true',
      fixtures: 'fifo',
      cloudDir: 'x'
    })
    expect(parseArgs(['--fixtures', 'none', '--minutes', '3', '--history'], { minutes: '5' })).toEqual({
      minutes: '3',
      fixtures: 'none',
      history: 'true'
    })
  })
})

describe('the History row (M2-0193)', () => {
  const open = (tMs: number, ms: number, extra: Record<string, unknown> = {}) => ({
    tMs,
    ms,
    rows: 6,
    notDownloaded: 4,
    searchMs: 40,
    hits: 4,
    ...extra
  })
  const historyRun = (history: unknown[]) => ({ ...emptyRun(), samples: [goodSample(1_000)], loop: { p99Ms: 12, maxMs: 40 }, history })
  const historyCriteria = (history: unknown[], row = 'fifo') =>
    Object.fromEntries(
      evaluateCriteria(row, historyRun(history), { stillDataless: true }, { history: true }).map((c) => [c.name, c.pass])
    )

  it('fails History open on a fast empty list, and search on the FIFO row on a fast empty result', () => {
    const empty = historyCriteria([open(20_000, 30), open(25_000, 30, { rows: 0, notDownloaded: 0, hits: 0 })])
    expect(empty['history-open < 2000']).toBe(false)
    expect(empty['history-search < 2000']).toBe(false)
    const noHits = historyCriteria([open(20_000, 30, { hits: 0 })])
    expect(noHits['history-open < 2000']).toBe(true)
    expect(noHits['history-search < 2000']).toBe(false)
  })

  it('on the dataless row, needs a not-downloaded row in every list but no search hit on the QA folder', () => {
    expect(historyCriteria([open(20_000, 30, { hits: 0 })], 'dataless')).toMatchObject({
      'history-open < 2000': true,
      'history-search < 2000': true
    })
    expect(historyCriteria([open(20_000, 30, { notDownloaded: 0 })], 'dataless')['history-open < 2000']).toBe(false)
    expect(historyCriteria([open(20_000, 30, { rows: 0, notDownloaded: 0 })], 'dataless')['history-open < 2000']).toBe(false)
  })

  it('passes when every probe, the first included, opens and searches with a usable list within 2 s', () => {
    expect(historyCriteria([open(20_000, 1_900), open(25_000, 30)])).toMatchObject({
      'history-probed': true,
      'history-open < 2000': true,
      'history-search < 2000': true
    })
  })

  it('fails History open on a first call that waits out the 2 s budget, even when every later call is fast', () => {
    const criteria = historyCriteria([open(20_000, 2_004), open(25_000, 30), open(30_000, 25)])
    expect(criteria['history-open < 2000']).toBe(false)
    expect(criteria['history-search < 2000']).toBe(true)
  })

  it('fails on a hung or failed open, and fails search on a failed or slow search alone', () => {
    expect(historyCriteria([{ tMs: 20_000, hung: true, ms: 10_000 }])['history-open < 2000']).toBe(false)
    expect(historyCriteria([{ tMs: 20_000, hung: true, ms: 10_000 }])['history-search < 2000']).toBe(false)
    expect(historyCriteria([{ tMs: 20_000, ms: 5, error: 'boom' }])['history-open < 2000']).toBe(false)
    const failedSearch = historyCriteria([open(20_000, 30, { hits: undefined, searchError: 'boom' })])
    expect(failedSearch['history-open < 2000']).toBe(true)
    expect(failedSearch['history-search < 2000']).toBe(false)
    expect(historyCriteria([open(20_000, 30, { searchMs: 2_000 })])['history-search < 2000']).toBe(false)
  })

  it('fails every History criterion when no probe reached a window, ignoring skipped probes otherwise', () => {
    const none = historyCriteria([{ tMs: 20_000, skipped: 'no window' }])
    expect(none).toMatchObject({ 'history-probed': false, 'history-open < 2000': false, 'history-search < 2000': false })
    expect(historyCriteria([{ tMs: 20_000, skipped: 'no window' }, open(25_000, 30)])['history-open < 2000']).toBe(true)
  })

  it('adds no History criterion without --history', () => {
    expect(evaluateCriteria('fifo', historyRun([open(20_000, 9_000)]), {}).map((c) => c.name)).not.toContain('history-open < 2000')
    expect(report({ measured: historyRun([open(20_000, 9_000)]) }).verdict).toBe('PASS')
  })

  it('reports the first call apart from the rest, and fails the report on it', () => {
    const measured = historyRun([{ tMs: 20_000, skipped: 'no window' }, open(25_000, 2_050), open(30_000, 30, { searchMs: 90, notDownloaded: 5 })])
    expect(historySummary(measured)).toEqual({
      probes: 2,
      firstOpenMs: 2_050,
      maxOpenMs: 2_050,
      maxSearchMs: 90,
      maxRows: 6,
      maxNotDownloaded: 5
    })
    const built = report({ row: 'fifo', history: true, measured, evidence: { exercised: true, fixturesOpened: ['x'] } })
    expect(built.historyRow).toBe(true)
    expect(built.historySummary?.firstOpenMs).toBe(2_050)
    expect(built.verdict).toBe('FAIL')
    expect(report({ row: 'fifo', history: true, measured: historyRun([open(25_000, 30)]), evidence: { exercised: true } }).verdict).toBe('PASS')
    expect(report().historySummary).toBeUndefined()
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
