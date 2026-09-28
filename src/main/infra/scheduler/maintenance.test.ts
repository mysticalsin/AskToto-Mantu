import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginMaintenance,
  maintenanceDeferral,
  noteUserInput,
  onMaintenanceMayBegin,
  reportDeferred,
  resetMaintenanceGateForTests,
  runAsMaintenance,
  settlePriorExit,
  startMaintenanceGate,
  whenMaintenanceWindowOpens
} from './maintenance'

const auditLogMock = vi.hoisted(() => vi.fn())
vi.mock('../../logger', async (orig) => ({ ...(await orig()), auditLog: auditLogMock }))

describe('maintenance gate', () => {
  let uptime: number
  let interactive: boolean
  let scheduled: Array<{ run: () => void; ms: number }>

  beforeEach(() => {
    resetMaintenanceGateForTests()
    auditLogMock.mockReset()
    uptime = 121_000
    interactive = false
    scheduled = []
  })

  const startOpen = () => {
    startMaintenanceGate({
      uptimeMs: () => uptime,
      interactiveActive: () => interactive,
      schedule: (run: () => void, ms: number) => { scheduled.push({ run, ms }) }
    })
    settlePriorExit('clean')
  }

  it('not started admits everything and records no audit', async () => {
    expect(maintenanceDeferral()).toBeNull()
    const release = beginMaintenance()
    expect(typeof release).toBe('function')
    release()
    await runAsMaintenance(async () => 'ok')
    await expect(whenMaintenanceWindowOpens()).resolves.toBeUndefined()
    expect(auditLogMock).not.toHaveBeenCalled()
  })

  it('runAsMaintenance serializes work and releases after rejection', async () => {
    startOpen()
    const order: string[] = []
    let releaseFirst!: () => void
    const first = runAsMaintenance(async () => {
      order.push('first:start')
      await new Promise<void>((resolve) => { releaseFirst = resolve })
      order.push('first:end')
      throw new Error('synthetic failure')
    })
    const second = runAsMaintenance(async () => {
      order.push('second:start')
      return 'second'
    })

    await Promise.resolve()
    expect(order).toEqual(['first:start'])
    releaseFirst()
    await expect(first).rejects.toThrow('synthetic failure')
    await expect(second).resolves.toBe('second')
    expect(order).toEqual(['first:start', 'first:end', 'second:start'])
  })

  it('FIFO waiters start in enqueue order', async () => {
    startOpen()
    const order: number[] = []
    let releaseFirst!: () => void
    const first = runAsMaintenance(() => new Promise<void>((resolve) => { releaseFirst = resolve }))
    const second = runAsMaintenance(async () => { order.push(2) })
    const third = runAsMaintenance(async () => { order.push(3) })
    await Promise.resolve()
    expect(order).toEqual([])
    releaseFirst()
    await first
    await second
    await third
    expect(order).toEqual([2, 3])
  })

  it('beginMaintenance throws when deferred', () => {
    uptime = 0
    startMaintenanceGate({
      uptimeMs: () => uptime,
      interactiveActive: () => false,
      schedule: (run: () => void, ms: number) => { scheduled.push({ run, ms }) }
    })
    settlePriorExit('clean')
    expect(() => beginMaintenance()).toThrow('maintenance is deferred (boot_quiet_period)')
  })

  it('release is idempotent and listeners fire in a microtask after a release', async () => {
    startOpen()
    const listener = vi.fn()
    const unsubscribe = onMaintenanceMayBegin(listener)
    const release = beginMaintenance()
    expect(maintenanceDeferral()).toBe('maintenance_running')
    release()
    release()
    expect(listener).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(listener).toHaveBeenCalled()
    expect(maintenanceDeferral()).toBeNull()
    unsubscribe()
  })

  it('unsubscribed listeners do not fire when a queued window-open microtask runs', async () => {
    startOpen()
    const listener = vi.fn()
    const unsubscribe = onMaintenanceMayBegin(listener)

    unsubscribe()
    await Promise.resolve()

    expect(listener).not.toHaveBeenCalled()
  })

  it('can clear listeners during isolated test teardown without changing the default reset', async () => {
    const listener = vi.fn()
    onMaintenanceMayBegin(listener)

    resetMaintenanceGateForTests({ listeners: true })
    startOpen()
    await Promise.resolve()

    expect(listener).not.toHaveBeenCalled()
  })

  it('interactive re-check is scheduled only while waiters exist', async () => {
    uptime = 121_000
    interactive = true
    startMaintenanceGate({
      uptimeMs: () => uptime,
      interactiveActive: () => interactive,
      schedule: (run: () => void, ms: number) => { scheduled.push({ run, ms }) }
    })
    settlePriorExit('clean')
    const work = vi.fn(async () => undefined)
    const waiting = runAsMaintenance(work)
    await Promise.resolve()
    expect(work).not.toHaveBeenCalled()
    expect(scheduled.some((entry) => entry.ms === 5_000)).toBe(true)
    interactive = false
    scheduled.at(-1)?.run()
    await waiting
    expect(work).toHaveBeenCalledOnce()
  })

  it('whenMaintenanceWindowOpens resolves once, and immediately when open', async () => {
    uptime = 0
    startMaintenanceGate({
      uptimeMs: () => uptime,
      interactiveActive: () => false,
      schedule: (run: () => void, ms: number) => { scheduled.push({ run, ms }) }
    })
    settlePriorExit('clean')
    const first = vi.fn()
    const wait = whenMaintenanceWindowOpens().then(first)
    await Promise.resolve()
    expect(first).not.toHaveBeenCalled()
    uptime = 121_000
    scheduled[0].run()
    await wait
    expect(first).toHaveBeenCalledOnce()
    await expect(whenMaintenanceWindowOpens()).resolves.toBeUndefined()
  })

  it('reportDeferred audits once per kind and reason', () => {
    reportDeferred('backfill', 'ledger_unavailable')
    reportDeferred('backfill', 'ledger_unavailable')
    reportDeferred('ingest', 'ledger_unavailable')
    reportDeferred('backfill', 'boot_quiet_period')
    expect(auditLogMock.mock.calls).toEqual([
      ['scheduler.job', { kind: 'backfill', outcome: 'deferred', deferredReason: 'ledger_unavailable' }],
      ['scheduler.job', { kind: 'ingest', outcome: 'deferred', deferredReason: 'ledger_unavailable' }],
      ['scheduler.job', { kind: 'backfill', outcome: 'deferred', deferredReason: 'boot_quiet_period' }]
    ])
  })

  it('deliberate input opens an unclean-exit gate, while movement does not', () => {
    uptime = 121_000
    startMaintenanceGate({
      uptimeMs: () => uptime,
      interactiveActive: () => false,
      schedule: (run: () => void, ms: number) => { scheduled.push({ run, ms }) }
    })
    settlePriorExit('unclean')
    expect(maintenanceDeferral()).toBe('awaiting_first_interaction')
    noteUserInput('mouseMove')
    expect(maintenanceDeferral()).toBe('awaiting_first_interaction')
    noteUserInput('mouseDown')
    expect(maintenanceDeferral()).toBeNull()
  })
})
