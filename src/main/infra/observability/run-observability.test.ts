import { describe, it, expect, vi } from 'vitest'
import { startRunObservability } from './run-observability'
import { startStallMonitor } from './stall-monitor'
import type { PriorRun } from '../../boot-sentinel'
import type { StallMonitor, StallMonitorOptions } from './stall-monitor'

function fakePrior(overrides: Partial<PriorRun> = {}): PriorRun {
  return { prevBootId: undefined, prevShutdown: 'unknown', prevLastAliveAt: undefined, ...overrides }
}

function fakePowerMonitor() {
  return { on: vi.fn(), removeListener: vi.fn() }
}

function fakeStallMonitor(overrides: Partial<StallMonitor> = {}): StallMonitor {
  return {
    stop: vi.fn(),
    resync: vi.fn(),
    pause: vi.fn(),
    // A plain passthrough, not vi.fn(...): timePhase is generic (<T>(label, fn: () => T) => T), and a
    // vi.fn()-wrapped implementation has its own already-concrete Mock type, which a generic method slot
    // can never structurally accept. A bare function expression is fine — TS infers this one against the
    // slot's own signature. Tests that need to assert on calls override this with their own wrapper (see
    // below) instead of asserting on this default.
    timePhase: (_label, fn) => fn(),
    ...overrides
  }
}

/** A controllable interval + monotonic clock for driving the REAL startStallMonitor (not a fake) through
 *  startRunObservability's own `deps.startStallMonitor` seam, so the unlock-screen tests below exercise the
 *  actual resync()/pause() wiring production runs, not a mock's assumptions about it. `jumpTo` moves the
 *  clock without firing the interval, modelling time passing while the main thread is blocked and the
 *  interval's own tick is still queued behind it; `advanceTo` fires the (possibly overdue) tick. */
function fakeHeartbeat(): {
  now: () => number
  advanceTo: (t: number) => void
  jumpTo: (t: number) => void
  setIntervalFn: (handler: () => void, ms: number) => NodeJS.Timeout
  clearIntervalFn: (handle: NodeJS.Timeout) => void
} {
  let current = 0
  let tick: (() => void) | undefined
  return {
    now: () => current,
    advanceTo: (t) => {
      current = t
      tick?.()
    },
    jumpTo: (t) => {
      current = t
    },
    setIntervalFn: (handler) => {
      tick = handler
      return 1 as unknown as NodeJS.Timeout
    },
    clearIntervalFn: () => {
      tick = undefined
    }
  }
}

function fakeHistogram() {
  return { enable: vi.fn(() => true), disable: vi.fn(() => true), reset: vi.fn(), percentile: vi.fn(() => 0) }
}

