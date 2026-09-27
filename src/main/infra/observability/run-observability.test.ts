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
    restartIfPaused: vi.fn(),
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
 *  actual restartIfPaused()/pause() wiring production runs, not a mock's assumptions about it. `jumpTo` moves the
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

  it("exposes the prior run's shutdown classification", () => {
    const observability = startRunObservability({
      userData: '/fake/userData',
      version: '1.9.7',
      platform: 'darwin',
      arch: 'arm64',
      audit: vi.fn(),
      powerMonitor: fakePowerMonitor(),
      deps: {
        beginRunWatch: () => ({ bootId: 'boot-42', prior: fakePrior({ prevShutdown: 'unclean' }) }),
        startStallMonitor: vi.fn(() => fakeStallMonitor()),
        setIntervalFn: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
        clearIntervalFn: vi.fn()
      }
    })
    expect((observability as typeof observability & { priorShutdown: 'unclean' }).priorShutdown).toBe('unclean')
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

  it("suspend calls pause(); resume and unlock-screen each call restartIfPaused(), unconditionally and with no local flag gating either", () => {
    const pause = vi.fn()
    const restartIfPaused = vi.fn()
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
        startStallMonitor: vi.fn(() => fakeStallMonitor({ pause, restartIfPaused })),
        setIntervalFn: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
        clearIntervalFn: vi.fn()
      }
    })
    expect(powerMonitor.on).toHaveBeenCalledWith('suspend', expect.any(Function))
    expect(powerMonitor.on).toHaveBeenCalledWith('resume', expect.any(Function))
    expect(powerMonitor.on).toHaveBeenCalledWith('unlock-screen', expect.any(Function))
    const onSuspend = powerMonitor.on.mock.calls.find((c) => c[0] === 'suspend')![1] as () => void
    const onResume = powerMonitor.on.mock.calls.find((c) => c[0] === 'resume')![1] as () => void
    const onUnlockScreen = powerMonitor.on.mock.calls.find((c) => c[0] === 'unlock-screen')![1] as () => void

    onSuspend()
    expect(pause).toHaveBeenCalledOnce()

    onResume()
    expect(restartIfPaused).toHaveBeenCalledTimes(1)

    onUnlockScreen()
    expect(restartIfPaused).toHaveBeenCalledTimes(2) // both events reach the same method; no local flag gates either
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

  it('unlock-screen restarts a heartbeat that suspend paused and no resume re-armed, proven by a correctly-timed app.stall firing afterward', () => {
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
    const onSuspend = powerMonitor.on.mock.calls.find((c) => c[0] === 'suspend')![1] as () => void
    const onUnlockScreen = powerMonitor.on.mock.calls.find((c) => c[0] === 'unlock-screen')![1] as () => void

    onSuspend() // clears the heartbeat's interval
    heartbeat.jumpTo(3_600_000) // asleep for an hour, on a clock that keeps counting through sleep
    onUnlockScreen() // no 'resume' arrived — this is the fallback path; restarts from a baseline of 3_600_000

    heartbeat.advanceTo(3_601_000) // on schedule relative to the restart — the sleep gap was absorbed
    expect(audit).not.toHaveBeenCalledWith('app.stall', expect.anything())

    heartbeat.advanceTo(3_603_500) // the next tick fires 1500ms late relative to that same restart baseline
    expect(audit).toHaveBeenCalledWith('app.stall', expect.objectContaining({ bootId: 'boot-1', durationMs: 1500 }))
  })

  it('M2-0006 round-3 finding: a resume that arrives after unlock-screen already restarted the heartbeat must not discard the lateness that accrues afterward', () => {
    // suspend -> unlock-screen restarts the paused heartbeat (no 'resume' has arrived yet) -> the main
    // thread then stalls, so the overdue tick and 'resume' are both queued behind it, in unspecified
    // order. Model 'resume' being processed first: a handler that unconditionally resyncs (the pre-fix
    // behaviour) would re-baseline expectedAt at that point and erase the lateness already building since
    // unlock-screen's restart; restartIfPaused() is a no-op here instead, because the heartbeat
    // unlock-screen restarted is still running.
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
    const onSuspend = powerMonitor.on.mock.calls.find((c) => c[0] === 'suspend')![1] as () => void
    const onResume = powerMonitor.on.mock.calls.find((c) => c[0] === 'resume')![1] as () => void
    const onUnlockScreen = powerMonitor.on.mock.calls.find((c) => c[0] === 'unlock-screen')![1] as () => void

    onSuspend()
    heartbeat.jumpTo(8000) // asleep
    onUnlockScreen() // restarts from a baseline of 8000; expectedAt -> 9000

    heartbeat.jumpTo(12_000) // main thread blocked: the overdue tick and 'resume' are both queued behind it
    onResume() // processed first — must be a no-op on the heartbeat unlock-screen already restarted

    heartbeat.advanceTo(12_000) // the overdue tick finally fires: 3000ms late relative to the 9000 baseline
    expect(audit).toHaveBeenCalledWith('app.stall', expect.objectContaining({ bootId: 'boot-1', durationMs: 3000 }))
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

  // M2-0192: the out-of-process stall sampler (stall-sampler.ts). These three tests prove
  // startRunObservability's own wiring only — stall-sampler.ts's own behaviour is stall-sampler.test.ts's job.
  it('starts the stall sampler with the helper command, userData, bootId, the alive interval and audit, when stallWatchCommand is given', () => {
    const startStallSampler = vi.fn(() => ({ stop: vi.fn() }))
    startRunObservability({
      userData: '/fake',
      version: '1.9.7',
      platform: 'darwin',
      arch: 'arm64',
      audit: vi.fn(),
      powerMonitor: fakePowerMonitor(),
      stallWatchCommand: '/x/metis-mac-helper',
      deps: {
        beginRunWatch: () => ({ bootId: 'boot-1', prior: fakePrior() }),
        startStallMonitor: vi.fn(() => fakeStallMonitor()),
        startStallSampler,
        setIntervalFn: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
        clearIntervalFn: vi.fn()
      }
    })
    expect(startStallSampler).toHaveBeenCalledExactlyOnceWith({
      command: '/x/metis-mac-helper',
      userData: '/fake',
      bootId: 'boot-1',
      aliveIntervalMs: 10_000,
      audit: expect.any(Function)
    })
  })

  it("shutdownClean stops the stall sampler before it clears the alive timer, and before app.shutdown.clean is audited", () => {
    const order: string[] = []
    const audit = vi.fn((event: string) => {
      if (event === 'app.shutdown.clean') order.push('audit')
    })
    const startStallSampler = vi.fn(() => ({ stop: vi.fn(() => order.push('sampler.stop')) }))
    const clearIntervalFn = vi.fn(() => order.push('clearInterval'))
    const observability = startRunObservability({
      userData: '/fake',
      version: '1.9.7',
      platform: 'darwin',
      arch: 'arm64',
      audit,
      powerMonitor: fakePowerMonitor(),
      stallWatchCommand: '/x/metis-mac-helper',
      deps: {
        beginRunWatch: () => ({ bootId: 'boot-1', prior: fakePrior() }),
        startStallMonitor: vi.fn(() => fakeStallMonitor()),
        startStallSampler,
        markShutdownClean: vi.fn(() => ({ bootId: 'boot-1', uptimeS: 1, reason: 'will-quit' as const })),
        setIntervalFn: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
        clearIntervalFn
      }
    })
    observability.shutdownClean(1)
    expect(order).toEqual(['sampler.stop', 'clearInterval', 'audit'])
  })

  it('never starts a stall sampler when stallWatchCommand is absent, or explicitly null (no helper on this platform, or the flag off)', () => {
    const startStallSampler = vi.fn(() => ({ stop: vi.fn() }))
    for (const stallWatchCommand of [undefined, null] as const) {
      startRunObservability({
        userData: '/fake',
        version: '1.9.7',
        platform: 'darwin',
        arch: 'arm64',
        audit: vi.fn(),
        powerMonitor: fakePowerMonitor(),
        stallWatchCommand,
        deps: {
          beginRunWatch: () => ({ bootId: 'boot-1', prior: fakePrior() }),
          startStallMonitor: vi.fn(() => fakeStallMonitor()),
          startStallSampler,
          setIntervalFn: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
          clearIntervalFn: vi.fn()
        }
      })
    }
    expect(startStallSampler).not.toHaveBeenCalled()
  })
})
