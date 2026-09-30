import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decideOutcome, evaluateGrowth, theilSenSlope } from './growth.mjs'
import { rulesSha256 } from './growth-rule.mjs'

const MIB = 1024 * 1024
const MINUTE_MS = 60_000
const START = '2026-10-01T08:00:00.000Z'
const SCRIPT = join(__dirname, 'growth.mjs')

type Proc = { pid: number; kind: string; mib: number; cpuSeconds?: number; startedMs?: number }
type Check = { id: string; subject?: string; measured: number; bound: number; pass: boolean }
type Verdict = {
  outcome: string
  rule: { id: string; rulesSha256: string; file: string; fileSha256: string }
  inputs: { samples: { sha256: string }; auditCounts: { sha256: string } }
  memoryMetric: string | null
  validity: Check[]
  checks: Check[]
  failed: string[]
  projection?: { toMinute: number; series: Record<string, { projectedGrowthBytes: number; projectedBytesAtEnd: number }> }
  residual: string
}

/** One-core fraction x elapsed seconds: a constant CPU rate. */
const steady = (rate: number, tMin: number) => rate * tMin * 60

function base(tMin: number): Proc[] {
  return [
    { pid: 100, kind: 'main', mib: 400, cpuSeconds: steady(0.02, tMin) },
    { pid: 101, kind: 'renderer', mib: 250, cpuSeconds: steady(0.005, tMin) },
    { pid: 102, kind: 'gpu', mib: 120, cpuSeconds: steady(0.003, tMin) },
    { pid: 103, kind: 'utility', mib: 40, cpuSeconds: steady(0.001, tMin) }
  ]
}

function stream({
  minutes,
  procs = base,
  platform = 'darwin',
  keep = () => true
}: {
  minutes: number
  procs?: (tMin: number) => Proc[]
  platform?: 'darwin' | 'win32'
  keep?: (index: number) => boolean
}): string {
  const lines: object[] = [
    { record: 'header', schema: 'census-stream/1', state: 'settled-idle', platform, productVersion: '1.9.7', mainPid: 100, intervalMs: 30_000, startedAt: START, profileKind: 'representative-synthetic' }
  ]
  let outcome = 'completed'
  let count = 0
  for (let index = 0, tMs = 0; tMs < minutes * MINUTE_MS; index += 1, tMs += 30_000) {
    if (!keep(index)) continue
    const list = procs(tMs / MINUTE_MS)
    const mainAlive = list.some((proc) => proc.kind === 'main')
    const bytes = (proc: Proc) => Math.round(proc.mib * MIB)
    lines.push({
      record: 'sample',
      tMs,
      processes: list.map((proc) => ({
        pid: proc.pid,
        startedMs: proc.startedMs ?? 1_000 + proc.pid,
        kind: proc.kind,
        rssBytes: bytes(proc),
        physFootprintBytes: platform === 'darwin' ? bytes(proc) : null,
        workingSetBytes: platform === 'win32' ? bytes(proc) : null,
        privateBytes: platform === 'win32' ? bytes(proc) : null,
        cpuSeconds: proc.cpuSeconds ?? 0
      })),
      mainAlive,
      sampleDurationMs: 40
    })
    count += 1
    if (!mainAlive) {
      outcome = 'main-exited'
      break
    }
  }
  lines.push({ record: 'trailer', outcome, samples: count, endedAt: START })
  return lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
}

function auditCounts({
  minutes,
  jobs = () => 2,
  extra = () => ({})
}: {
  minutes: number
  jobs?: (index: number) => number
  extra?: (index: number) => Record<string, number>
}): string {
  const buckets = Array.from({ length: Math.ceil(minutes / 10) }, (_, index) => ({
    index,
    startsAt: new Date(Date.parse(START) + index * 10 * MINUTE_MS).toISOString(),
    counts: { 'scheduler.job:window-open': jobs(index), 'app.stall': 1, ...extra(index) },
    other: 3
  }))
  return JSON.stringify({ schema: 'audit-counts/1', from: START, bucketMinutes: 10, unparseableLines: 0, buckets })
}

const IDLE_MINUTES = 330

