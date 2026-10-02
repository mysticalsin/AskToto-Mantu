import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOOT_WINDOW_VARIANTS } from '../../src/main/infra/observability/projection'
import {
  GATED_WINDOW_STAGES,
  PENDING_GLOBAL,
  STORAGE_SATURATED_LOG,
  WINDOW_STAGE_BUDGET_MS,
  WINDOW_VARIANTS,
  bootStagesFromAudit,
  buildLaunchFailureReport,
  buildReport,
  candidateEnv,
  countStorageSaturations,
  cpuBusyPct,
  emptyRun,
  evaluateCriteria,
  historyEntry,
  historySummary,
  parseArgs,
  pinnedExpression,
  recordSample,
  releaseExpression,
  sampleExpression,
  shouldProbeHistory,
  syntheticDatalessPlan,
  runPurpose,
  timedCallsExpression,
  windowConstructionGate,
  withTimeout,
  writeJsonToStdout,
  witnessSummary
} from './lib/st-1-core.mjs'

/** Runs an expression the way Runtime.evaluate does: in global scope. */
const evaluateGlobally = (expression: string): unknown => (0, eval)(expression)
const globals = globalThis as unknown as Record<string, Record<string, unknown> | undefined>
const pending = (): Record<string, unknown> | undefined => globals[PENDING_GLOBAL]

