import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COUNTED_EVENTS } from '../census/audit-counts.mjs'
import { isChordHelperCommand, parsePsResourceRows, parsePsTime, sampleTree, totalRss } from './sampler.mjs'
import { MIB, MINUTE_MS, THRESHOLDS, evaluateSoak, planPhases, renderSummary } from './soak-verdict.mjs'
import { auditCountsByPhase, resolveSoakConfig, summarizeQueue } from './soak.mjs'

type Sample = {
  tMs: number
  mainAlive: boolean
  processes: { pid: number; startedMs: number; kind: string; rssBytes: number | null; cpuSeconds: number | null }[]
}

/** A synthetic soak: `perMinute` is total RSS growth per minute, `cpuPerSecond` the one-core CPU fraction. */
type SampleOptions = {
  minutes: number
  intervalMs?: number
  baseMiB?: number
  growthMiBPerMinute?: number
  cpu?: number
  extraProcessAt?: number | null
  mainDeadAt?: number | null
}
function makeSamples({
  minutes,
  intervalMs = 30_000,
  baseMiB = 600,
  growthMiBPerMinute = 0,
  cpu = 0.01,
  extraProcessAt = null,
  mainDeadAt = null
}: SampleOptions): Sample[] {
  const samples: Sample[] = []
  for (let t = 0; t <= minutes * MINUTE_MS; t += intervalMs) {
    const total = (baseMiB + (growthMiBPerMinute * t) / MINUTE_MS) * MIB
    const processes = [
      { pid: 100, startedMs: 1, kind: 'main', rssBytes: total * 0.5, cpuSeconds: (t / 1000) * cpu },
      { pid: 101, startedMs: 2, kind: 'renderer', rssBytes: total * 0.5, cpuSeconds: (t / 1000) * cpu }
    ]
    if (extraProcessAt !== null && t >= extraProcessAt)
      for (let i = 0; i < 6; i += 1)
        processes.push({ pid: 200 + i, startedMs: 3, kind: 'other', rssBytes: 1 * MIB, cpuSeconds: 0 })
    samples.push({ tMs: t, mainAlive: mainDeadAt === null || t < mainDeadAt, processes })
  }
  return samples
}

const phases = (idle: number, meeting: number, post: number) => [
  { id: 'idle', startMs: 0, endMs: idle * MINUTE_MS },
  { id: 'meeting', startMs: idle * MINUTE_MS, endMs: (idle + meeting) * MINUTE_MS },
  { id: 'post', startMs: (idle + meeting) * MINUTE_MS, endMs: (idle + meeting + post) * MINUTE_MS }
]

describe('planPhases', () => {
  it('splits 60 minutes into 40% idle, 50% meeting and 10% post by default', () => {
    expect(planPhases({ minutes: 60 })).toEqual([
      { id: 'idle', minutes: 24 },
      { id: 'meeting', minutes: 30 },
      { id: 'post', minutes: 6 }
    ])
  })

  it('honours explicit minutes, drops empty phases and rejects a plan that does not fit', () => {
    expect(planPhases({ minutes: 20, idleMinutes: 5, meetingMinutes: 15 })).toEqual([
      { id: 'idle', minutes: 5 },
      { id: 'meeting', minutes: 15 }
    ])
    expect(() => planPhases({ minutes: 10, idleMinutes: 8, meetingMinutes: 5 })).toThrow(/exceed/)
    expect(() => planPhases({ minutes: 0 })).toThrow()
  })
})

