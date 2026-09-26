import { describe, it, expect, vi } from 'vitest'
import { startRunObservability } from './run-observability'
import type { PriorRun } from '../../boot-sentinel'
import type { StallMonitor, StallMonitorOptions } from './stall-monitor'

function fakePrior(overrides: Partial<PriorRun> = {}): PriorRun {
  return { prevBootId: undefined, prevShutdown: 'unknown', prevLastAliveAt: undefined, ...overrides }
}

function fakePowerMonitor() {
  return { on: vi.fn(), removeListener: vi.fn() }
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
        startStallMonitor: vi.fn(() => ({ stop: vi.fn(), resync: vi.fn() })),
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
        startStallMonitor: vi.fn(() => ({ stop: vi.fn(), resync: vi.fn() })),
        setIntervalFn,
        clearIntervalFn: vi.fn()
      }
    })
    expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 10_000)
    setIntervalFn.mock.calls[0][0]()
    expect(markAlive).toHaveBeenCalledExactlyOnceWith('/fake', 'boot-1')
  })

  it('starts the stall monitor for this bootId and wires its callbacks to app.stall / app.stall.summary, attaching the last phase set', () => {
    const audit = vi.fn()
    let captured: StallMonitorOptions | undefined
    const startStallMonitor = vi.fn((o: StallMonitorOptions) => {
      captured = o
      return { stop: vi.fn(), resync: vi.fn() }
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
    captured!.onStall({ bootId: 'boot-9', durationMs: 1500 })
    expect(audit).toHaveBeenCalledWith('app.stall', { bootId: 'boot-9', durationMs: 1500, phase: undefined })
    observability.setPhase('boot:createTray')
    captured!.onStall({ bootId: 'boot-9', durationMs: 2000 })
    expect(audit).toHaveBeenCalledWith('app.stall', { bootId: 'boot-9', durationMs: 2000, phase: 'boot:createTray' })
    captured!.onSummary({ bootId: 'boot-9', p99Ms: 7 })
    expect(audit).toHaveBeenCalledWith('app.stall.summary', { bootId: 'boot-9', p99Ms: 7 })
  })

  it('resyncs the stall monitor when powerMonitor emits resume', () => {
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
        startStallMonitor: vi.fn(() => ({ stop: vi.fn(), resync })),
        setIntervalFn: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
        clearIntervalFn: vi.fn()
      }
    })
    expect(powerMonitor.on).toHaveBeenCalledExactlyOnceWith('resume', expect.any(Function))
    const onResume = powerMonitor.on.mock.calls[0][1] as () => void
    onResume()
    expect(resync).toHaveBeenCalledOnce()
  })

  it('shutdownClean stops the alive timer and stall monitor, unsubscribes from resume, and audits app.shutdown.clean with markShutdownClean\'s detail', () => {
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
        startStallMonitor: vi.fn(() => ({ stop, resync: vi.fn() })),
        setIntervalFn: vi.fn(() => 1234 as unknown as ReturnType<typeof setInterval>),
        clearIntervalFn
      }
    })
    observability.shutdownClean(42)
    expect(clearIntervalFn).toHaveBeenCalledWith(1234)
    expect(stop).toHaveBeenCalledOnce()
    expect(powerMonitor.removeListener).toHaveBeenCalledExactlyOnceWith('resume', expect.any(Function))
    expect(markShutdownClean).toHaveBeenCalledWith('/fake', 'boot-7', 42)
    expect(audit).toHaveBeenCalledExactlyOnceWith('app.shutdown.clean', { bootId: 'boot-7', uptimeS: 42, reason: 'will-quit' })
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
        startStallMonitor: vi.fn(() => ({ stop, resync: vi.fn() })),
        setIntervalFn: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
        clearIntervalFn: vi.fn()
      }
    })
    observability.shutdownClean(1)
    observability.shutdownClean(1)
    expect(stop).toHaveBeenCalledOnce()
    expect(audit.mock.calls.filter((c) => c[0] === 'app.shutdown.clean')).toHaveLength(1)
  })

  it('never touches a real boot-sentinel/stall-monitor dependency when every dep is injected (isolation check)', () => {
    // Guards against a future edit silently falling back to a real dependency inside the module (which
    // would make this file's fs- and timer-free tests reach real disk or real timers).
    const calls: string[] = []
    startRunObservability({
      userData: '/fake',
      version: '1.9.7',
      platform: 'darwin',
      arch: 'arm64',
      audit: vi.fn(),
      powerMonitor: fakePowerMonitor(),
      deps: {
        beginRunWatch: () => {
          calls.push('beginRunWatch')
          return { bootId: 'boot-1', prior: fakePrior() }
        },
        markAlive: vi.fn(),
        markShutdownClean: vi.fn(() => ({ bootId: 'boot-1', uptimeS: 0, reason: 'will-quit' as const })),
        startStallMonitor: vi.fn((): StallMonitor => ({ stop: vi.fn(), resync: vi.fn() })),
        setIntervalFn: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
        clearIntervalFn: vi.fn()
      }
    })
    expect(calls).toEqual(['beginRunWatch'])
  })
})