function idle(options: { minutes?: number; procs?: (tMin: number) => Proc[]; platform?: 'darwin' | 'win32'; keep?: (index: number) => boolean; jobs?: (index: number) => number; extra?: (index: number) => Record<string, number> } = {}): Verdict {
  const minutes = options.minutes ?? IDLE_MINUTES
  return evaluateGrowth({
    ruleId: 'IDLE-GROWTH-1',
    samples: stream({ minutes, procs: options.procs, platform: options.platform, keep: options.keep }),
    auditCounts: auditCounts({ minutes, jobs: options.jobs, extra: options.extra })
  }) as unknown as Verdict
}

const find = (verdict: Verdict, id: string, subject?: string): Check => {
  const check = verdict.checks.find((entry) => entry.id === id && (subject === undefined || entry.subject === subject))
  if (!check) throw new Error(`no check ${id}:${subject ?? ''}`)
  return check
}
const failedIds = (verdict: Verdict) => new Set(verdict.checks.filter((check) => !check.pass).map((check) => check.id))

describe('IDLE-GROWTH-1', () => {
  it('passes a flat idle leg and reports the 8 h projection, rule hashes and residual', () => {
    const verdict = idle()
    expect(verdict.failed).toEqual([])
    expect(verdict.outcome).toBe('PASS')
    expect(verdict.memoryMetric).toBe('physFootprintBytes')
    expect(verdict.projection?.toMinute).toBe(480)
    expect(verdict.projection?.series.total.projectedGrowthBytes).toBe(0)
    expect(verdict.projection?.series.total.projectedBytesAtEnd).toBe(810 * MIB)
    expect(verdict.rule).toEqual({
      id: 'IDLE-GROWTH-1',
      rulesSha256: rulesSha256(),
      file: 'growth-rule.mjs',
      fileSha256: createHash('sha256').update(readFileSync(join(__dirname, 'growth-rule.mjs'))).digest('hex')
    })
    expect(verdict.residual).toBe('linear extrapolation cannot see a leak that starts after the leg ends')
    for (const id of ['P1', 'P2', 'P2-SPAWN', 'M1', 'M2', 'C1', 'J1-RISE', 'J1-BUCKET']) {
      expect(verdict.checks.some((check) => check.id === id)).toBe(true)
    }
    for (const kind of ['main', 'renderer', 'sidecar-supervisor', 'llama-server']) {
      expect(find(verdict, 'P1', kind).pass).toBe(true)
      expect(find(verdict, 'M1', kind).pass).toBe(true)
    }
  })

  it('judges a Windows leg on private bytes', () => {
    const verdict = idle({ platform: 'win32' })
    expect(verdict.memoryMetric).toBe('privateBytes')
    expect(verdict.outcome).toBe('PASS')
  })

  it('passes a flat idle leg with llama-server and its supervisor wrapper present from settle', () => {
    const verdict = idle({
      procs: (t) => [
        ...base(t),
        { pid: 200, kind: 'llama-server', mib: 600, cpuSeconds: steady(0.004, t) },
        { pid: 201, kind: 'sidecar-supervisor', mib: 5 }
      ]
    })
    expect(verdict.failed).toEqual([])
    expect(verdict.outcome).toBe('PASS')
    expect(find(verdict, 'P1', 'sidecar-supervisor')).toMatchObject({ measured: 1, bound: 1, pass: true })
  })

  it('fails a linear leak that is within bounds at 5.5 h but over them projected to 8 h', () => {
    // main grows 0.17 MiB/min from settle: +51 MiB across the leg (bound 60 MiB), +78 MiB projected to 8 h.
    const verdict = idle({
      procs: (t) => base(t).map((proc) => (proc.kind === 'main' ? { ...proc, mib: 400 + 0.17 * Math.max(0, t - 20) } : proc))
    })
    expect(verdict.outcome).toBe('FAIL')
    expect(verdict.failed).toEqual(['M1:main'])
    expect(find(verdict, 'M2', 'main').pass).toBe(true)
    expect(find(verdict, 'M2', 'main').measured).toBeLessThan(60 * MIB)
    expect(find(verdict, 'M1', 'main').measured).toBeGreaterThan(60 * MIB)
    expect(find(verdict, 'M1', 'main').bound).toBeCloseTo(60 * MIB, 0)
    expect(find(verdict, 'M1', 'total').pass).toBe(true)
    expect(verdict.projection?.series.main.projectedGrowthBytes).toBeCloseTo(0.17 * 460 * MIB, -4)
  })

  it('fails step growth on M2 while the Theil-Sen slope stays flat', () => {
    const verdict = idle({
      procs: (t) => base(t).map((proc) => (proc.kind === 'main' && t >= 300 ? { ...proc, mib: 500 } : proc))
    })
    expect(verdict.outcome).toBe('FAIL')
    expect(find(verdict, 'M2', 'main')).toMatchObject({ measured: 100 * MIB, pass: false })
    expect(find(verdict, 'M2', 'total').pass).toBe(false)
    expect(failedIds(verdict)).toEqual(new Set(['M2']))
  })

  it('fails a respawn loop on P2 identities and sidecar.spawn events', () => {
    const verdict = idle({
      procs: (t) => {
        const generation = Math.floor(Math.max(0, t - 20) / 20)
        return [...base(t), { pid: 300 + generation, startedMs: 9_000 + generation, kind: 'llama-server', mib: 600 }]
      },
      extra: (index): Record<string, number> => (index >= 2 && index % 2 === 0 ? { 'sidecar.spawn': 1, 'sidecar.exit': 1 } : {})
    })
    expect(verdict.outcome).toBe('FAIL')
    expect(find(verdict, 'P1', 'llama-server').pass).toBe(true)
    expect(find(verdict, 'P2', 'llama-server')).toMatchObject({ measured: 16, bound: 3, pass: false })
    expect(find(verdict, 'P2-SPAWN')).toMatchObject({ measured: 16, bound: 2, pass: false })
  })

  it('fails rising CPU on C1', () => {
    // main's one-core rate climbs from 2% to 5% across the leg.
    const cpu = (t: number) => 0.02 * t * 60 + (0.03 * (t * 60) ** 2) / (2 * IDLE_MINUTES * 60)
    const verdict = idle({ procs: (t) => base(t).map((proc) => (proc.kind === 'main' ? { ...proc, cpuSeconds: cpu(t) } : proc)) })
    expect(verdict.outcome).toBe('FAIL')
    expect(failedIds(verdict)).toEqual(new Set(['C1']))
    expect(find(verdict, 'C1').measured).toBeGreaterThan(find(verdict, 'C1').bound)
  })

  it('fails a job storm on J1', () => {
    const verdict = idle({ jobs: (index) => (index === 15 ? 25 : 2) })
    expect(verdict.outcome).toBe('FAIL')
    expect(find(verdict, 'J1-BUCKET')).toMatchObject({ measured: 25, bound: 20, pass: false })
    expect(find(verdict, 'J1-RISE').pass).toBe(true)
  })

  it('fails J1 when the last hour carries more than 3 job events over the first hour after settle', () => {
    const verdict = idle({ jobs: (index) => (index >= 27 ? 3 : 2) })
    expect(find(verdict, 'J1-RISE')).toMatchObject({ measured: 18, bound: 15, pass: false })
    expect(verdict.outcome).toBe('FAIL')
  })

  it('reports a 4 h leg as INCOMPLETE, not PASS', () => {
    const verdict = idle({ minutes: 240 })
    expect(verdict.outcome).toBe('INCOMPLETE')
    expect(verdict.failed).toEqual(['V-DURATION'])
    expect(verdict.checks).toEqual([])
  })

  it('reports a gappy leg (under 95% of planned samples) as INCOMPLETE', () => {
    const verdict = idle({ keep: (index) => index % 10 !== 5 })
    expect(verdict.outcome).toBe('INCOMPLETE')
    expect(verdict.failed).toEqual(['V-SAMPLES'])
  })

  it('reports a main exit as FAIL, not INCOMPLETE', () => {
    const verdict = idle({ procs: (t) => (t >= 200 ? base(t).filter((proc) => proc.kind !== 'main') : base(t)) })
    expect(verdict.outcome).toBe('FAIL')
    expect(verdict.failed).toContain('V-MAIN')
  })

  it('reports INCOMPLETE when the audit counts do not line up with the stream', () => {
    const verdict = evaluateGrowth({
      ruleId: 'IDLE-GROWTH-1',
      samples: stream({ minutes: IDLE_MINUTES }),
      auditCounts: JSON.stringify({ ...JSON.parse(auditCounts({ minutes: IDLE_MINUTES })), from: '2026-10-01T09:00:00.000Z' })
    }) as unknown as Verdict
    expect(verdict.outcome).toBe('INCOMPLETE')
    expect(verdict.failed).toEqual(['V-AUDIT'])
  })
})

