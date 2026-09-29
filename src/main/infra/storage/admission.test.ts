import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../../logger', () => ({ mainLog: { info: vi.fn(), warn: vi.fn() }, auditLog: vi.fn() }))

import { mainLog } from '../../logger'
import { createAdmission, MAX_QUEUED, type AcquireResult } from './admission'

afterEach(() => {
  // restoreAllMocks() only reverts vi.spyOn() targets (performance.now below) — the plain vi.fn()s from
  // the vi.mock() factory have no "original" to restore to, so their call history survives into the next
  // test unless cleared explicitly here too.
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

/** admission.ts has no timers of its own: acquire()/run() settle on plain microtasks. Races `pending`
 *  against an already-resolved sentinel so a genuinely pending promise reports 'pending' without ever
 *  hanging the test. */
async function peek<T>(pending: Promise<T>): Promise<T | 'pending'> {
  const sentinel = Symbol('peek-pending')
  const result = await Promise.race([pending, Promise.resolve(sentinel as unknown as T)])
  return result === (sentinel as unknown as T) ? 'pending' : result
}

function signal(): AbortSignal {
  return new AbortController().signal
}

describe('createAdmission', () => {
  it('grants capacity permits at once, then makes further requests wait', async () => {
    const admission = createAdmission(2)

    const a = admission.acquire('content', signal())
    const b = admission.acquire('content', signal())
    await expect(a).resolves.toBe('admitted')
    await expect(b).resolves.toBe('admitted')

    const c = admission.acquire('content', signal())
    expect(await peek(c)).toBe('pending')
  })

  it("hands a returned permit to the oldest metadata waiter before any content waiter", async () => {
    const admission = createAdmission(1)
    await expect(admission.acquire('content', signal())).resolves.toBe('admitted') // holds the only permit

    const c1 = admission.acquire('content', signal())
    const m1 = admission.acquire('metadata', signal())
    const c2 = admission.acquire('content', signal())
    const m2 = admission.acquire('metadata', signal())

    admission.release() // returns the held permit
    await expect(m1).resolves.toBe('admitted')
    expect(await peek(c1)).toBe('pending')
    expect(await peek(c2)).toBe('pending')
    expect(await peek(m2)).toBe('pending')

    admission.release() // returns m1's permit
    await expect(m2).resolves.toBe('admitted')
    expect(await peek(c1)).toBe('pending')

    admission.release() // returns m2's permit
    await expect(c1).resolves.toBe('admitted')

    admission.release() // returns c1's permit
    await expect(c2).resolves.toBe('admitted')
  })

  it("a waiter whose signal aborts leaves at once with 'ended' and never takes the permit", async () => {
    const admission = createAdmission(1)
    await expect(admission.acquire('content', signal())).resolves.toBe('admitted') // holds the only permit

    const abortable = new AbortController()
    const aborted = admission.acquire('content', abortable.signal)
    const next = admission.acquire('content', signal())

    abortable.abort()
    await expect(aborted).resolves.toBe('ended')
    expect(await peek(next)).toBe('pending') // aborting a waiter frees nothing by itself

    admission.release() // the original holder's permit comes back
    await expect(next).resolves.toBe('admitted')
  })

  it("an already-aborted signal is 'ended' and consumes no permit", async () => {
    const admission = createAdmission(1)
    const abortable = new AbortController()
    abortable.abort()

    await expect(admission.acquire('content', abortable.signal)).resolves.toBe('ended')
    // the permit was never taken: a fresh acquire is admitted immediately
    await expect(admission.acquire('content', signal())).resolves.toBe('admitted')
  })

  it('inUse() counts the permits out, and onFree fires only when a permit goes back to the free count (M2-0433)', async () => {
    const admission = createAdmission(2)
    const freed = vi.fn()
    admission.onFree(freed)
    expect(admission.inUse()).toBe(0)

    await expect(admission.acquire('content', signal())).resolves.toBe('admitted')
    await expect(admission.acquire('content', signal())).resolves.toBe('admitted')
    expect(admission.inUse()).toBe(2)
    const waiter = admission.acquire('metadata', signal())

    admission.release() // handed straight to the waiter: still two out, nothing freed
    await expect(waiter).resolves.toBe('admitted')
    expect(admission.inUse()).toBe(2)
    expect(freed).not.toHaveBeenCalled()

    let finish: () => void = () => {}
    const running = admission.run(() => new Promise<void>((resolve) => (finish = resolve)))
    expect(admission.inUse()).toBe(2)
    finish()
    await running
    expect(admission.inUse()).toBe(1)
    expect(freed).toHaveBeenCalledTimes(1)

    admission.release()
    expect(admission.inUse()).toBe(0)
    expect(freed).toHaveBeenCalledTimes(2)
  })

  it('run() keeps the permit until the call settles, whether it resolves or rejects', async () => {
    const admission = createAdmission(1)
    await expect(admission.acquire('content', signal())).resolves.toBe('admitted')

    let resolveCall: (value: string) => void = () => {}
    const running = admission.run(() => new Promise<string>((resolve) => (resolveCall = resolve)))

    const secondHolder = admission.acquire('content', signal())
    expect(await peek(secondHolder)).toBe('pending')

    resolveCall('done')
    await expect(running).resolves.toBe('done')
    await expect(secondHolder).resolves.toBe('admitted') // the permit returned once the call resolved

    let rejectCall: (error: Error) => void = () => {}
    const runningError = admission.run(() => new Promise<string>((_resolve, reject) => (rejectCall = reject)))

    const thirdHolder = admission.acquire('content', signal())
    expect(await peek(thirdHolder)).toBe('pending')

    const failure = new Error('boom')
    rejectCall(failure)
    await expect(runningError).rejects.toBe(failure)
    await expect(thirdHolder).resolves.toBe('admitted') // a rejection still returns the permit
  })

  it('refuses at once while every permit is held by a call running 2 s or more, and logs the episode once, content-free', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const admission = createAdmission(2)

    await expect(admission.acquire('content', signal())).resolves.toBe('admitted')
    await expect(admission.acquire('content', signal())).resolves.toBe('admitted')

    let resolveA: (value: string) => void = () => {}
    let resolveB: (value: string) => void = () => {}
    const runningA = admission.run(() => new Promise<string>((resolve) => (resolveA = resolve)))
    const runningB = admission.run(() => new Promise<string>((resolve) => (resolveB = resolve)))

    now = 1_999
    const queuedAt1999 = admission.acquire('content', signal())
    expect(await peek(queuedAt1999)).toBe('pending') // under 2s: still just a normal wait
    expect(mainLog.warn).not.toHaveBeenCalled()

    now = 2_000
    const refused1 = admission.acquire('content', signal())
    const refused2 = admission.acquire('metadata', signal())
    await expect(refused1).resolves.toBe('refused')
    await expect(refused2).resolves.toBe('refused')
    expect(mainLog.warn).toHaveBeenCalledTimes(1)
    expect(mainLog.warn).toHaveBeenCalledWith(expect.any(String), { capacity: 2 })

    resolveA('done')
    await runningA
    expect(mainLog.info).toHaveBeenCalledTimes(1)
    expect(mainLog.info).toHaveBeenCalledWith(expect.any(String), { degradedMs: expect.any(Number) })
    await expect(queuedAt1999).resolves.toBe('admitted') // the waiter queued before the episode goes first

    resolveB('done')
    await runningB
    expect(mainLog.info).toHaveBeenCalledTimes(1) // the episode was already closed; settling B logs nothing more
  })

  it('refuses at once when MAX_QUEUED requests already wait', async () => {
    const admission = createAdmission(1)
    await expect(admission.acquire('content', signal())).resolves.toBe('admitted')

    const queued: Array<Promise<AcquireResult>> = []
    for (let i = 0; i < MAX_QUEUED; i++) queued.push(admission.acquire('content', signal()))
    expect(await peek(queued[0])).toBe('pending')
    expect(await peek(queued[queued.length - 1])).toBe('pending')

    await expect(admission.acquire('content', signal())).resolves.toBe('refused')
  })
})
