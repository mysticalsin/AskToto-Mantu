import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildDelta, summaryMarkdown } from './delta.mjs'

const PROFILE = { schemaVersion: 1, layout: 'standard' }
const PARKED_PROFILE = { schemaVersion: 1, layout: 'hide' }

let dir: string

function bytes(mib: number): number {
  return mib * 1024 * 1024
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function report(options: {
  platform?: 'darwin' | 'win32'
  state: string
  seconds?: number
  intervalMs?: number
  procs: Array<{ pid: number; startedMs?: number; kind: string; firstCpu?: number; lastCpu?: number; mib?: number }>
}) {
  const platform = options.platform ?? 'darwin'
  const metric =
    platform === 'win32'
      ? (mib: number) => ({ workingSetBytes: bytes(mib), privateBytes: bytes(mib) })
      : (mib: number) => ({ physFootprintBytes: bytes(mib) })
  const proc = (p: (typeof options.procs)[number], last: boolean) => ({
    pid: p.pid,
    startedMs: p.startedMs ?? p.pid * 1000,
    kind: p.kind,
    rssBytes: bytes(p.mib ?? 1),
    ...metric(p.mib ?? 1),
    cpuSeconds: last ? (p.lastCpu ?? p.firstCpu ?? 0) : (p.firstCpu ?? 0)
  })
  return {
    schemaVersion: 1,
    platform,
    state: options.state,
    seconds: options.seconds ?? 300,
    intervalMs: options.intervalMs ?? 5000,
    samples: [
      { tMs: 0, processes: options.procs.map((p) => proc(p, false)) },
      { tMs: (options.seconds ?? 300) * 1000, processes: options.procs.map((p) => proc(p, true)) }
    ]
  }
}

function writeRun(name: string, states: Record<string, ReturnType<typeof report>>, profile = PROFILE) {
  const root = join(dir, name)
  mkdirSync(root, { recursive: true })
  writeJson(join(root, 'profile-manifest.json'), profile)
  writeJson(join(root, 'parked-profile-manifest.json'), PARKED_PROFILE)
  for (const [state, body] of Object.entries(states)) writeJson(join(root, `${body.platform}-${state}.json`), body)
  return root
}

describe('resource census delta', () => {
  beforeEach(() => {
    dir = join(tmpdir(), `resource-census-delta-${process.pid}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(dir, { recursive: true })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('computes per-state CPU, memory and process-count deltas by kind', () => {
    const baseline = writeRun('baseline', {
      'cold-start': report({
        state: 'cold-start',
        procs: [
          { pid: 1, kind: 'main', firstCpu: 1, lastCpu: 4, mib: 100 },
          { pid: 2, kind: 'renderer', firstCpu: 2, lastCpu: 5, mib: 50 }
        ]
      })
    })
    const candidate = writeRun('candidate', {
      'cold-start': report({
        state: 'cold-start',
        procs: [
          { pid: 1, kind: 'main', firstCpu: 1, lastCpu: 7, mib: 125 },
          { pid: 2, kind: 'renderer', firstCpu: 2, lastCpu: 4, mib: 45 }
        ]
      })
    })

    const delta = buildDelta({ baselineDir: baseline, candidateDir: candidate })
    expect(delta.states).toHaveLength(1)
    expect(delta.states[0]).toMatchObject({
      state: 'cold-start',
      status: 'COMPARABLE',
      processCountByKind: {
        main: { baseline: 1, candidate: 1, delta: 0 },
        renderer: { baseline: 1, candidate: 1, delta: 0 }
      }
    })
    expect(delta.states[0].cpuSecondsPer300sByKind).toMatchObject({
      comparable: true,
      byKind: {
        main: { baseline: 3, candidate: 6, delta: 3 },
        renderer: { baseline: 3, candidate: 2, delta: -1 }
      }
    })
    expect(delta.states[0].cpuSecondsPer300s).toEqual({
      comparable: true,
      total: { baseline: 6, candidate: 8, delta: 2 }
    })
    expect(delta.states[0].memoryBytesByKind).toMatchObject({
      comparable: true,
      byMetric: {
        physFootprintBytes: {
          main: { baseline: bytes(100), candidate: bytes(125), delta: bytes(25) },
          renderer: { baseline: bytes(50), candidate: bytes(45), delta: -bytes(5) }
        }
      }
    })
    expect(delta.states[0].memoryBytesByMetric).toEqual({
      comparable: true,
      totals: {
        physFootprintBytes: { baseline: bytes(150), candidate: bytes(170), delta: bytes(20) }
      }
    })
    expect(delta.states[0].processCountTotal).toEqual({ baseline: 2, candidate: 2, delta: 0 })
    expect(JSON.stringify(delta)).not.toContain('pid')

    const summary = summaryMarkdown(delta)
    expect(summary).toContain('CPU seconds/300 s total')
    expect(summary).toContain('6 -> 8 (+2)')
    expect(summary).toContain('physFootprintBytes 157,286,400 B -> 178,257,920 B (+20,971,520 B)')
    expect(summary).toContain('2 -> 2 (+0)')
  })

  it('reports a missing state without inventing a comparison', () => {
    const baseline = writeRun('baseline', {
      'cold-start': report({ state: 'cold-start', procs: [{ pid: 1, kind: 'main' }] }),
      'settled-idle': report({ state: 'settled-idle', procs: [{ pid: 1, kind: 'main' }] })
    })
    const candidate = writeRun('candidate', {
      'cold-start': report({ state: 'cold-start', procs: [{ pid: 1, kind: 'main' }] })
    })

    const delta = buildDelta({ baselineDir: baseline, candidateDir: candidate })
    expect(delta.commonStates).toEqual(['cold-start'])
    expect(delta.candidate.states).toEqual(['cold-start'])
    expect(delta.states[0].status).toBe('NOT_COMPARABLE')
    expect(delta.states[0].reasons).toContain('state list differs')
  })

  it('marks a state NOT_COMPARABLE on a profile-manifest hash mismatch', () => {
    const baseline = writeRun('baseline', {
      'cold-start': report({ state: 'cold-start', procs: [{ pid: 1, kind: 'main' }] })
    })
    const candidate = writeRun(
      'candidate',
      {
        'cold-start': report({ state: 'cold-start', procs: [{ pid: 1, kind: 'main' }] })
      },
      { schemaVersion: 1, layout: 'changed' }
    )

    const state = buildDelta({ baselineDir: baseline, candidateDir: candidate }).states[0]
    expect(state.status).toBe('NOT_COMPARABLE')
    expect(state.reasons).toContain('profile-manifest sha256 differs')
    expect(state.cpuSecondsPer300sByKind).toMatchObject({ comparable: false })
    expect(state.memoryBytesByKind).toMatchObject({ comparable: false })
  })

  it('marks memory and CPU NOT_COMPARABLE when llama-server presence differs', () => {
    const baseline = writeRun('baseline', {
      'cold-start': report({ state: 'cold-start', procs: [{ pid: 1, kind: 'main' }] })
    })
    const candidateReport = report({
      state: 'cold-start',
      procs: [
        { pid: 1, kind: 'main' },
        { pid: 2, kind: 'llama-server' }
      ]
    })
    candidateReport.samples[1].processes = candidateReport.samples[1].processes.filter((process) => process.kind !== 'llama-server')
    const candidate = writeRun('candidate', {
      'cold-start': candidateReport
    })

    const state = buildDelta({ baselineDir: baseline, candidateDir: candidate }).states[0]
    expect(state.llamaServerPresent).toEqual({ baseline: false, candidate: true, differs: true })
    expect(state.status).toBe('NOT_COMPARABLE')
    expect(state.cpuSecondsPer300sByKind).toMatchObject({ comparable: false, reason: expect.stringContaining('llama-server presence differs') })
    expect(state.memoryBytesByKind).toMatchObject({ comparable: false, reason: expect.stringContaining('llama-server presence differs') })
  })

  it('lists a candidate-only sidecar-supervisor as a new kind', () => {
    const baseline = writeRun('baseline', {
      'cold-start': report({ state: 'cold-start', procs: [{ pid: 1, kind: 'main' }] })
    })
    const candidate = writeRun('candidate', {
      'cold-start': report({
        state: 'cold-start',
        procs: [
          { pid: 1, kind: 'main' },
          { pid: 2, kind: 'sidecar-supervisor' }
        ]
      })
    })

    const state = buildDelta({ baselineDir: baseline, candidateDir: candidate }).states[0]
    expect(state.status).toBe('COMPARABLE')
    expect(state.newKinds).toEqual(['sidecar-supervisor'])
    expect(state.processCountByKind['sidecar-supervisor']).toEqual({ baseline: 0, candidate: 1, delta: 1 })
  })

  it('emits content-free output and a summary row when no state is present in both runs', () => {
    const baseline = writeRun('baseline', {
      'cold-start': report({ state: 'cold-start', procs: [{ pid: 1, kind: 'main' }] })
    })
    const candidate = writeRun('candidate', {
      'parked-idle': report({ state: 'parked-idle', procs: [{ pid: 1, kind: 'main' }] })
    })

    const delta = buildDelta({ baselineDir: baseline, candidateDir: candidate })
    expect(delta.states).toEqual([])
    expect(JSON.stringify(delta)).not.toContain(dir)
    expect(JSON.stringify(delta)).not.toContain('pid')
    expect(summaryMarkdown(delta)).toContain('no states present in both runs')
  })
})