const CAPTURE_START = 10
const STOP = 70
const MEETING_MINUTES = 90

/** Idle before capture; ASR and speaker utilities during capture; renderer holds the transcript from minute 5. */
function meetingBase(t: number, rendererMibPerMinute = 1): Proc[] {
  const transcript = rendererMibPerMinute * Math.max(0, Math.min(t, STOP) - (CAPTURE_START + 5))
  const procs = base(t).map((proc) => (proc.kind === 'renderer' ? { ...proc, mib: 250 + transcript } : proc))
  if (t >= CAPTURE_START && t < STOP) {
    procs.push({ pid: 400, kind: 'parakeet-utility', mib: 150 }, { pid: 401, kind: 'speaker-utility', mib: 80 })
  }
  return procs
}

function meeting(procs: (t: number) => Proc[], extra: (index: number) => Record<string, number> = () => ({})): Verdict {
  return evaluateGrowth({
    ruleId: 'MEETING-GROWTH-1',
    samples: stream({ minutes: MEETING_MINUTES, procs }),
    auditCounts: auditCounts({ minutes: MEETING_MINUTES, jobs: () => 1, extra }),
    captureStartMs: CAPTURE_START * MINUTE_MS,
    stopMs: STOP * MINUTE_MS
  }) as unknown as Verdict
}

