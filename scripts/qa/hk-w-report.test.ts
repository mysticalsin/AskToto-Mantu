import { describe, expect, it } from 'vitest'
import { summarizeHkW } from './hk-w-report.mjs'

const proc = (pid: number, role: string) => ({ pid, startedMs: 1000 + pid, role })
const goodTimes = { checked: 8, mismatches: 0, registryChecked: 1, registryMismatches: 0 }

function cycle(n: number, survivors: ReturnType<typeof proc>[] = [], llama = true) {
  return {
    cycle: n,
    killed: true,
    llamaObserved: llama,
    descendants: [proc(n * 10 + 1, 'llama-server.exe'), proc(n * 10 + 2, 'Metis.exe (utility)')],
    survivors
  }
}

describe('summarizeHkW', () => {
  it('records the libuv job as covering descendants when nothing survives any cycle', () => {
    const summary = summarizeHkW({ requestedCycles: 3, cycles: [cycle(1), cycle(2), cycle(3)], startTime: goodTimes })
    expect(summary.result).toBe('pass')
    expect(summary.jobSemantics).toBe('descendants-killed')
    expect(summary.superviseNeeded).toBe(false)
    expect(summary.llama).toEqual({ observedCycles: 3 })
  })

  it('requires supervise.exe when a descendant survives even one cycle, and names the role', () => {
    const summary = summarizeHkW({
      requestedCycles: 2,
      cycles: [cycle(1), cycle(2, [proc(21, 'llama-server.exe')])],
      startTime: goodTimes
    })
    expect(summary.jobSemantics).toBe('descendants-survive')
    expect(summary.superviseNeeded).toBe(true)
    expect(summary.cyclesWithSurvivors).toBe(1)
    expect(summary.survivorRoles).toEqual({ 'llama-server.exe': 1 })
  })

  it('fails instead of claiming coverage when no descendant was ever observed', () => {
    const summary = summarizeHkW({
      requestedCycles: 1,
      cycles: [{ cycle: 1, killed: true, llamaObserved: false, descendants: [], survivors: [] }],
      startTime: goodTimes
    })
    expect(summary.result).toBe('fail')
    expect(summary.jobSemantics).toBe('unobserved')
    expect(summary.superviseNeeded).toBe(false)
  })

  it('fails on an incomplete cycle count and on a GetProcessTimes mismatch', () => {
    const summary = summarizeHkW({
      requestedCycles: 20,
      cycles: [cycle(1)],
      startTime: { ...goodTimes, mismatches: 1 }
    })
    expect(summary.result).toBe('fail')
    expect(summary.failures).toHaveLength(2)
  })

  it('reports a missing llama-server as BLOCKED_EXTERNAL without failing the lane', () => {
    const summary = summarizeHkW({ requestedCycles: 1, cycles: [cycle(1, [], false)], startTime: goodTimes })
    expect(summary.result).toBe('pass')
    expect(summary.llama).toMatchObject({ observedCycles: 0, status: 'BLOCKED_EXTERNAL' })
  })
})