describe('evaluateSoak', () => {
  it('passes a flat 60-minute soak and states it is a full soak', () => {
    const samples = makeSamples({ minutes: 60 })
    const verdict = evaluateSoak({ samples, phases: phases(24, 30, 6), intervalMs: 30_000, requestedMinutes: 60 })
    expect(verdict.failed).toEqual([])
    expect(verdict.outcome).toBe('PASS')
    expect(verdict.fullSoak).toBe(true)
    expect(verdict.checks.map((check) => check.family).sort()).toEqual([
      'C1',
      'C1',
      'P1',
      'P1',
      'POST-P',
      'POST-R',
      'R1',
      'R1',
      'R2',
      'R2'
    ])
  })

  it('fails sustained idle RSS growth beyond the bound, naming the check', () => {
    // 2 MiB/min is 120 MiB per hour: over max(64 MiB, 10% of ~600 MiB)
    const samples = makeSamples({ minutes: 60, growthMiBPerMinute: 2 })
    const verdict = evaluateSoak({ samples, phases: phases(24, 30, 6), intervalMs: 30_000, requestedMinutes: 60 })
    expect(verdict.outcome).toBe('FAIL')
    expect(verdict.failed).toContain('R1-idle')
  })

  it('does not fail growth inside the bound', () => {
    const samples = makeSamples({ minutes: 60, growthMiBPerMinute: 0.5 }) // 30 MiB/h
    expect(evaluateSoak({ samples, phases: phases(24, 30, 6), intervalMs: 30_000, requestedMinutes: 60 }).outcome).toBe(
      'PASS'
    )
  })

  it('fails a process-count increase and a CPU climb', () => {
    const many = makeSamples({ minutes: 60, extraProcessAt: 40 * MINUTE_MS })
    const verdict = evaluateSoak({ samples: many, phases: phases(24, 30, 6), intervalMs: 30_000, requestedMinutes: 60 })
    expect(verdict.failed.some((id) => id.startsWith('P1'))).toBe(true)
    // CPU that rises from 1% to 30% of a core inside the idle window
    const samples = makeSamples({ minutes: 60 })
    let accumulated = 0
    for (const sample of samples) {
      const rate = sample.tMs < 12 * MINUTE_MS ? 0.01 : 0.3
      accumulated += rate * 30
      sample.processes[0].cpuSeconds = accumulated
    }
    expect(
      evaluateSoak({ samples, phases: phases(24, 30, 6), intervalMs: 30_000, requestedMinutes: 60 }).failed
    ).toContain('C1-idle')
  })

  it('is FAIL when main dies, INCOMPLETE when too few samples were taken', () => {
    const dead = makeSamples({ minutes: 60, mainDeadAt: 50 * MINUTE_MS })
    expect(
      evaluateSoak({ samples: dead, phases: phases(24, 30, 6), intervalMs: 30_000, requestedMinutes: 60 }).outcome
    ).toBe('FAIL')
    const sparse = makeSamples({ minutes: 60, intervalMs: 150_000 })
    const verdict = evaluateSoak({
      samples: sparse,
      phases: phases(24, 30, 6),
      intervalMs: 30_000,
      requestedMinutes: 60
    })
    expect(verdict.outcome).toBe('INCOMPLETE')
    expect(verdict.failed).toContain('V-SAMPLES')
  })

  it('is INCOMPLETE for samples with a missing RSS reading rather than guessing', () => {
    const samples = makeSamples({ minutes: 60 })
    for (const sample of samples) sample.processes[1].rssBytes = null
    expect(evaluateSoak({ samples, phases: phases(24, 30, 6), intervalMs: 30_000, requestedMinutes: 60 }).outcome).toBe(
      'INCOMPLETE'
    )
  })

  it('flags a run shorter than 60 minutes as not a full soak', () => {
    const samples = makeSamples({ minutes: 8 })
    const verdict = evaluateSoak({ samples, phases: phases(3, 4, 1), intervalMs: 30_000, requestedMinutes: 8 })
    expect(verdict.fullSoak).toBe(false)
  })

  it('requires the post-meeting RSS to come back near the meeting reference', () => {
    const samples = makeSamples({ minutes: 60 })
    for (const sample of samples)
      if (sample.tMs >= 54 * MINUTE_MS)
        for (const process of sample.processes) process.rssBytes = (process.rssBytes ?? 0) * 3
    const verdict = evaluateSoak({ samples, phases: phases(24, 30, 6), intervalMs: 30_000, requestedMinutes: 60 })
    expect(verdict.failed).toContain('POST-R-post')
  })

  it('needs at least one phase', () => {
    expect(() => evaluateSoak({ samples: [], phases: [], intervalMs: 30_000, requestedMinutes: 60 })).toThrow(
      /at least one phase/
    )
  })
})