describe('MEETING-GROWTH-1', () => {
  it('passes a meeting whose renderer transcript growth stays within the renderer bound', () => {
    const verdict = meeting((t) => meetingBase(t))
    expect(verdict.failed).toEqual([])
    expect(verdict.outcome).toBe('PASS')
    expect(find(verdict, 'M1', 'renderer').measured).toBeCloseTo(55 * MIB, -3)
    expect(find(verdict, 'M1', 'renderer').bound).toBe(96 * MIB)
    expect(find(verdict, 'P0', 'main').pass).toBe(true)
    for (const id of ['P1', 'P2', 'P2-SPAWN', 'POST', 'M1', 'POST-M', 'J1-BUCKET']) {
      expect(verdict.checks.some((check) => check.id === id)).toBe(true)
    }
  })

  it('fails renderer growth over max(96 MiB, 25%)', () => {
    const verdict = meeting((t) => meetingBase(t, 2))
    expect(verdict.outcome).toBe('FAIL')
    expect(verdict.failed).toEqual(['M1:renderer'])
  })

  it('passes a supervised summary start after Stop: llama-server plus its wrapper', () => {
    const verdict = meeting(
      (t) => [
        ...meetingBase(t),
        ...(t >= STOP + 1
          ? [
              { pid: 500, kind: 'llama-server', mib: 150 },
              { pid: 501, kind: 'sidecar-supervisor', mib: 5 }
            ]
          : [])
      ],
      (index): Record<string, number> => (index === 7 ? { 'sidecar.spawn': 1 } : {})
    )
    expect(verdict.failed).toEqual([])
    expect(verdict.outcome).toBe('PASS')
    expect(find(verdict, 'POST', 'llama-server')).toMatchObject({ measured: 1, bound: 1, pass: true })
    expect(find(verdict, 'POST', 'sidecar-supervisor')).toMatchObject({ measured: 1, bound: 1, pass: true })
  })

  it('fails an ASR utility leaked after Stop', () => {
    // The capture's ASR utility is never reaped, and a second one spawned after Stop stays alive beside it.
    const verdict = meeting((t) => [
      ...meetingBase(t),
      ...(t >= STOP ? [{ pid: 400, kind: 'parakeet-utility', mib: 150 }] : []),
      ...(t >= STOP + 1 ? [{ pid: 402, kind: 'parakeet-utility', mib: 150 }] : [])
    ])
    expect(verdict.outcome).toBe('FAIL')
    expect(verdict.failed).toEqual(['POST:parakeet-utility'])
  })

  it('fails a kind outside the capture-start allowance that appears before minute 5', () => {
    const verdict = meeting((t) => [...meetingBase(t), ...(t >= CAPTURE_START ? [{ pid: 600, kind: 'renderer', mib: 60 }] : [])])
    expect(verdict.outcome).toBe('FAIL')
    expect(verdict.failed).toContain('P0:renderer')
  })

  it('reports INCOMPLETE with less than 55 min of capture or no sample after Stop', () => {
    const short = evaluateGrowth({
      ruleId: 'MEETING-GROWTH-1',
      samples: stream({ minutes: 60, procs: (t) => meetingBase(t) }),
      auditCounts: auditCounts({ minutes: 60 }),
      captureStartMs: CAPTURE_START * MINUTE_MS,
      stopMs: STOP * MINUTE_MS
    }) as unknown as Verdict
    expect(short.outcome).toBe('INCOMPLETE')
    // The capture window's last bucket (minutes 55-60) holds no sample either.
    expect(short.failed).toEqual(['V-DURATION', 'V-POST', 'V-BUCKETS'])
  })
})

