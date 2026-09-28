import { describe, it, expect, vi } from 'vitest'
import { performance } from 'node:perf_hooks'
import { startStallMonitor } from './stall-monitor'

/**
 * M2-0006 — the app.stall heartbeat. The freeze root cause (spindump-verified) is a main-thread
 * synchronous fs read blocking the event loop; the only trace it leaves is the next tick of an otherwise-
 * regular timer firing very late. These tests drive startStallMonitor with a fully injected
 * clock/timer/histogram, so a "stall" is a deterministic, explicit jump in the injected clock — never a
 * real sleep — and every tick and every summary flush is asserted against a real return value from the
 * module under test, not against the shape of its source.
 */
function fakeTimer(): {
  now: () => number
  advanceTo: (t: number) => void
  /** Moves the clock forward WITHOUT firing the interval — models time passing (e.g. system sleep) with
   *  no timer tick, as opposed to advanceTo's "the timer fired at this time". */
  jumpTo: (t: number) => void
  setIntervalFn: (handler: () => void, ms: number) => NodeJS.Timeout
  clearIntervalFn: (handle: NodeJS.Timeout) => void
  cleared: unknown[]
} {
  let current = 0
  let tick: (() => void) | undefined
  const cleared: unknown[] = []
  return {
    now: () => current,
    advanceTo: (t: number) => {
      current = t
      tick?.()
    },
    jumpTo: (t: number) => {
      current = t
    },
    setIntervalFn: (handler) => {
      tick = handler
      return 1 as unknown as NodeJS.Timeout
    },
    clearIntervalFn: (handle) => {
      cleared.push(handle)
      tick = undefined
    },
    cleared
  }
}

/** Not typed against EventLoopHistogram: inference keeps enable/disable/reset/percentile as concrete Mock
 *  values so tests can assert on them directly (toHaveBeenCalledOnce etc), while still being structurally
 *  compatible with the real interface where startStallMonitor expects it. */
function fakeHistogram(percentileNs: number) {
  return {
    enable: vi.fn(() => true),
    disable: vi.fn(() => true),
    reset: vi.fn(),
    percentile: vi.fn(() => percentileNs)
  }
}

