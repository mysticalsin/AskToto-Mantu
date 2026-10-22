import { describe, expect, it } from 'vitest'
import { ContractError } from './contract-data'
import { SessionContext, type SessionScope } from './session-context'
import { SessionQueue } from './session-queue'

const SCOPE: SessionScope = {
  tenantId: 'synthetic-tenant-a',
  userId: 'synthetic-user-a',
  sessionId: 'synthetic-meeting-1'
}
const context = (): SessionContext =>
  new SessionContext({ scope: SCOPE, permissions: [], mode: 'meeting', objective: 'Synthetic contract exercise' })
const screen = (): { scope: SessionScope; sourceId: string; observedAtMs: number } => ({
  scope: SCOPE,
  sourceId: 'synthetic-screen-1',
  observedAtMs: 1_000
})
const deferred = <T = unknown>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const rejectsWith = async (promise: Promise<unknown>, code: string): Promise<void> => {
  await expect(promise).rejects.toSatisfy((error: unknown) => error instanceof ContractError && error.code === code)
}

describe('SessionQueue', () => {
  it('serializes current tasks and bounds pending work', async () => {
    const ctx = context()
    const queue = new SessionQueue(ctx, { maxPending: 1 })
    const gate = deferred()
    const order: string[] = []
    const first = queue.submit('conversation', async () => {
      order.push('first-start')
      await gate.promise
      order.push('first-end')
      return 1
    })
    const second = queue.submit('screen', () => {
      order.push('second-start')
      return 2
    })
    await rejectsWith(
      queue.submit('manual', () => 3),
      'QUEUE_FULL'
    )
    expect(order).toEqual(['first-start'])
    gate.resolve(undefined)
    expect((await first).value).toBe(1)
    expect((await second).value).toBe(2)
    expect(order).toEqual(['first-start', 'first-end', 'second-start'])
    queue.dispose()
  })

  it('defaults to at most two pending tasks behind one active task', async () => {
    const queue = new SessionQueue(context())
    const gate = deferred()
    const active = queue.submit('conversation', () => gate.promise)
    const pendingA = queue.submit('screen', () => 'a')
    const pendingB = queue.submit('manual', () => 'b')
    await rejectsWith(
      queue.submit('followup', () => 'c'),
      'QUEUE_FULL'
    )
    gate.resolve('done')
    expect((await active).value).toBe('done')
    expect((await pendingA).value).toBe('a')
    expect((await pendingB).value).toBe('b')
    queue.dispose()
  })

  it('hands the work the issued snapshot and a live abort signal', async () => {
    const ctx = context()
    const queue = new SessionQueue(ctx)
    const result = await queue.submit('manual', (snapshot, signal) => {
      expect(signal.aborted).toBe(false)
      return snapshot.outputKind
    })
    expect(result.value).toBe('manual')
    expect(ctx.isCurrent(result.snapshot)).toBe(true)
    queue.dispose()
  })

  it('discards a late async answer after the screen context changes', async () => {
    const ctx = context()
    const queue = new SessionQueue(ctx)
    const gate = deferred<string>()
    let signal: AbortSignal | undefined
    const task = queue.submit('conversation', (_snapshot, abort) => {
      signal = abort
      return gate.promise
    })
    const rejected = rejectsWith(task, 'TASK_INVALIDATED')
    await flush()
    ctx.setScreen(screen())
    await rejected
    expect(signal?.aborted).toBe(true)
    gate.resolve('Synthetic stale answer')
    await flush()
    expect((await queue.submit('conversation', () => 'Synthetic current answer')).value).toBe(
      'Synthetic current answer'
    )
    queue.dispose()
  })

  it('rejects active and pending work across stop and resume but allows a fresh result', async () => {
    const ctx = context()
    const queue = new SessionQueue(ctx)
    const gate = deferred<string>()
    const old = queue.submit('conversation', () => gate.promise)
    const pending = queue.submit('followup', () => 'must never publish')
    const rejectedOld = rejectsWith(old, 'TASK_INVALIDATED')
    const rejectedPending = rejectsWith(pending, 'TASK_INVALIDATED')
    await flush()
    ctx.stop()
    ctx.resume()
    await Promise.all([rejectedOld, rejectedPending])
    const current = await queue.submit('manual', (snapshot) => snapshot.generation)
    expect(current.value).toBe(3)
    gate.resolve('retired generation')
    await flush()
    queue.dispose()
  })

  it('refuses new work while the session is stopped', async () => {
    const ctx = context()
    const queue = new SessionQueue(ctx)
    ctx.stop()
    await rejectsWith(
      queue.submit('manual', () => 1),
      'SESSION_STOPPED'
    )
    queue.dispose()
  })

  it('times out ignoring-abort work and disposal rejects active and pending work', async () => {
    const queue = new SessionQueue(context(), { timeoutMs: 15 })
    const ignored = deferred<string>()
    await rejectsWith(
      queue.submit('screen', () => ignored.promise),
      'TASK_TIMEOUT'
    )
    const active = queue.submit('manual', () => ignored.promise)
    const pending = queue.submit('followup', () => 'should be disposed')
    const noActive = rejectsWith(active, 'QUEUE_CLOSED')
    const noPending = rejectsWith(pending, 'QUEUE_CLOSED')
    queue.dispose()
    await Promise.all([noActive, noPending])
    await rejectsWith(
      queue.submit('manual', () => 1),
      'QUEUE_CLOSED'
    )
    ignored.resolve('too late')
    queue.dispose()
  })

  it('rejects a thrown task error and keeps serving later tasks', async () => {
    const queue = new SessionQueue(context())
    await expect(
      queue.submit('manual', () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect((await queue.submit('manual', () => 'next')).value).toBe('next')
    queue.dispose()
  })

  it('stops reacting to context changes after disposal', async () => {
    const ctx = context()
    const queue = new SessionQueue(ctx)
    queue.dispose()
    expect(() => ctx.setScreen(screen())).not.toThrow()
  })

  it('validates limits and the task function', async () => {
    const make = (options: { maxPending?: number; timeoutMs?: number }) => () => new SessionQueue(context(), options)
    expect(make({ maxPending: -1 })).toThrow(ContractError)
    expect(make({ maxPending: 33 })).toThrow(ContractError)
    expect(make({ maxPending: 1.5 })).toThrow(ContractError)
    expect(make({ timeoutMs: 0 })).toThrow(ContractError)
    expect(make({ timeoutMs: 60_001 })).toThrow(ContractError)
    const queue = new SessionQueue(context())
    await rejectsWith(queue.submit('manual', 'nope' as never), 'TASK_FUNCTION')
    queue.dispose()
  })
})

describe('SessionQueue: tolerated changes and per-job deadlines (G14)', () => {
  const line = (revision: number) => ({
    scope: SCOPE,
    revision,
    segments: [{ text: `synthetic line ${revision}` }],
    interim: []
  })

  it('by default any change, including a transcript line, aborts the active job', async () => {
    const ctx = context()
    const queue = new SessionQueue(ctx)
    const gate = deferred<string>()
    const task = queue.submit('conversation', () => gate.promise)
    const rejected = rejectsWith(task, 'TASK_INVALIDATED')
    await flush()
    ctx.updateTranscript(line(1))
    await rejected
    queue.dispose()
  })

  it('a tolerated transcript change lets active and pending work finish and publish', async () => {
    const ctx = context()
    const queue = new SessionQueue(ctx, { tolerate: ['transcript'] })
    const gate = deferred<string>()
    const active = queue.submit('conversation', () => gate.promise)
    const pending = queue.submit('manual', () => 'pending answer')
    await flush()
    ctx.updateTranscript(line(1))
    ctx.updateTranscript(line(2))
    gate.resolve('active answer')
    expect((await active).value).toBe('active answer')
    expect((await pending).value).toBe('pending answer')
    queue.dispose()
  })

  it('tolerating the transcript still invalidates on stop, permissions and screen changes', async () => {
    for (const change of [
      (ctx: SessionContext) => ctx.setPermissions(['screen.read']),
      (ctx: SessionContext) => ctx.setScreen(screen()),
      (ctx: SessionContext) => ctx.stop()
    ]) {
      const ctx = context()
      const queue = new SessionQueue(ctx, { tolerate: ['transcript'] })
      const gate = deferred<string>()
      const active = queue.submit('conversation', () => gate.promise)
      const pending = queue.submit('manual', () => 'must never publish')
      const rejectedActive = rejectsWith(active, 'TASK_INVALIDATED')
      const rejectedPending = rejectsWith(pending, 'TASK_INVALIDATED')
      await flush()
      change(ctx)
      await Promise.all([rejectedActive, rejectedPending])
      queue.dispose()
    }
  })

  it('a job may carry its own deadline, bounded', async () => {
    const queue = new SessionQueue(context(), { timeoutMs: 60_000 })
    const never = deferred<string>()
    await rejectsWith(
      queue.submit('manual', () => never.promise, { timeoutMs: 15 }),
      'TASK_TIMEOUT'
    )
    await rejectsWith(
      queue.submit('manual', () => 'x', { timeoutMs: 0 }),
      'QUEUE_TIMEOUT'
    )
    await rejectsWith(
      queue.submit('manual', () => 'x', { timeoutMs: 300_001 }),
      'QUEUE_TIMEOUT'
    )
    expect((await queue.submit('manual', () => 'ok', { timeoutMs: 300_000 })).value).toBe('ok')
    queue.dispose()
  })
})