describe('absolute idle CPU budget (C30 / D10-9, PROPOSED, advisory)', () => {
  it('reports the idle-window mean one-core CPU against the proposed 5% budget and records the layout', () => {
    // cpu 0.2 per process and two processes: 40% of one core, the 2.12.0 bar-layout idle shape.
    const hot = evaluateSoak({
      samples: makeSamples({ minutes: 60, cpu: 0.2 }),
      phases: phases(24, 30, 6),
      intervalMs: 30_000,
      requestedMinutes: 60,
      layout: 'bar'
    })
    expect(THRESHOLDS.idle.absoluteCpuBudgetPercent).toBe(5)
    expect(hot.budgets).toHaveLength(1)
    const [budget] = hot.budgets
    expect(budget).toMatchObject({ id: 'B1-idle', status: 'PROPOSED', layout: 'bar', bound: 5, within: false })
    expect(budget.measured).toBeCloseTo(40, 1)
    // Advisory until the owner accepts the threshold: it never changes the outcome or the failed list.
    expect(hot.outcome).toBe('PASS')
    expect(hot.failed).not.toContain('B1-idle')
    const markdown = renderSummary({ verdict: hot, queue: summarizeQueue([]) })
    expect(markdown).toContain('## Absolute idle CPU budget (PROPOSED, advisory)')
    expect(markdown).toContain('OVER B1-idle: 40 (bound 5; mean one-core CPU % over the idle window; layout bar)')
  })

  it('is within the budget for a quiet idle, and says when the layout was not recorded', () => {
    const quiet = evaluateSoak({
      samples: makeSamples({ minutes: 60, cpu: 0.01 }),
      phases: phases(24, 30, 6),
      intervalMs: 30_000,
      requestedMinutes: 60
    })
    expect(quiet.budgets[0]).toMatchObject({ within: true, layout: 'unrecorded' })
    expect(renderSummary({ verdict: quiet, queue: summarizeQueue([]) })).toContain('WITHIN B1-idle: 2 (bound 5')
  })
})

describe('summary', () => {
  it('states the thresholds, the outcome and the queue status', () => {
    const verdict = evaluateSoak({
      samples: makeSamples({ minutes: 60 }),
      phases: phases(24, 30, 6),
      intervalMs: 30_000,
      requestedMinutes: 60
    })
    const markdown = renderSummary({
      verdict,
      queue: summarizeQueue([{ available: false }]),
      meta: { appVersion: '2.12.0', bundleId: 'com.mantu.asktoto.qa' }
    })
    expect(markdown).toContain('Outcome: **PASS**')
    expect(markdown).toContain('max(64 MiB, 10% of reference)')
    expect(markdown).toContain('max(160 MiB, 20% of reference)')
    expect(markdown).toContain('queue: NOT_INSTRUMENTED')
    expect(markdown).not.toContain('NOT A FULL')
    const short = evaluateSoak({
      samples: makeSamples({ minutes: 8 }),
      phases: phases(3, 4, 1),
      intervalMs: 30_000,
      requestedMinutes: 8
    })
    expect(renderSummary({ verdict: short, queue: summarizeQueue([]) })).toContain('NOT A FULL 60-MINUTE SOAK')
    expect(THRESHOLDS.fullSoakMinutes).toBe(60)
  })
})

describe('queue summary', () => {
  it('reports NOT_INSTRUMENTED with where the metric would come from when no poll returned a status', () => {
    const queue = summarizeQueue([{ available: false }, { available: false, error: 'x' }])
    expect(queue.status).toBe('NOT_INSTRUMENTED')
    expect(queue.reason).toContain('window.toto.brainStatus()')
    expect(queue.reason).toContain('src/main/parakeet.ts')
  })

  it('reports the measured maxima when the ingest queue was readable', () => {
    const queue = summarizeQueue([
      { available: true, livePending: 0, backfillRemaining: 2 },
      { available: true, livePending: 3, backfillRemaining: 0 },
      { available: false }
    ])
    expect(queue).toMatchObject({
      status: 'MEASURED',
      samples: 2,
      polls: 3,
      maxLivePending: 3,
      maxBackfillRemaining: 2
    })
  })
})

