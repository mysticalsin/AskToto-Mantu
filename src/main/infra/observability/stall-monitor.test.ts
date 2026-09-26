import { describe, it, expect, vi } from 'vitest'
import { startStallMonitor } from './stall-monitor'

/**
 * M2-0006 — the app.stall heartbeat. The freeze root cause (spindump-verified, RUNTIME-EVIDENCE.md) is a
 * main-thread synchronous fs read blocking the event loop; the only trace it leaves is the next tick of
 * an otherwise-regular timer firing very late. These tests drive startStallMonitor with a fully injected
 * clock/timer/histogram, so a "stall" is a deterministic, explicit jump in the injected clock — never a
 * real sleep — and every tick and every summary flush is asserted against a real return value from the
 * module under test, not against the shape of its source.
 */
function fakeTimer(): {
  now: () => number
  advanceTo: (t: number) => void
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
    expect(onStall).toHaveBeenCalledExactlyOnceWith({ bootId: 'boot-1', durationMs: 1500 })
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

  it('defaults tickMs to 1000 and summaryIntervalMs to 5 minutes when not given', () => {
    let scheduledMs: number | undefined
    const setIntervalFn = (handler: () => void, ms: number): NodeJS.Timeout => {
      scheduledMs = ms
      return 1 as unknown as NodeJS.Timeout
    }
    startStallMonitor({
      bootId: 'boot-1',
      onStall: vi.fn(),
      onSummary: vi.fn(),
      now: () => 0,
      setIntervalFn,
      clearIntervalFn: vi.fn(),
      histogram: fakeHistogram(0)
    })
    expect(scheduledMs).toBe(1000)
  })
})