describe('outcome and statistics', () => {
  const ok = { id: 'V-SAMPLES', measured: 1, bound: 0.95, pass: true }
  it('never reports PASS with a failed, unevaluated or missing check', () => {
    const pass = { id: 'P1', pass: true }
    expect(decideOutcome({ validity: [ok], checks: [pass], required: ['P1'] })).toBe('PASS')
    expect(decideOutcome({ validity: [ok], checks: [pass, { id: 'M1', pass: false }], required: ['P1'] })).toBe('FAIL')
    expect(decideOutcome({ validity: [ok], checks: [pass], required: ['P1', 'M1'] })).toBe('INCOMPLETE')
    expect(decideOutcome({ validity: [ok], checks: [pass, { id: 'M1' }], required: ['P1', 'M1'] })).toBe('INCOMPLETE')
    expect(decideOutcome({ validity: [ok], checks: [], required: [] })).toBe('INCOMPLETE')
    expect(decideOutcome({ validity: [], checks: [pass], required: ['P1'] })).toBe('INCOMPLETE')
    expect(decideOutcome({ validity: [{ ...ok, pass: false }], checks: [pass], required: ['P1'] })).toBe('INCOMPLETE')
    expect(decideOutcome({ validity: [{ id: 'V-MAIN', pass: false }], checks: [], required: ['P1'] })).toBe('FAIL')
  })

  it('takes the Theil-Sen slope, robust to a single outlier', () => {
    const points = [0, 1, 2, 3, 4, 5, 6].map((x) => ({ x, y: 2 * x + (x === 3 ? 100 : 0) }))
    expect(theilSenSlope(points)).toBe(2)
  })
})

describe('growth.mjs CLI', () => {
  let dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs = []
  })

  function run(samples: string, counts: string, rule = 'IDLE-GROWTH-1') {
    const dir = mkdtempSync(join(tmpdir(), 'growth-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'samples.ndjson'), samples)
    writeFileSync(join(dir, 'audit-counts.json'), counts)
    const out = join(dir, 'verdict', 'growth.json')
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--samples', join(dir, 'samples.ndjson'), '--audit-counts', join(dir, 'audit-counts.json'), '--rule', rule, '--out', out],
      { encoding: 'utf8', timeout: 60_000 }
    )
    const text = result.status === 2 && !result.stdout ? null : readFileSync(out, 'utf8')
    return { status: result.status, stderr: result.stderr, dir, text, verdict: text ? (JSON.parse(text) as Verdict) : null }
  }

  it('exits 0 on PASS and writes a content-free verdict with the input hashes', () => {
    const samples = stream({ minutes: IDLE_MINUTES })
    const counts = auditCounts({ minutes: IDLE_MINUTES })
    const { status, stderr, dir, text, verdict } = run(samples, counts)
    expect(status, stderr).toBe(0)
    expect(verdict?.outcome).toBe('PASS')
    expect(verdict?.inputs).toEqual({
      samples: { sha256: createHash('sha256').update(samples).digest('hex') },
      auditCounts: { sha256: createHash('sha256').update(counts).digest('hex') }
    })
    expect(text).not.toContain(dir)
    expect(text).not.toContain('samples.ndjson')
    expect(text).not.toContain(START)
  })

  it('exits 1 on FAIL and 2 on INCOMPLETE', () => {
    const exit = stream({ minutes: IDLE_MINUTES, procs: (t) => (t >= 200 ? base(t).slice(1) : base(t)) })
    expect(run(exit, auditCounts({ minutes: IDLE_MINUTES })).status).toBe(1)
    const short = run(stream({ minutes: 240 }), auditCounts({ minutes: 240 }))
    expect(short.status).toBe(2)
    expect(short.verdict?.outcome).toBe('INCOMPLETE')
  })

  it('exits 2 with no verdict on an unknown rule', () => {
    const result = run(stream({ minutes: 30 }), auditCounts({ minutes: 30 }), 'IDLE-GROWTH-9')
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('unknown rule')
    expect(result.verdict).toBeNull()
  })
})