describe('sampler', () => {
  it('parses ps TIME in every shape', () => {
    expect(parsePsTime('0:01.50')).toBe(1.5)
    expect(parsePsTime('12:34.00')).toBe(754)
    expect(parsePsTime('1:02:03')).toBe(3723)
    expect(parsePsTime('2-03:04:05')).toBe(2 * 86_400 + 3 * 3600 + 4 * 60 + 5)
    expect(parsePsTime('garbage')).toBeNaN()
  })

  it('parses resource rows including commands with spaces', () => {
    const rows = parsePsResourceRows(
      '  100  204800  0:12.34 /s/Applications/Metis QA.app/Contents/MacOS/Metis QA\n 101 51200 1:00.00 /x/Helper (Renderer) --type=renderer\nnoise\n'
    )
    expect(rows.get(100)).toEqual({
      rssBytes: 204800 * 1024,
      cpuSeconds: 12.34,
      command: '/s/Applications/Metis QA.app/Contents/MacOS/Metis QA'
    })
    expect(rows.get(101)?.command).toContain('--type=renderer')
    expect(rows.size).toBe(2)
  })

  it('samples the owned tree structurally and classifies helpers', () => {
    const root = '/s/Applications/Metis QA.app'
    const table = [
      { pid: 100, ppid: 1, startedMs: 1000, exe: `${root}/Contents/MacOS/Metis QA`, role: 'Metis QA' },
      {
        pid: 101,
        ppid: 100,
        startedMs: 1100,
        exe: `${root}/Contents/Frameworks/Metis QA Helper (Renderer).app/Contents/MacOS/Metis QA Helper (Renderer)`,
        role: 'Metis QA Helper (Renderer)'
      },
      { pid: 999, ppid: 1, startedMs: 500, exe: '/usr/bin/other', role: 'other' }
    ]
    const ps = (pids: number[]) =>
      `${pids.includes(100) ? ' 100 1000 0:01.00 Metis QA\n' : ''}${pids.includes(101) ? ' 101 2000 0:02.00 Helper --type=renderer\n' : ''}`
    const sample = sampleTree({ mainPid: 100, installRoot: root, platform: 'darwin', table, ps, nowMs: 5 })
    expect(sample.mainAlive).toBe(true)
    expect(sample.processes.map((process) => [process.pid, process.kind])).toEqual([
      [100, 'main'],
      [101, 'renderer']
    ])
    expect(totalRss(sample)).toBe(3000 * 1024)
    const gone = sampleTree({ mainPid: 4242, installRoot: root, platform: 'darwin', table: [table[2]], ps, nowMs: 5 })
    expect(gone).toMatchObject({ mainAlive: false, processes: [] })
  })

  it('tells the chord helper apart so its CPU can be judged on its own (V08 va-idle-cost)', () => {
    const root = '/s/Applications/Metis QA.app'
    const table = [
      { pid: 100, ppid: 1, startedMs: 1000, exe: `${root}/Contents/MacOS/Metis QA`, role: 'Metis QA' },
      {
        pid: 102,
        ppid: 100,
        startedMs: 1200,
        exe: `${root}/Contents/Resources/mac-helper/metis-mac-helper`,
        role: 'metis-mac-helper'
      },
      {
        pid: 103,
        ppid: 100,
        startedMs: 1300,
        exe: `${root}/Contents/Resources/mac-helper/metis-mac-helper`,
        role: 'metis-mac-helper'
      }
    ]
    const ps = (pids: number[]) =>
      [
        pids.includes(100) ? ' 100 1000 0:01.00 Metis QA' : '',
        pids.includes(102)
          ? ` 102 500 0:00.50 ${root}/Contents/Resources/mac-helper/metis-mac-helper watch-modifiers --interval-ms 40`
          : '',
        pids.includes(103)
          ? ` 103 500 0:00.50 ${root}/Contents/Resources/mac-helper/metis-mac-helper watch-frontmost`
          : ''
      ].join('\n')
    const sample = sampleTree({ mainPid: 100, installRoot: root, platform: 'darwin', table, ps, nowMs: 5 })
    expect(sample.processes.map((process) => [process.pid, process.kind])).toEqual([
      [100, 'main'],
      [102, 'chord-helper'],
      [103, 'other']
    ])
    expect(isChordHelperCommand('metis-keywatch.exe --interval-ms 40')).toBe(true)
    expect(isChordHelperCommand('metis-mac-helper supervise watch-modifiers')).toBe(false)
  })

  it('never sums a sample with a missing RSS reading', () => {
    expect(totalRss({ processes: [{ rssBytes: 1 }, { rssBytes: null }] })).toBeNull()
  })
})