const candidate = { build_run_id: 1, artifact_sha256: 'a'.repeat(64) }
const goodSample = (tMs: number) => ({ tMs, writeMs: 2, lookupMs: 1, loopMaxSinceLastMs: 12, resources: {} })
const refusedHistoryProbe = (tMs = 20_000, notDownloaded = 4) => ({
  tMs,
  ms: 33,
  rows: Math.max(6, notDownloaded),
  notDownloaded,
  unavailable: notDownloaded,
  searchMs: 42,
  hits: 4,
  calls: { recallList: { ms: 30 }, brainStatus: { ms: 5 }, recallSearch: { ms: 40 } }
})
const refusedRun = (notDownloaded = 4) => ({
  ...emptyRun(),
  samples: [goodSample(1_000), goodSample(2_000)],
  loop: { p99Ms: 12, maxMs: 40 },
  history: [refusedHistoryProbe(20_000, notDownloaded)]
})

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
  delete (globalThis as Record<string, unknown>).__st1since
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

  it('still returns the expression value when the in-app timer cannot be started', async () => {
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = (() => {
      throw new TypeError('testEnabled is not a function')
    }) as unknown as typeof setTimeout
    try {
      await expect(evaluateGlobally(pinnedExpression('timer-6', '41 + 1', 1_000))).resolves.toEqual({ ok: true, value: 42 })
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  it('releasing a key that was never stored is harmless', () => {
    expect(() => evaluateGlobally(releaseExpression('never-stored'))).not.toThrow()
  })
})

describe('sampleExpression', () => {
  it('carries a pre-sample boot block into sample 0 and includes the interval after the reset', async () => {
    let loopMaxNs = 80_000_000
    const reset = vi.fn(() => {
      loopMaxNs = 0
    })
    ;(globalThis as Record<string, unknown>).__st1since = {
      get max() {
        return loopMaxNs
      },
      reset
    }
    const originalGetBuiltinModule = (process as unknown as { getBuiltinModule?: (name: string) => unknown }).getBuiltinModule
    ;(process as unknown as { getBuiltinModule?: (name: string) => unknown }).getBuiltinModule = (name) => {
      if (name === 'node:fs/promises') {
        return {
          writeFile: async () => {
            loopMaxNs = 35_000_000
          }
        }
      }
      if (name === 'node:dns/promises') return { lookup: async () => ({ address: '127.0.0.1', family: 4 }) }
      throw new Error(`unexpected module ${name}`)
    }
    try {
      await expect(evaluateGlobally(sampleExpression('probe.txt'))).resolves.toMatchObject({
        loopMaxSinceLastMs: 80,
        loopMaxDuringWriteMs: 35,
        writeMs: expect.any(Number),
        lookupMs: expect.any(Number),
        resources: expect.any(Object)
      })
      expect(reset).toHaveBeenCalledTimes(2)
    } finally {
      ;(process as unknown as { getBuiltinModule?: (name: string) => unknown }).getBuiltinModule = originalGetBuiltinModule
    }
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
    expect(runPurpose({ purpose: 'window-construction', windowVariant: 'prewarm-spellchecker' })).toEqual({
      purpose: 'window-construction',
      windowVariant: 'prewarm-spellchecker'
    })
    // M2-0519: the view prewarm ships, so it is no longer a variant of its own.
    expect(runPurpose({ purpose: 'window-construction', windowVariant: 'prewarm-view' }).error).toMatch(/got "prewarm-view"/)
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
    const warmup = report({ purpose: 'window-construction', windowVariant: 'shipped', windowWarmup: true })
    expect(warmup).toMatchObject({ purpose: 'window-construction', st1Evidence: false, windowVariant: 'shipped', warmup: true })
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

describe('windowConstructionGate (M2-0519)', () => {
  const stage = (name: string, ms: number | null, transparent?: boolean) => ({
    stage: name,
    ms,
    ts: '2026-10-01T10:00:00.000Z',
    ...(transparent === undefined ? {} : { transparent, windowVariant: 'shipped' })
  })
  const windowReport = (windowVariant: string, stages: unknown[] | null) => ({
    harness: 'ST-1',
    purpose: 'window-construction',
    st1Evidence: false,
    windowVariant,
    bootStages: stages === null ? null : { stages }
  })
  const shipped = (transparent: boolean, prewarmMs: number | null, constructMs: number | null) =>
    windowReport('shipped', [
      stage('createWindow.prewarm', prewarmMs, transparent),
      stage('createWindow.construct', constructMs, transparent),
      stage('createWindow.navigate', 400),
      stage('createTray.newTray', 900)
    ])
  const passing = [
    { name: 'window-shipped-opaque-1/a.json', report: shipped(false, 12, 111) },
    { name: 'window-shipped-transparent-1/a.json', report: shipped(true, 9, 93) }
  ]

  it('passes when every shipped prewarm and construct is under 250 ms in both chromes, ignoring other stages and variants', () => {
    const gate = windowConstructionGate([
      ...passing,
      { name: 'window-spellcheck-off-opaque-1/a.json', report: windowReport('spellcheck-off', [stage('createWindow.construct', 900, false)]) },
      { name: 'st-1.json', report: { harness: 'ST-1', row: 'none' } }
    ])
    expect(gate).toMatchObject({ pass: true, budgetMs: 250, failures: [] })
    expect(gate.rows).toEqual([
      { report: 'window-shipped-opaque-1/a.json', stage: 'createWindow.prewarm', chrome: 'opaque', ms: 12 },
      { report: 'window-shipped-opaque-1/a.json', stage: 'createWindow.construct', chrome: 'opaque', ms: 111 },
      { report: 'window-shipped-transparent-1/a.json', stage: 'createWindow.prewarm', chrome: 'transparent', ms: 9 },
      { report: 'window-shipped-transparent-1/a.json', stage: 'createWindow.construct', chrome: 'transparent', ms: 93 }
    ])
  })

  it('fails a shipped prewarm or construct at or over 250 ms, in either chrome', () => {
    const gate = windowConstructionGate([
      { name: 'o.json', report: shipped(false, 250, 111) },
      { name: 't.json', report: shipped(true, 9, 595) }
    ])
    expect(gate.pass).toBe(false)
    expect(gate.failures).toEqual(['o.json: createWindow.prewarm 250 ms >= 250 ms', 't.json: createWindow.construct 595 ms >= 250 ms'])
  })

  it('fails a shipped report missing a gated stage, a launch without boot stages, and a stage without ms or chrome', () => {
    const gate = windowConstructionGate([
      ...passing,
      { name: 'no-prewarm.json', report: windowReport('shipped', [stage('createWindow.construct', 100, false)]) },
      { name: 'launch-failed.json', report: windowReport('shipped', null) },
      { name: 'no-ms.json', report: shipped(true, null, 100) },
      { name: 'no-chrome.json', report: windowReport('shipped', [stage('createWindow.prewarm', 5), stage('createWindow.construct', 100, true)]) }
    ])
    expect(gate.pass).toBe(false)
    expect(gate.failures).toEqual([
      'no-prewarm.json: createWindow.prewarm missing',
      'launch-failed.json: createWindow.prewarm missing',
      'launch-failed.json: createWindow.construct missing',
      'no-ms.json: createWindow.prewarm has no measured ms',
      'no-chrome.json: createWindow.prewarm does not say which chrome it built'
    ])
  })

  it('fails when a chrome was never measured, and when there is no shipped report at all', () => {
    expect(windowConstructionGate([passing[0]]).failures).toEqual(['no shipped transparent window was measured'])
    expect(windowConstructionGate([]).failures).toEqual(['no shipped window-construction report'])
    const variantsOnly = windowConstructionGate([{ name: 'v.json', report: windowReport('prewarm-spellchecker', [stage('createWindow.construct', 100, false)]) }])
    expect(variantsOnly).toMatchObject({ pass: false, failures: ['no shipped window-construction report'] })
  })

  it('skips marked warm-up reports, counts them, and still fails a slow measured shipped run', () => {
    const gate = windowConstructionGate([
      { name: 'window-warmup-opaque/window-warmup-opaque.json', report: { ...shipped(false, 12, 900), warmup: true } },
      ...passing,
      { name: 'window-shipped-transparent-2/a.json', report: shipped(true, 9, 250) }
    ])
    expect(gate.skippedWarmups).toBe(1)
    expect(gate.rows.map((row) => row.report)).not.toContain('window-warmup-opaque/window-warmup-opaque.json')
    expect(gate.pass).toBe(false)
    expect(gate.failures).toContain('window-shipped-transparent-2/a.json: createWindow.construct 250 ms >= 250 ms')
  })

  it('holds the gated stages to 250 ms', () => {
    expect(WINDOW_STAGE_BUDGET_MS).toBe(250)
    expect(GATED_WINDOW_STAGES).toEqual(['createWindow.prewarm', 'createWindow.construct'])
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

describe('shouldProbeHistory', () => {
  const due = { historyOn: true, historyRunning: null, tMs: 20_000, historyLastMs: -Infinity, fromMs: 20_000, everyMs: 5_000 }

  it('schedules the first due History probe only when History is on and idle', () => {
    expect(shouldProbeHistory(due)).toBe(true)
    expect(shouldProbeHistory({ ...due, historyOn: false })).toBe(false)
    expect(shouldProbeHistory({ ...due, historyRunning: Promise.resolve() })).toBe(false)
    expect(shouldProbeHistory({ ...due, tMs: 19_999 })).toBe(false)
  })

  it('waits for the configured interval after the previous History probe', () => {
    expect(shouldProbeHistory({ ...due, tMs: 24_999, historyLastMs: 20_000 })).toBe(false)
    expect(shouldProbeHistory({ ...due, tMs: 25_000, historyLastMs: 20_000 })).toBe(true)
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

  it('exercises a fifo row when History refused enough fixture meetings and brainStatus answered', () => {
    const built = report({
      row: 'fifo',
      fixtures: ['one.md', 'two.md', '.brain/index.json'],
      measured: refusedRun(2),
      evidence: { fixturesOpened: [], fifoMeetingFixtures: 2 }
    })
    expect(built.verdict).toBe('PASS')
    expect(built.exercised).toBe(true)
    expect(built.exerciseEvidence).toEqual({
      exercised: true,
      reason: 'history-refused-fixtures',
      historyProbesAnswered: 1,
      unavailableRows: 2,
      requiredUnavailableRows: 2,
      brainStatusAnswered: true
    })
    expect(built.fixturesOpened).toEqual([])
  })

  it('exercises a fifo row for locked Unavailable rows even when they are not marked not-downloaded', () => {
    const built = report({
      row: 'fifo',
      fixtures: ['one.md', 'two.md'],
      measured: {
        ...refusedRun(0),
        history: [
          {
            ...refusedHistoryProbe(20_000, 0),
            rows: 2,
            notDownloaded: 0,
            unavailable: 2
          }
        ]
      },
      evidence: { fixturesOpened: [], fifoMeetingFixtures: 2 }
    })
    expect(built.verdict).toBe('PASS')
    expect(built.exerciseEvidence).toMatchObject({
      exercised: true,
      unavailableRows: 2,
      requiredUnavailableRows: 2,
      brainStatusAnswered: true
    })
  })

  it('reports a fifo row History never answered as NOT_EXERCISED, naming the missing refusal evidence', () => {
    const built = report({
      row: 'fifo',
      fixtures: ['one.md', 'two.md'],
      measured: { ...emptyRun(), samples: [goodSample(1_000)], loop: { p99Ms: 12, maxMs: 40 }, history: [{ tMs: 20_000, skipped: 'no window' }] },
      evidence: { fixturesOpened: [], fifoMeetingFixtures: 2 }
    })
    expect(built.verdict).toBe('NOT_EXERCISED')
    expect(built.exercised).toBe(false)
    expect(built.exerciseEvidence).toMatchObject({
      reason: 'history-did-not-prove-refusal',
      historyProbesAnswered: 0,
      unavailableRows: null,
      requiredUnavailableRows: 2,
      brainStatusAnswered: false
    })
  })

  it('fails a fifo row with its own criterion when any fixture has a reader at the end', () => {
    const built = report({
      row: 'fifo',
      fixtures: ['one.md'],
      measured: refusedRun(1),
      evidence: { fixturesOpened: ['one.md'], fifoMeetingFixtures: 1 }
    })
    expect(built.verdict).toBe('FAIL')
    expect(built.criteria.find((c: { name: string }) => c.name === 'non-regular-fixtures-unopened')).toEqual({
      name: 'non-regular-fixtures-unopened',
      pass: false
    })
  })

  it('reports the main.log offset or the reason it is unknown', () => {
    expect(report({ attribution: { mainLog: { path: 'x', fromByte: 5, exactLaunchOffset: false }, appEvidence: null } }).mainLog).toEqual({
      fromByte: 5,
      exactLaunchOffset: false
    })
    expect(report({ attribution: { mainLog: { error: 'no require' }, appEvidence: null } }).mainLog).toEqual({ error: 'no require' })
  })

  it('reports when Profiler.start was requested and answered without changing the verdict', () => {
    const plain = report()
    const profiler = { requestedAtMs: 615, answeredAtMs: 694, startedAtMs: 694, stoppedAtMs: 300_000, file: 'st-1.cpuprofile' }
    const withProfiler = report({ measured: { ...emptyRun(), samples: [goodSample(1_000), goodSample(2_000)], loop: { p99Ms: 12, maxMs: 40 }, profiler } })
    expect(withProfiler.cpuProfile).toEqual(profiler)
    expect(withProfiler.criteria).toEqual(plain.criteria)
    expect(withProfiler.verdict).toBe(plain.verdict)
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
    expect(parseArgs(['--fixtures', 'synthetic-dataless', '--history', 'off'], { minutes: '5' })).toEqual({
      minutes: '5',
      fixtures: 'synthetic-dataless',
      history: 'off'
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
    const measured = historyRun([
      { tMs: 20_000, skipped: 'no window' },
      {
        ...open(25_000, 2_050, { notDownloaded: 5, unavailable: 5 }),
        calls: { recallList: { ms: 2_050 }, brainStatus: { ms: 5 }, recallSearch: { ms: 90 } }
      },
      {
        ...open(30_000, 30, { searchMs: 90, notDownloaded: 5, unavailable: 5 }),
        calls: { recallList: { ms: 30 }, brainStatus: { ms: 5 }, recallSearch: { ms: 90 } }
      }
    ])
    expect(historySummary(measured)).toEqual({
      probes: 2,
      firstOpenMs: 2_050,
      maxOpenMs: 2_050,
      maxSearchMs: 90,
      maxRows: 6,
      maxNotDownloaded: 5,
      calls: {
        recallList: { calls: 2, unsettled: 0, firstMs: 2_050, p50Ms: 30, p95Ms: 2_050, maxMs: 2_050 },
        brainStatus: { calls: 2, unsettled: 0, firstMs: 5, p50Ms: 5, p95Ms: 5, maxMs: 5 },
        recallSearch: { calls: 2, unsettled: 0, firstMs: 90, p50Ms: 90, p95Ms: 90, maxMs: 90 }
      },
      checks: [
        { name: 'first-list < 250', pass: false },
        { name: 'list < 2000', pass: false },
        { name: 'search < 2000', pass: true },
        { name: 'loop-p99 < 50', pass: true }
      ],
      verdict: 'FAIL',
      storageSaturations: null,
      firstListCause: 'main-log-unread'
    })
    const built = report({ row: 'fifo', history: true, measured, evidence: { fixturesOpened: [], fifoMeetingFixtures: 5 } })
    expect(built.historyRow).toBe(true)
    expect(built.historySummary?.firstOpenMs).toBe(2_050)
    expect(built.exerciseEvidence).toMatchObject({ exercised: true, unavailableRows: 5, brainStatusAnswered: true })
    expect(built.criteria.find((c: { name: string }) => c.name === 'non-regular-fixtures-unopened')).toEqual({
      name: 'non-regular-fixtures-unopened',
      pass: true
    })
    expect(built.verdict).toBe('FAIL')
    expect(report({ row: 'fifo', history: true, measured: refusedRun(0), evidence: { fixturesOpened: [], fifoMeetingFixtures: 0 } }).verdict).toBe('PASS')
    expect(report().historySummary).toBeUndefined()
  })
})

describe('timedCallsExpression (M2-0512)', () => {
  it('times every call on its own and records a value, a failure or a hang, never rejecting', async () => {
    const outcomes = (await evaluateGlobally(
      timedCallsExpression({ answered: 'Promise.resolve(3)', failed: 'Promise.reject(new Error("refused"))', hung: 'new Promise(() => {})' }, 50)
    )) as Record<string, { ms: number; value?: unknown; error?: string; hung?: boolean }>
    expect(Object.keys(outcomes)).toEqual(['answered', 'failed', 'hung'])
    expect(outcomes.answered).toEqual({ ms: expect.any(Number), value: 3 })
    expect(outcomes.failed).toEqual({ ms: expect.any(Number), error: 'refused' })
    expect(outcomes.hung).toEqual({ ms: expect.any(Number), hung: true })
    expect(outcomes.hung.ms).toBeGreaterThanOrEqual(45)
    expect(outcomes.answered.ms).toBeLessThan(outcomes.hung.ms)
  })
})

describe('writeJsonToStdout', () => {
  it('waits for stdout to accept a report over 64 KiB before returning', async () => {
    const chunks: string[] = []
    let flushed = false
    const report = { harness: 'ST-1', body: 'x'.repeat(70 * 1024) }
    const stdout = {
      write(text: string, callback: (error?: Error | null) => void) {
        chunks.push(text)
        setTimeout(() => {
          flushed = true
          callback()
        }, 0)
        return false
      }
    }

    await writeJsonToStdout(report, stdout as unknown as typeof process.stdout)

    expect(flushed).toBe(true)
    expect(chunks.join('').length).toBeGreaterThan(64 * 1024)
    expect(JSON.parse(chunks.join(''))).toEqual(report)
  })
})

describe('the History row per call (M2-0512)', () => {
  type Call = { ms: number; value?: unknown; error?: string; hung?: boolean }
  /** A probe as the app answers it: per-call outcomes from the renderer, run through historyEntry. */
  const probe = (tMs: number, calls: { list?: Call; brain?: Call; search?: Call } = {}): Record<string, unknown> =>
    historyEntry(tMs, {
      ok: true,
      elapsedMs: 0,
      value: {
        ms: Math.max(calls.list?.ms ?? 30, calls.brain?.ms ?? 5) + 3,
        open: { recallList: calls.list ?? { ms: 30, value: { rows: 6, notDownloaded: 4 } }, brainStatus: calls.brain ?? { ms: 5, value: true } },
        searchMs: (calls.search?.ms ?? 40) + 2,
        search: calls.search ?? { ms: 40, value: 4 }
      }
    })
  const list = (ms: number, value = { rows: 6, notDownloaded: 4 }) => ({ list: { ms, value } })
  const run = (history: unknown[], p99Ms = 12) => ({ ...emptyRun(), samples: [goodSample(1_000)], loop: { p99Ms, maxMs: 40 }, history })
  type Options = { row?: string; complete?: boolean; storageSaturations?: number | null }
  const summary = (history: unknown[], options: Options = {}) => historySummary(run(history), { row: 'fifo', ...options })
  const checks = (history: unknown[], options: Options = {}) =>
    Object.fromEntries(summary(history, options).checks.map((c: { name: string; pass: boolean }) => [c.name, c.pass]))

  it('records each call with its own time and keeps the combined fields, never a value', () => {
    expect(probe(20_000)).toEqual({
      tMs: 20_000,
      ms: 33,
      rows: 6,
      notDownloaded: 4,
      searchMs: 42,
      hits: 4,
      calls: { recallList: { ms: 30 }, brainStatus: { ms: 5 }, recallSearch: { ms: 40 } }
    })
  })

  it('makes the open hung or failed when one of its calls is, and a hung or failed search a searchError', () => {
    expect(probe(20_000, { brain: { ms: 4_000, hung: true } })).toMatchObject({
      hung: true,
      rows: 6,
      calls: { recallList: { ms: 30 }, brainStatus: { ms: 4_000, hung: true } }
    })
    const failedList = probe(20_000, { list: { ms: 12, error: 'boom' } })
    expect(failedList).toMatchObject({ error: 'boom', calls: { recallList: { ms: 12, error: 'boom' } } })
    expect(failedList.rows).toBeUndefined()
    const hungSearch = probe(20_000, { search: { ms: 4_000, hung: true } })
    expect(hungSearch).toMatchObject({ searchError: 'no answer within 4000 ms', calls: { recallSearch: { ms: 4_000, hung: true } } })
    expect(hungSearch.hits).toBeUndefined()
    expect(probe(20_000, { search: { ms: 9, error: 'index gone' } })).toMatchObject({ searchError: 'index gone' })
  })

  it('gives firstMs and p50/p95/max per call by nearest rank', () => {
    const calls = summary([probe(20_000, list(100)), probe(25_000, list(30)), probe(30_000, list(20)), probe(35_000, list(40))]).calls
    expect(calls.recallList).toEqual({ calls: 4, unsettled: 0, firstMs: 100, p50Ms: 30, p95Ms: 100, maxMs: 100 })
    expect(calls.brainStatus).toMatchObject({ calls: 4, firstMs: 5, maxMs: 5 })
    expect(calls.recallSearch).toMatchObject({ calls: 4, firstMs: 40, p50Ms: 40 })
  })

  it('passes a first recallList at 249 ms and fails it at 250 ms, naming the cause from the main.log', () => {
    expect(summary([probe(20_000, list(249)), probe(25_000)])).toMatchObject({ verdict: 'PASS', firstListCause: null })
    const slow = [probe(20_000, list(250)), probe(25_000)]
    expect(checks(slow)['first-list < 250']).toBe(false)
    expect(summary(slow)).toMatchObject({ verdict: 'FAIL', firstListCause: 'main-log-unread' })
    expect(summary(slow, { storageSaturations: 2 })).toMatchObject({ storageSaturations: 2, firstListCause: 'admission-saturated' })
    expect(summary(slow, { storageSaturations: 0 }).firstListCause).toBe('unattributed')
  })

  it('needs every list and search to settle with a usable answer below 2 s: 1999 ms passes, 2000 ms fails', () => {
    expect(checks([probe(20_000), probe(25_000, list(1_999))])['list < 2000']).toBe(true)
    expect(checks([probe(20_000), probe(25_000, list(2_000))])['list < 2000']).toBe(false)
    expect(checks([probe(20_000), probe(25_000, { search: { ms: 1_999, value: 1 } })])['search < 2000']).toBe(true)
    expect(checks([probe(20_000), probe(25_000, { search: { ms: 2_000, value: 1 } })])['search < 2000']).toBe(false)
    expect(checks([probe(20_000), probe(25_000, list(30, { rows: 0, notDownloaded: 0 }))])['list < 2000']).toBe(false)
    expect(checks([probe(20_000), probe(25_000, { search: { ms: 30, value: 0 } })])['search < 2000']).toBe(false)
    expect(checks([probe(20_000, list(30, { rows: 6, notDownloaded: 0 }))], { row: 'dataless' })['list < 2000']).toBe(false)
  })

  it('fails on main-loop p99 at 50 ms and passes below it', () => {
    expect(historySummary(run([probe(20_000)], 49.9), { row: 'fifo' }).verdict).toBe('PASS')
    expect(historySummary(run([probe(20_000)], 50), { row: 'fifo' })).toMatchObject({ verdict: 'FAIL', firstListCause: null })
  })

  it('fails every check on an empty probe set, with no first-call cause to name', () => {
    for (const history of [[], [{ tMs: 20_000, skipped: 'no window' }]]) {
      expect(summary(history)).toMatchObject({
        probes: 0,
        verdict: 'FAIL',
        firstListCause: null,
        calls: { recallList: { calls: 0, firstMs: null, p50Ms: null, p95Ms: null, maxMs: null } }
      })
      expect(checks(history)).toEqual({ 'first-list < 250': false, 'list < 2000': false, 'search < 2000': false, 'loop-p99 < 50': true })
    }
  })

  it('fails on a hung probe, whether the whole round trip or one call hung', () => {
    const wholeHung = [{ tMs: 20_000, hung: true, ms: 10_000 }, probe(25_000)]
    expect(summary(wholeHung, { storageSaturations: 1 })).toMatchObject({ verdict: 'FAIL', firstListCause: 'admission-saturated' })
    expect(summary(wholeHung).calls.recallList).toMatchObject({ calls: 1, firstMs: null })
    const listHung = [probe(20_000, { list: { ms: 4_000, hung: true } }), probe(25_000)]
    expect(checks(listHung)).toMatchObject({ 'first-list < 250': false, 'list < 2000': false, 'search < 2000': true })
    expect(summary(listHung).calls.recallList).toMatchObject({ unsettled: 1, firstMs: 4_000, maxMs: 4_000 })
    const searchHung = [probe(20_000), probe(25_000, { search: { ms: 4_000, hung: true } })]
    expect(checks(searchHung)).toMatchObject({ 'first-list < 250': true, 'list < 2000': true, 'search < 2000': false })
  })

  it('says INCOMPLETE while the run is not complete, and never changes the report criteria or verdict', () => {
    expect(summary([probe(20_000)], { complete: false }).verdict).toBe('INCOMPLETE')
    const slowFirst = run([probe(20_000, list(1_500)), probe(25_000)])
    const built = report({
      row: 'fifo',
      history: true,
      measured: slowFirst,
      evidence: { fixturesOpened: [], fifoMeetingFixtures: 0 },
      attribution: { mainLog: null, appEvidence: null, storageSaturations: 3 }
    })
    expect(built.verdict).toBe('PASS')
    expect(built.criteria.map((c: { name: string }) => c.name)).not.toContain('first-list < 250')
    expect(built.historySummary).toMatchObject({ verdict: 'FAIL', storageSaturations: 3, firstListCause: 'admission-saturated' })
    expect(report({ row: 'fifo', history: true, measured: slowFirst, evidence: { fixturesOpened: [], fifoMeetingFixtures: 0 }, complete: false }).historySummary?.verdict).toBe('INCOMPLETE')
  })

  it('counts the admission saturation lines of a main.log', () => {
    const line = `[2026-10-01 10:00:00.000] [warn] ${STORAGE_SATURATED_LOG}; meetings-root requests are degraded { capacity: 2 }`
    expect(countStorageSaturations(['[info] boot', line, '[info] tray', line].join('\n'))).toBe(2)
    expect(countStorageSaturations('[info] boot\n')).toBe(0)
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
  const syntheticFixtures = [
    ...Array.from({ length: 6 }, (_, i) => `fixture-${i + 1}.md`),
    '.brain/index.json',
    ...Array.from({ length: 4 }, (_, i) => `.brain/entities/st1-${i + 1}.json`)
  ]
  const synthetic = (overrides: Record<string, unknown> = {}) =>
    report({
      row: 'synthetic-dataless',
      fixtures: syntheticFixtures,
      fixtureCounts: syntheticDatalessPlan().counts,
      measured: refusedRun(6),
      evidence: { fixturesOpened: [], fifoMeetingFixtures: 6, sfDatalessSet: false },
      ...overrides
    })

  it('records the fixture kind, the counts and that SF_DATALESS was set on none', () => {
    const built = synthetic()
    expect(built.fixtureKind).toBe('synthetic-dataless')
    expect(built.fixtureCounts).toEqual({ localMeetings: 53, fifoMeetings: 6, brainFifos: 5 })
    expect(built.sfDatalessSet).toBe(false)
    expect(built.verdict).toBe('PASS')
  })

  it('uses the fifo row refused-without-opening rule and the same timing criteria', () => {
    expect(synthetic({ measured: { ...refusedRun(5) }, evidence: { fixturesOpened: [], fifoMeetingFixtures: 6, sfDatalessSet: false } }).verdict).toBe(
      'NOT_EXERCISED'
    )
    expect(synthetic().criteria.slice(0, report().criteria.length)).toEqual(report().criteria)
    expect(synthetic({ measured: { ...refusedRun(6), loop: { p99Ms: 12, maxMs: 460 } } }).verdict).toBe('FAIL')
  })

  it('reports historyMode on by default and off when asked, and adds nothing to other rows', () => {
    expect(report().historyMode).toBe('on')
    expect(report({ historyMode: 'off' }).historyMode).toBe('off')
    expect(report({ historyMode: 'off' }).history).toEqual([])
    expect(report({ row: 'fifo', measured: refusedRun(0), evidence: { fixturesOpened: [], fifoMeetingFixtures: 0 } })).not.toHaveProperty('fixtureKind')
    expect(report()).not.toHaveProperty('sfDatalessSet')
  })
})
