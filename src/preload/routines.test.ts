import { describe, expect, it, vi } from 'vitest'
import { ROUTINE_IPC } from '../shared/routines'
import { createRoutinesPreloadApi } from './routines'

const ID = `r_${'a'.repeat(24)}`
const VIEW = {
  routineId: ID,
  assistantId: 'sys-sales',
  title: 'Stand up',
  purpose: 'reminder',
  consentKind: 'recurring',
  schedule: { kind: 'recurring', cadence: 'daily', time: '09:00', timeZone: 'UTC' },
  copy: 'Every day 09:00 UTC',
  status: 'active',
  pauseReasons: [],
  waiting: null,
  failures: 0,
  lastErrorClass: null,
  nextDueAt: 1,
  quotaResetAt: null,
  history: [],
  availability: { runner: 'running', copy: 'Runs while Métis is open' }
}

describe('routines preload bridge (G66)', () => {
  it('forwards each call on its channel with only the typed payload', async () => {
    const invoke = vi.fn(async (...args: unknown[]) => {
      void args
      return { ok: false, reason: 'signed-out' }
    })
    const { routines } = createRoutinesPreloadApi({ invoke, on: vi.fn(), removeListener: vi.fn() } as never)
    await routines.list()
    await routines.compile({
      assistantId: 'sys-sales',
      purpose: 'reminder',
      title: 'x',
      consentKind: 'recurring',
      phrase: 'every day at 9am'
    })
    await routines.consent('a'.repeat(32), 'b'.repeat(64))
    await routines.pause(ID)
    await routines.resume(ID, true)
    await routines.runNow(ID)
    await routines.remove(ID)
    expect(invoke.mock.calls.map((c) => c[0])).toEqual([
      ROUTINE_IPC.list,
      ROUTINE_IPC.compile,
      ROUTINE_IPC.consent,
      ROUTINE_IPC.pause,
      ROUTINE_IPC.resume,
      ROUTINE_IPC.runNow,
      ROUTINE_IPC.remove
    ])
    expect(invoke.mock.calls[2]![1]).toEqual({ proposalId: 'a'.repeat(32), previewHash: 'b'.repeat(64) })
    expect(invoke.mock.calls[4]![1]).toEqual({ routineId: ID, reconciled: true })
  })

  it('passes a valid reply through', async () => {
    const invoke = vi.fn(async () => ({ ok: true, routines: [VIEW] }))
    const { routines } = createRoutinesPreloadApi({ invoke, on: vi.fn(), removeListener: vi.fn() } as never)
    expect(await routines.list()).toEqual({ ok: true, routines: [VIEW] })
  })

  it('malformed reply → unavailable', async () => {
    const leaky = { ok: true, routines: [{ ...VIEW, ownerKey: 'a'.repeat(64) }] }
    const invoke = vi.fn(async (..._args: unknown[]) => leaky as unknown)
    const { routines } = createRoutinesPreloadApi({ invoke, on: vi.fn(), removeListener: vi.fn() } as never)
    expect(await routines.list()).toEqual({ ok: false, reason: 'unavailable' })
    invoke.mockResolvedValueOnce('nonsense')
    expect(await routines.pause(ID)).toEqual({ ok: false, reason: 'unavailable' })
    invoke.mockRejectedValueOnce(new Error('ipc'))
    expect(await routines.runNow(ID)).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('validates pushes and unsubscribes', () => {
    const handlers = new Map<string, (e: unknown, raw: unknown) => void>()
    const ipc = {
      invoke: vi.fn(),
      on: (channel: string, h: (e: unknown, raw: unknown) => void) => void handlers.set(channel, h),
      removeListener: (channel: string) => void handlers.delete(channel)
    }
    const { routines } = createRoutinesPreloadApi(ipc as never)
    const onResult = vi.fn()
    const off = routines.onResult(onResult)
    handlers.get(ROUTINE_IPC.result)!({}, { routineId: ID, outcome: 'succeeded', at: 1, extra: true })
    handlers.get(ROUTINE_IPC.result)!({}, { routineId: ID, outcome: 'succeeded', at: 1 })
    expect(onResult).toHaveBeenCalledTimes(1)
    off()
    expect(handlers.has(ROUTINE_IPC.result)).toBe(false)
  })
})