describe('startStallMonitor', () => {
  it('does not report a stall when every tick fires on schedule', () => {
    const clock = fakeTimer()
    const onStall = vi.fn()
    const onSummary = vi.fn()
    startStallMonitor({
      bootId: 'boot-1',
      onStall,
      onSummary,
      tickMs: 1000,
      summaryIntervalMs: 10_000,
      now: clock.now,
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn,
      histogram: fakeHistogram(0)
    })
    clock.advanceTo(1000)
    clock.advanceTo(2000)
    clock.advanceTo(3000)
    expect(onStall).not.toHaveBeenCalled()
  })

  it('reports app.stall with the exact lateness when a tick fires at least one full tick period late', () => {
    const clock = fakeTimer()
    const onStall = vi.fn()
    startStallMonitor({
      bootId: 'boot-1',
      onStall,
      onSummary: vi.fn(),
      tickMs: 1000,
      summaryIntervalMs: 10_000,
      now: clock.now,
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn,
      histogram: fakeHistogram(0)
    })
    clock.advanceTo(1000) // on time — expectedAt becomes 2000
    clock.advanceTo(3500) // 1500ms late
    expect(onStall).toHaveBeenCalledExactlyOnceWith({ bootId: 'boot-1', durationMs: 1500, phase: undefined, phaseMs: undefined })
  })

  it('a tick that is late by LESS than a full tick period is not a stall', () => {
    const clock = fakeTimer()
    const onStall = vi.fn()
    startStallMonitor({
      bootId: 'boot-1',
      onStall,
      onSummary: vi.fn(),
      tickMs: 1000,
      summaryIntervalMs: 10_000,
      now: clock.now,
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn,
      histogram: fakeHistogram(0)
    })
    clock.advanceTo(1000) // expectedAt -> 2000
    clock.advanceTo(2900) // 900ms late — under the 1000ms threshold
    expect(onStall).not.toHaveBeenCalled()
  })

  it('flushes a p99 summary once the summary interval elapses, converting the histogram from ns to ms', () => {
    const clock = fakeTimer()
    const onSummary = vi.fn()
    const histogram = fakeHistogram(12_000_000) // 12ms in nanoseconds
    startStallMonitor({
      bootId: 'boot-1',
      onStall: vi.fn(),
      onSummary,
      tickMs: 1000,
      summaryIntervalMs: 5000,
      now: clock.now,
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn,
      histogram
    })
    clock.advanceTo(1000)
    clock.advanceTo(2000)
    clock.advanceTo(3000)
    expect(onSummary).not.toHaveBeenCalled()
    clock.advanceTo(5200)
    expect(onSummary).toHaveBeenCalledExactlyOnceWith({ bootId: 'boot-1', p99Ms: 12 })
    expect(histogram.reset).toHaveBeenCalledOnce()
  })

  it('enables the histogram on start and disables it on stop', () => {
    const clock = fakeTimer()
    const histogram = fakeHistogram(0)
    const monitor = startStallMonitor({
      bootId: 'boot-1',
      onStall: vi.fn(),
      onSummary: vi.fn(),
      now: clock.now,
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn,
      histogram
    })
    expect(histogram.enable).toHaveBeenCalledOnce()
    expect(histogram.disable).not.toHaveBeenCalled()
    monitor.stop()
    expect(histogram.disable).toHaveBeenCalledOnce()
    expect(clock.cleared).toHaveLength(1)
  })

  it('stop() is idempotent — a second call clears nothing more', () => {
    const clock = fakeTimer()
    const histogram = fakeHistogram(0)
    const monitor = startStallMonitor({
      bootId: 'boot-1',
      onStall: vi.fn(),
      onSummary: vi.fn(),
      now: clock.now,
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn,
      histogram
    })
    monitor.stop()
    monitor.stop()
    expect(clock.cleared).toHaveLength(1)
    expect(histogram.disable).toHaveBeenCalledOnce()
  })

  it('defaults tickMs to 1000ms and summaryIntervalMs to 5 minutes when neither is given', () => {
    let scheduledMs: number | undefined
    let handler: (() => void) | undefined
    let current = 0
    const setIntervalFn = (h: () => void, ms: number): NodeJS.Timeout => {
      scheduledMs = ms
      handler = h
      return 1 as unknown as NodeJS.Timeout
    }
    const onSummary = vi.fn()
    startStallMonitor({
      bootId: 'boot-1',
      onStall: vi.fn(),
      onSummary,
      now: () => current,
      setIntervalFn,
      clearIntervalFn: vi.fn(),
      histogram: fakeHistogram(0)
    })
    expect(scheduledMs).toBe(1000)
    current = 299_000
    handler!()
    expect(onSummary).not.toHaveBeenCalled()
    current = 300_000
    handler!()
    expect(onSummary).toHaveBeenCalledOnce()
  })

  it('defaults now to performance.now and never calls Date.now', () => {
    const nowSpy = vi.spyOn(performance, 'now')
    const dateNowSpy = vi.spyOn(Date, 'now')
    let scheduledHandler: (() => void) | undefined
    try {
      startStallMonitor({
        bootId: 'boot-1',
        onStall: vi.fn(),
        onSummary: vi.fn(),
        setIntervalFn: (handler) => {
          scheduledHandler = handler
          return 1 as unknown as NodeJS.Timeout
        },
        clearIntervalFn: vi.fn(),
        histogram: fakeHistogram(0)
      })
      const callsAtStart = nowSpy.mock.calls.length
      expect(callsAtStart).toBeGreaterThan(0) // the initial expectedAt/nextSummaryAt computation
      scheduledHandler!()
      expect(nowSpy.mock.calls.length).toBeGreaterThan(callsAtStart) // the tick itself reads the clock again
      expect(dateNowSpy).not.toHaveBeenCalled()
    } finally {
      nowSpy.mockRestore()
      dateNowSpy.mockRestore()
    }
  })

  it('pause() removes the heartbeat entirely, so no tick can fire during sleep regardless of event order; restartIfPaused() restarts it from a fresh baseline', () => {
    // This is the fake-stall race: an overdue heartbeat tick and powerMonitor's 'resume' are delivered by
    // independent sources, so which one the event loop processes first is not guaranteed. pause() (called
    // from 'suspend') removes the interval outright, so there is no tick left to race resume with — order
    // cannot matter because there is nothing pending to order.
    const clock = fakeTimer()
    const onStall = vi.fn()
    const monitor = startStallMonitor({
      bootId: 'boot-1',
      onStall,
      onSummary: vi.fn(),
      tickMs: 1000,
      summaryIntervalMs: 10_000,
      now: clock.now,
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn,
      histogram: fakeHistogram(0)
    })
    monitor.pause() // powerMonitor 'suspend'
    clock.jumpTo(3_601_000) // an hour asleep
    clock.advanceTo(3_601_500) // would have fired the interval had pause() not cleared it
    expect(onStall).not.toHaveBeenCalled()
    monitor.restartIfPaused() // powerMonitor 'resume' — restarts the heartbeat from a fresh baseline
    clock.advanceTo(3_602_500) // exactly one tick after restarting — on schedule relative to the new baseline
    expect(onStall).not.toHaveBeenCalled()
  })

  it('restartIfPaused() is a no-op on an already-running heartbeat, so it cannot discard lateness that is genuinely accruing — this is what makes resume and unlock-screen order-independent', () => {
    const clock = fakeTimer()
    const onStall = vi.fn()
    const monitor = startStallMonitor({
      bootId: 'boot-1',
      onStall,
      onSummary: vi.fn(),
      tickMs: 1000,
      summaryIntervalMs: 10_000,
      now: clock.now,
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn,
      histogram: fakeHistogram(0)
    })
    clock.advanceTo(1000) // expectedAt -> 2000
    clock.jumpTo(1900) // no tick has fired yet; a naive unconditional restart here would re-baseline to 2900
    monitor.restartIfPaused() // e.g. a redundant 'unlock-screen' after 'resume' already handled it — must not re-baseline
    clock.advanceTo(3600) // the pending tick finally fires — 1600ms late relative to the ORIGINAL expectedAt
    expect(onStall).toHaveBeenCalledExactlyOnceWith({ bootId: 'boot-1', durationMs: 1600, phase: undefined, phaseMs: undefined })
  })

  it('a tick that fires on time consumes any pending phase, so a later late tick names nothing', () => {
    const clock = fakeTimer()
    const onStall = vi.fn()
    const monitor = startStallMonitor({
      bootId: 'boot-1',
      onStall,
      onSummary: vi.fn(),
      tickMs: 1000,
      summaryIntervalMs: 10_000,
      now: clock.now,
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn,
      histogram: fakeHistogram(0)
    })
    monitor.timePhase('ensureMeetingsFolder', () => {})
    clock.advanceTo(1000) // on time — consumes the phase even though this tick itself isn't late
    clock.advanceTo(3500) // 1500ms late, but the phase was already consumed by the on-time tick above
    expect(onStall).toHaveBeenCalledExactlyOnceWith({ bootId: 'boot-1', durationMs: 1500, phase: undefined, phaseMs: undefined })
  })

  it('timePhase immediately before a late tick attaches that phase and its own measured duration', () => {
    const clock = fakeTimer()
    const onStall = vi.fn()
    const monitor = startStallMonitor({
      bootId: 'boot-1',
      onStall,
      onSummary: vi.fn(),
      tickMs: 1000,
      summaryIntervalMs: 10_000,
      now: clock.now,
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn,
      histogram: fakeHistogram(0)
    })
    // Models a single slow runStep: the step itself takes 3400ms (the clock moves inside the callback,
    // the way a real synchronous fs call would take real elapsed time), and the very next tick is late.
    monitor.timePhase('ensureMeetingsFolder', () => clock.jumpTo(3400))
    clock.advanceTo(3500) // late by 2500ms — no on-time tick consumed the phase first
    expect(onStall).toHaveBeenCalledExactlyOnceWith({
      bootId: 'boot-1',
      durationMs: 2500,
      phase: 'ensureMeetingsFolder',
      phaseMs: 3400
    })
  })

  it('names the phase that ran longest since the previous tick, not whichever one ran last — production runs many runStep calls synchronously with no tick able to fire between them', () => {
    const clock = fakeTimer()
    const onStall = vi.fn()
    const monitor = startStallMonitor({
      bootId: 'boot-1',
      onStall,
      onSummary: vi.fn(),
      tickMs: 1000,
      summaryIntervalMs: 10_000,
      now: clock.now,
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn,
      histogram: fakeHistogram(0)
    })
    // Same shape as index.ts's boot sequence: refreshScreenPreprocess through initAutoUpdate run back to
    // back with no await, so the heartbeat cannot tick until after the last one returns. Only the first
    // step is actually slow; the last one entered is fast.
    monitor.timePhase('ensureMeetingsFolder', () => clock.jumpTo(5000)) // slow: ~5000ms
    monitor.timePhase('initializeImportJobs', () => clock.jumpTo(5010)) // fast: ~10ms, entered and finished last
    clock.advanceTo(6500) // the first tick able to fire after both steps — 5500ms late
    expect(onStall).toHaveBeenCalledExactlyOnceWith({
      bootId: 'boot-1',
      durationMs: 5500,
      phase: 'ensureMeetingsFolder',
      phaseMs: 5000
    })
  })

  it('restartIfPaused() after stop() does not restart the heartbeat', () => {
    const clock = fakeTimer()
    const setIntervalSpy = vi.fn(clock.setIntervalFn)
    const monitor = startStallMonitor({
      bootId: 'boot-1',
      onStall: vi.fn(),
      onSummary: vi.fn(),
      tickMs: 1000,
      summaryIntervalMs: 10_000,
      now: clock.now,
      setIntervalFn: setIntervalSpy,
      clearIntervalFn: clock.clearIntervalFn,
      histogram: fakeHistogram(0)
    })
    expect(setIntervalSpy).toHaveBeenCalledOnce() // the initial heartbeat
    monitor.stop()
    monitor.restartIfPaused()
    expect(setIntervalSpy).toHaveBeenCalledOnce() // restartIfPaused() did not schedule a second interval
  })

  it('pause() after stop() is a no-op', () => {
    const clock = fakeTimer()
    const histogram = fakeHistogram(0)
    const monitor = startStallMonitor({
      bootId: 'boot-1',
      onStall: vi.fn(),
      onSummary: vi.fn(),
      now: clock.now,
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn,
      histogram
    })
    monitor.stop()
    monitor.pause()
    expect(clock.cleared).toHaveLength(1) // pause() found no interval left to clear
    expect(histogram.disable).toHaveBeenCalledOnce() // stop()'s own call, not a second one from pause()
  })

  it('pause() after pause() is a no-op', () => {
    const clock = fakeTimer()
    const monitor = startStallMonitor({
      bootId: 'boot-1',
      onStall: vi.fn(),
      onSummary: vi.fn(),
      now: clock.now,
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn,
      histogram: fakeHistogram(0)
    })
    monitor.pause()
    monitor.pause()
    expect(clock.cleared).toHaveLength(1) // the second pause() found no interval left to clear
  })
})