describe('startRunObservability', () => {
  it('audits app.started with the fields beginRunWatch reports', () => {
    const audit = vi.fn()
    const beginRunWatch = vi.fn(() => ({ bootId: 'boot-42', prior: fakePrior({ prevBootId: 'boot-41', prevShutdown: 'clean', prevLastAliveAt: '2026-01-01T00:00:00.000Z' }) }))
    startRunObservability({
      userData: '/fake/userData',
      version: '1.9.7',
      platform: 'darwin',
      arch: 'arm64',
      audit,
      powerMonitor: fakePowerMonitor(),
      deps: {
        beginRunWatch,
        startStallMonitor: vi.fn(() => fakeStallMonitor()),
        setIntervalFn: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
        clearIntervalFn: vi.fn()
      }
    })
    expect(beginRunWatch).toHaveBeenCalledExactlyOnceWith('/fake/userData')
    expect(audit).toHaveBeenCalledWith('app.started', {
      version: '1.9.7',
      platform: 'darwin',
      arch: 'arm64',
      bootId: 'boot-42',
      prevBootId: 'boot-41',
      prevShutdown: 'clean',
      prevLastAliveAt: '2026-01-01T00:00:00.000Z'
    })
  })

  it('starts a 10s alive timer that calls markAlive with the current bootId', () => {
    const setIntervalFn = vi.fn((_handler: () => void, _ms: number) => 1 as unknown as ReturnType<typeof setInterval>)
    const markAlive = vi.fn()
    startRunObservability({
      userData: '/fake',
      version: '1.9.7',
      platform: 'darwin',
      arch: 'arm64',
      audit: vi.fn(),
      powerMonitor: fakePowerMonitor(),
      deps: {
        beginRunWatch: () => ({ bootId: 'boot-1', prior: fakePrior() }),
        markAlive,
        startStallMonitor: vi.fn(() => fakeStallMonitor()),
        setIntervalFn,
        clearIntervalFn: vi.fn()
      }
    })
    expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 10_000)
    setIntervalFn.mock.calls[0][0]()
    expect(markAlive).toHaveBeenCalledExactlyOnceWith('/fake', 'boot-1')
  })

  it("wires the stall monitor's onStall/onSummary details straight through to app.stall / app.stall.summary, and timePhase delegates to the stall monitor", () => {
    // The stall monitor (not this module) now owns measuring and deciding what phase, if any, a tick
    // names — see stall-monitor.test.ts for that behaviour. This module's only job is to forward whatever
    // detail it receives, and to forward timePhase calls to the stall monitor that owns them.
    const audit = vi.fn()
    // A spy called from inside a plain wrapper, not passed directly as the generic timePhase slot itself
    // — see fakeStallMonitor's own comment for why a vi.fn() value can't fill that slot.
    const timePhaseSpy = vi.fn()
    let captured: StallMonitorOptions | undefined
    const startStallMonitor = vi.fn((o: StallMonitorOptions) => {
      captured = o
      return fakeStallMonitor({
        timePhase: (label, fn) => {
          timePhaseSpy(label, fn)
          return fn()
        }
      })
    })
    const observability = startRunObservability({
      userData: '/fake',
      version: '1.9.7',
      platform: 'darwin',
      arch: 'arm64',
      audit,
      powerMonitor: fakePowerMonitor(),
      deps: {
        beginRunWatch: () => ({ bootId: 'boot-9', prior: fakePrior() }),
        startStallMonitor,
        setIntervalFn: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
        clearIntervalFn: vi.fn()
      }
    })
    expect(startStallMonitor).toHaveBeenCalledWith(expect.objectContaining({ bootId: 'boot-9' }))
    captured!.onStall({ bootId: 'boot-9', durationMs: 1500, phase: undefined, phaseMs: undefined })
    expect(audit).toHaveBeenCalledWith('app.stall', { bootId: 'boot-9', durationMs: 1500, phase: undefined, phaseMs: undefined })
    captured!.onStall({ bootId: 'boot-9', durationMs: 2000, phase: 'ensureMeetingsFolder', phaseMs: 1800 })
    expect(audit).toHaveBeenCalledWith('app.stall', { bootId: 'boot-9', durationMs: 2000, phase: 'ensureMeetingsFolder', phaseMs: 1800 })
    captured!.onSummary({ bootId: 'boot-9', p99Ms: 7 })
    expect(audit).toHaveBeenCalledWith('app.stall.summary', { bootId: 'boot-9', p99Ms: 7 })

    const result = observability.timePhase('ensureMeetingsFolder', () => 42)
    expect(timePhaseSpy).toHaveBeenCalledExactlyOnceWith('ensureMeetingsFolder', expect.any(Function))
    expect(result).toBe(42) // forwards the stall monitor's return value, not just the call
  })

  it('pauses the stall monitor on powerMonitor suspend and resyncs it on resume', () => {
    const pause = vi.fn()
    const resync = vi.fn()
    const powerMonitor = fakePowerMonitor()
    startRunObservability({
      userData: '/fake',
      version: '1.9.7',
      platform: 'darwin',
      arch: 'arm64',
      audit: vi.fn(),
      powerMonitor,
      deps: {
        beginRunWatch: () => ({ bootId: 'boot-1', prior: fakePrior() }),
        startStallMonitor: vi.fn(() => fakeStallMonitor({ pause, resync })),
        setIntervalFn: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
        clearIntervalFn: vi.fn()
      }
    })
    expect(powerMonitor.on).toHaveBeenCalledWith('suspend', expect.any(Function))
    expect(powerMonitor.on).toHaveBeenCalledWith('resume', expect.any(Function))
    const onSuspend = powerMonitor.on.mock.calls.find((c) => c[0] === 'suspend')![1] as () => void
    const onResume = powerMonitor.on.mock.calls.find((c) => c[0] === 'resume')![1] as () => void
    onSuspend()
    expect(pause).toHaveBeenCalledOnce()
    onResume()
    expect(resync).toHaveBeenCalledOnce()
  })

  it("resyncs the stall monitor on powerMonitor's unlock-screen only when 'suspend' actually paused it and no 'resume' re-armed it since — never re-baselining a heartbeat that never stopped ticking, since a screen lock usually leaves the machine awake with the heartbeat still running", () => {
    const resync = vi.fn()
    const powerMonitor = fakePowerMonitor()
    startRunObservability({
      userData: '/fake',
      version: '1.9.7',
      platform: 'darwin',
      arch: 'arm64',
      audit: vi.fn(),
      powerMonitor,
      deps: {
        beginRunWatch: () => ({ bootId: 'boot-1', prior: fakePrior() }),
        startStallMonitor: vi.fn(() => fakeStallMonitor({ resync })),
        setIntervalFn: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
        clearIntervalFn: vi.fn()
      }
    })
    const onSuspend = powerMonitor.on.mock.calls.find((c) => c[0] === 'suspend')![1] as () => void
    const onResume = powerMonitor.on.mock.calls.find((c) => c[0] === 'resume')![1] as () => void
    const onUnlockScreen = powerMonitor.on.mock.calls.find((c) => c[0] === 'unlock-screen')![1] as () => void

    onUnlockScreen() // no 'suspend' happened — the heartbeat is running; must not resync it
    expect(resync).not.toHaveBeenCalled()

    onSuspend()
    onResume() // 'resume' resyncs unconditionally, on its own — unrelated to unlock-screen's guard
    expect(resync).toHaveBeenCalledTimes(1)
    onUnlockScreen() // 'resume' already re-armed it — a later unlock-screen must not resync it again
    expect(resync).toHaveBeenCalledTimes(1) // still just resume's call; unlock-screen added nothing

    onSuspend()
    onUnlockScreen() // 'resume' never arrived — this is the fallback path unlock-screen exists for
    expect(resync).toHaveBeenCalledTimes(2) // one more call, this time from unlock-screen itself
  })

  it('unlock-screen does not re-baseline a running heartbeat, so lateness already accumulated before it fires is still reported as app.stall', () => {
    const audit = vi.fn()
    const heartbeat = fakeHeartbeat()
    const powerMonitor = fakePowerMonitor()
    startRunObservability({
      userData: '/fake',
      version: '1.9.7',
      platform: 'darwin',
      arch: 'arm64',
      audit,
      powerMonitor,
      deps: {
        beginRunWatch: () => ({ bootId: 'boot-1', prior: fakePrior() }),
        startStallMonitor: (opts) =>
          startStallMonitor({
            ...opts,
            tickMs: 1000,
            summaryIntervalMs: 10_000,
            now: heartbeat.now,
            setIntervalFn: heartbeat.setIntervalFn,
            clearIntervalFn: heartbeat.clearIntervalFn,
            histogram: fakeHistogram()
          }),
        setIntervalFn: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
        clearIntervalFn: vi.fn()
      }
    })
    const onUnlockScreen = powerMonitor.on.mock.calls.find((c) => c[0] === 'unlock-screen')![1] as () => void

    heartbeat.advanceTo(1000) // on-time tick — expectedAt -> 2000
    // The main thread is blocked (e.g. a synchronous OneDrive read); the heartbeat's own overdue tick and
    // the unlock-screen callback are both queued behind it, in unspecified order. Model the unlock-screen
    // callback running first, before the overdue tick.
    heartbeat.jumpTo(8000)
    onUnlockScreen()
    heartbeat.advanceTo(8000) // the overdue tick finally runs

    expect(audit).toHaveBeenCalledWith('app.stall', expect.objectContaining({ bootId: 'boot-1', durationMs: 6000 }))
  })

  it('unlock-screen restarts a heartbeat that suspend paused and no resume re-armed', () => {
    const heartbeat = fakeHeartbeat()
    const powerMonitor = fakePowerMonitor()
    const setIntervalSpy = vi.fn(heartbeat.setIntervalFn)
    startRunObservability({
      userData: '/fake',
      version: '1.9.7',
      platform: 'darwin',
      arch: 'arm64',
      audit: vi.fn(),
      powerMonitor,
      deps: {
        beginRunWatch: () => ({ bootId: 'boot-1', prior: fakePrior() }),
        startStallMonitor: (opts) =>
          startStallMonitor({
            ...opts,
            tickMs: 1000,
            summaryIntervalMs: 10_000,
            now: heartbeat.now,
            setIntervalFn: setIntervalSpy,
            clearIntervalFn: heartbeat.clearIntervalFn,
            histogram: fakeHistogram()
          }),
        setIntervalFn: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
        clearIntervalFn: vi.fn()
      }
    })
    const onSuspend = powerMonitor.on.mock.calls.find((c) => c[0] === 'suspend')![1] as () => void
    const onUnlockScreen = powerMonitor.on.mock.calls.find((c) => c[0] === 'unlock-screen')![1] as () => void

    expect(setIntervalSpy).toHaveBeenCalledOnce() // the initial heartbeat
    onSuspend() // clears the heartbeat's interval
    onUnlockScreen() // no 'resume' arrived — this is the fallback path
    expect(setIntervalSpy).toHaveBeenCalledTimes(2) // resync() restarted it
  })

  it("shutdownClean stops the alive timer and stall monitor, unsubscribes from suspend, resume and unlock-screen, and audits app.shutdown.clean with markShutdownClean's detail", () => {
    const audit = vi.fn()
    const clearIntervalFn = vi.fn()
    const stop = vi.fn()
    const powerMonitor = fakePowerMonitor()
    const markShutdownClean = vi.fn(() => ({ bootId: 'boot-7', uptimeS: 42, reason: 'will-quit' as const }))
    const observability = startRunObservability({
      userData: '/fake',
      version: '1.9.7',
      platform: 'darwin',
      arch: 'arm64',
      audit,
      powerMonitor,
      deps: {
        beginRunWatch: () => ({ bootId: 'boot-7', prior: fakePrior() }),
        markShutdownClean,
        startStallMonitor: vi.fn(() => fakeStallMonitor({ stop })),
        setIntervalFn: vi.fn(() => 1234 as unknown as ReturnType<typeof setInterval>),
        clearIntervalFn
      }
    })
    observability.shutdownClean(42)
    expect(clearIntervalFn).toHaveBeenCalledWith(1234)
    expect(stop).toHaveBeenCalledOnce()
    expect(powerMonitor.removeListener).toHaveBeenCalledWith('suspend', expect.any(Function))
    expect(powerMonitor.removeListener).toHaveBeenCalledWith('resume', expect.any(Function))
    expect(powerMonitor.removeListener).toHaveBeenCalledWith('unlock-screen', expect.any(Function))
    expect(markShutdownClean).toHaveBeenCalledWith('/fake', 'boot-7', 42)
    // audit was already called once with app.started at construction — this checks the shutdown call
    // specifically, not that it's the mock's only call.
    expect(audit).toHaveBeenCalledWith('app.shutdown.clean', { bootId: 'boot-7', uptimeS: 42, reason: 'will-quit' })
  })

  it('shutdownClean is idempotent — a second call does nothing more', () => {
    const audit = vi.fn()
    const stop = vi.fn()
    const observability = startRunObservability({
      userData: '/fake',
      version: '1.9.7',
      platform: 'darwin',
      arch: 'arm64',
      audit,
      powerMonitor: fakePowerMonitor(),
      deps: {
        beginRunWatch: () => ({ bootId: 'boot-1', prior: fakePrior() }),
        markShutdownClean: vi.fn(() => ({ bootId: 'boot-1', uptimeS: 1, reason: 'will-quit' as const })),
        startStallMonitor: vi.fn(() => fakeStallMonitor({ stop })),
        setIntervalFn: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
        clearIntervalFn: vi.fn()
      }
    })
    observability.shutdownClean(1)
    observability.shutdownClean(1)
    expect(stop).toHaveBeenCalledOnce()
    expect(audit.mock.calls.filter((c) => c[0] === 'app.shutdown.clean')).toHaveLength(1)
  })
})