describe('audit counts by phase', () => {
  it('buckets counted events by their own timestamps and ignores everything else', () => {
    const t0 = Date.parse('2026-10-21T10:00:00.000Z')
    const at = (minutes: number) => new Date(t0 + minutes * MINUTE_MS).toISOString()
    const event = COUNTED_EVENTS[0]
    const counts = auditCountsByPhase(
      [
        { ts: at(1), event },
        { ts: at(2), event },
        { ts: at(11), event },
        { ts: at(11), event: 'not.counted' },
        { ts: 'bad', event }
      ],
      t0,
      [
        { id: 'idle', startMs: 0, endMs: 10 * MINUTE_MS },
        { id: 'meeting', startMs: 10 * MINUTE_MS, endMs: 20 * MINUTE_MS }
      ]
    )
    expect(counts).toEqual({ idle: { [event]: 2 }, meeting: { [event]: 1 } })
  })
})

describe('soak configuration', () => {
  const env = { HOME: '/x/_relay/goal-loop/sandbox-home/run-1' }

  it('defaults to a 60-minute soak with 30-second samples', () => {
    const config = resolveSoakConfig([], env)
    expect(config.values.minutes).toBe(60)
    expect(config.values['interval-seconds']).toBe(30)
    expect(config.phases.map((phase) => phase.id)).toEqual(['idle', 'meeting', 'post'])
    // The config resolves paths for the host (a drive is added on Windows), so compare against the host spelling.
    const sandboxRoot = resolve('/x/_relay/goal-loop/sandbox-home')
    expect(config.appPath).toBe(join(sandboxRoot, 'Applications', 'Metis QA.app'))
    expect(config.layout.sandboxRoot).toBe(sandboxRoot)
    // The soak has always seeded the 'bar' layout; the product default ('hide') is opt-in and recorded in the report.
    expect(config.values.layout).toBe('bar')
    expect(resolveSoakConfig(['--layout', 'hide'], env).values.layout).toBe('hide')
  })

  it('refuses a plan without a meeting or idle phase, and bad arguments', () => {
    expect(() => resolveSoakConfig(['--minutes', '10', '--meeting-minutes', '0', '--idle-minutes', '10'], env)).toThrow(
      /no meeting phase/
    )
    expect(() => resolveSoakConfig(['--minutes', '10', '--idle-minutes', '0', '--meeting-minutes', '10'], env)).toThrow(
      /no idle phase/
    )
    expect(() => resolveSoakConfig(['--minutes', '2'], env)).toThrow(/at least 4/)
    expect(() => resolveSoakConfig(['--audio', 'mic'], env)).toThrow(/--audio must be/)
    expect(() => resolveSoakConfig(['--audio', 'file'], env)).toThrow(/needs --wav/)
    expect(() => resolveSoakConfig(['--layout', 'floating'], env)).toThrow(/--layout must be one of bar, hide, island/)
    expect(() => resolveSoakConfig([], { HOME: '/Users/real' })).toThrow(/cannot derive the sandbox root/)
  })
})
