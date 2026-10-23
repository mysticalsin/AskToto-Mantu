import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskScheduler, type SchedulerLimits } from './task-scheduler'

interface Gate<T = void> {
  promise: Promise<T>
  open: (value: T) => void
}
function gate<T = void>(): Gate<T> {
  let open: (value: T) => void = () => {}
  const promise = new Promise<T>((resolve) => {
    open = resolve
  })
  return { promise, open }
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

const LIMITS: SchedulerLimits = {
  maxEffectPerOwner: 1,
  maxReadOnlyPerOwner: 3,
  maxQueuedPerOwner: 4,
  maxQueueWaitMs: 5_000
}

function job(
  key: string,
  owner: string,
  resources: string[],
  events: string[],
  hold: Gate,
  effect: 'effect' | 'read-only' = 'effect'
) {
  return {
    key,
    owner,
    effect,
    resources,
    run: async (signal: AbortSignal) => {
      events.push(`start:${key}`)
      await hold.promise
      events.push(`end:${key}${signal.aborted ? ':aborted' : ''}`)
      return key
    }
  }
}

describe('TaskScheduler (G32)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs at most one desktop-effect job per owner and keeps arrival order', async () => {
    const scheduler = new TaskScheduler(LIMITS)
    const events: string[] = []
    const a = gate()
    const b = gate()
    const first = scheduler.submit(job('a', 'o1', ['file:a'], events, a))
    const second = scheduler.submit(job('b', 'o1', ['file:b'], events, b))
    await flush()
    expect(events).toEqual(['start:a'])
    expect(scheduler.snapshot()).toMatchObject({ running: 1, queued: 1 })

    a.open()
    await flush()
    expect(events).toEqual(['start:a', 'end:a', 'start:b'])
    b.open()
    await expect(first).resolves.toEqual({ status: 'ran', value: 'a' })
    await expect(second).resolves.toEqual({ status: 'ran', value: 'b' })
  })

  it('lets two owners work on independent resources at the same time', async () => {
    const scheduler = new TaskScheduler(LIMITS)
    const events: string[] = []
    const a = gate()
    const b = gate()
    void scheduler.submit(job('a', 'o1', ['file:a'], events, a))
    void scheduler.submit(job('b', 'o2', ['file:b'], events, b))
    await flush()
    expect(events).toEqual(['start:a', 'start:b'])
    a.open()
    b.open()
  })

  it('never lets two jobs hold the same named resource, even for different owners', async () => {
    const scheduler = new TaskScheduler(LIMITS)
    const events: string[] = []
    const a = gate()
    const b = gate()
    void scheduler.submit(job('a', 'o1', ['app:notes', 'clipboard'], events, a))
    void scheduler.submit(job('b', 'o2', ['clipboard'], events, b))
    await flush()
    expect(events).toEqual(['start:a'])
    a.open()
    await flush()
    expect(events).toEqual(['start:a', 'end:a', 'start:b'])
    b.open()
  })

  it('does not let a later job overtake an earlier one that waits for the same resource', async () => {
    const scheduler = new TaskScheduler({ ...LIMITS, maxEffectPerOwner: 2 })
    const events: string[] = []
    const a = gate()
    const b = gate()
    const c = gate()
    void scheduler.submit(job('a', 'o1', ['doc:1'], events, a))
    void scheduler.submit(job('b', 'o2', ['doc:1', 'doc:2'], events, b))
    // c only needs doc:2: it must wait behind b, which is waiting for doc:1.
    void scheduler.submit(job('c', 'o3', ['doc:2'], events, c))
    await flush()
    expect(events).toEqual(['start:a'])
    a.open()
    await flush()
    expect(events).toEqual(['start:a', 'end:a', 'start:b'])
    b.open()
    await flush()
    expect(events.at(-1)).toBe('start:c')
    c.open()
  })

  it('runs a later independent job while an earlier one waits for another owner’s resource', async () => {
    const scheduler = new TaskScheduler(LIMITS)
    const events: string[] = []
    const a = gate()
    const b = gate()
    const c = gate()
    void scheduler.submit(job('a', 'o1', ['doc:1'], events, a))
    void scheduler.submit(job('b', 'o2', ['doc:1'], events, b))
    void scheduler.submit(job('c', 'o3', ['doc:9'], events, c))
    await flush()
    expect(events).toEqual(['start:a', 'start:c'])
    a.open()
    b.open()
    c.open()
  })

  it('runs up to N read-only jobs per owner beside the single effect job, on shared resources', async () => {
    const scheduler = new TaskScheduler({ ...LIMITS, maxReadOnlyPerOwner: 2 })
    const events: string[] = []
    const gates = [gate(), gate(), gate(), gate()]
    void scheduler.submit(job('r1', 'o1', ['doc:1'], events, gates[0]!, 'read-only'))
    void scheduler.submit(job('r2', 'o1', ['doc:1'], events, gates[1]!, 'read-only'))
    void scheduler.submit(job('r3', 'o1', ['doc:1'], events, gates[2]!, 'read-only'))
    await flush()
    expect(events).toEqual(['start:r1', 'start:r2'])
    // An effect on a resource others are reading waits until the readers finish.
    void scheduler.submit(job('w', 'o1', ['doc:1'], events, gates[3]!))
    gates[0]!.open()
    await flush()
    expect(events).toContain('start:r3')
    expect(events).not.toContain('start:w')
    gates[1]!.open()
    gates[2]!.open()
    await flush()
    expect(events).toContain('start:w')
    gates[3]!.open()
  })

  it('holds the lock until a stopped running job has really finished', async () => {
    const scheduler = new TaskScheduler(LIMITS)
    const events: string[] = []
    const a = gate()
    const b = gate()
    const first = scheduler.submit(job('a', 'o1', ['doc:1'], events, a))
    await flush()
    const stopped = scheduler.stop('o1')
    expect(stopped).toEqual({ queued: 0, running: 1 })
    const second = scheduler.submit(job('b', 'o1', ['doc:1'], events, b))
    await flush()
    // The stopped job is still working: nothing else may touch its resource yet.
    expect(events).toEqual(['start:a'])
    a.open()
    await flush()
    expect(events).toEqual(['start:a', 'end:a:aborted', 'start:b'])
    b.open()
    await expect(first).resolves.toEqual({ status: 'ran', value: 'a' })
    await expect(second).resolves.toEqual({ status: 'ran', value: 'b' })
  })

  it('stop invalidates every queued job of that owner without running it and leaves other owners alone', async () => {
    const scheduler = new TaskScheduler(LIMITS)
    const events: string[] = []
    const a = gate()
    const other = gate()
    void scheduler.submit(job('a', 'o1', ['x'], events, a))
    const queued1 = scheduler.submit(job('q1', 'o1', ['y'], events, gate()))
    const queued2 = scheduler.submit(job('q2', 'o1', ['z'], events, gate()))
    const foreign = scheduler.submit(job('f', 'o2', ['w'], events, other))
    await flush()
    expect(scheduler.stop('o1')).toEqual({ queued: 2, running: 1 })
    await expect(queued1).resolves.toEqual({ status: 'rejected', reason: 'stopped' })
    await expect(queued2).resolves.toEqual({ status: 'rejected', reason: 'stopped' })
    a.open()
    other.open()
    await expect(foreign).resolves.toEqual({ status: 'ran', value: 'f' })
    expect(events).not.toContain('start:q1')
    expect(events).not.toContain('start:q2')
    // A second stop is a no-op: nothing is left to invalidate twice.
    expect(scheduler.stop('o1')).toEqual({ queued: 0, running: 0 })
  })

  it('stop without an owner invalidates every owner; work submitted after it runs normally', async () => {
    const scheduler = new TaskScheduler(LIMITS)
    const events: string[] = []
    const a = gate()
    void scheduler.submit(job('a', 'o1', ['x'], events, a))
    const queued = scheduler.submit(job('q', 'o2', ['x'], events, gate()))
    await flush()
    expect(scheduler.stop()).toEqual({ queued: 1, running: 1 })
    await expect(queued).resolves.toMatchObject({ status: 'rejected', reason: 'stopped' })
    a.open()
    await flush()
    const later = gate()
    const after = scheduler.submit(job('later', 'o1', ['x'], events, later))
    await flush()
    later.open()
    await expect(after).resolves.toEqual({ status: 'ran', value: 'later' })
  })

  it('expires a job that waited longer than the queue deadline without running it', async () => {
    vi.useFakeTimers()
    const scheduler = new TaskScheduler({ ...LIMITS, maxQueueWaitMs: 1_000 })
    const events: string[] = []
    const a = gate()
    void scheduler.submit(job('a', 'o1', ['x'], events, a))
    const waiting = scheduler.submit(job('b', 'o1', ['y'], events, gate()))
    await vi.advanceTimersByTimeAsync(1_001)
    await expect(waiting).resolves.toEqual({ status: 'rejected', reason: 'queue_timeout' })
    a.open()
    await vi.advanceTimersByTimeAsync(10)
    expect(events).not.toContain('start:b')
    expect(scheduler.snapshot()).toMatchObject({ queued: 0 })
  })

  it('rejects a duplicate key, a full queue and an invalid job without running anything', async () => {
    const scheduler = new TaskScheduler({ ...LIMITS, maxQueuedPerOwner: 1 })
    const events: string[] = []
    void scheduler.submit(job('a', 'o1', ['x'], events, gate()))
    void scheduler.submit(job('b', 'o1', ['x'], events, gate()))
    await flush()
    await expect(scheduler.submit(job('b', 'o1', ['x'], events, gate()))).resolves.toEqual({
      status: 'rejected',
      reason: 'duplicate_job'
    })
    await expect(scheduler.submit(job('c', 'o1', ['x'], events, gate()))).resolves.toEqual({
      status: 'rejected',
      reason: 'queue_full'
    })
    await expect(scheduler.submit({ ...job('d', 'o2', ['x'], events, gate()), resources: [''] })).resolves.toEqual({
      status: 'rejected',
      reason: 'invalid_job'
    })
  })

  it('releases its locks and slot when a job throws, and rethrows to the submitter', async () => {
    const scheduler = new TaskScheduler(LIMITS)
    const failing = scheduler.submit({
      key: 'boom',
      owner: 'o1',
      effect: 'effect',
      resources: ['x'],
      run: async () => {
        throw new Error('adapter exploded')
      }
    })
    await expect(failing).rejects.toThrow('adapter exploded')
    const events: string[] = []
    const next = gate()
    const after = scheduler.submit(job('next', 'o1', ['x'], events, next))
    await flush()
    expect(events).toEqual(['start:next'])
    next.open()
    await expect(after).resolves.toEqual({ status: 'ran', value: 'next' })
    expect(scheduler.snapshot()).toEqual({ running: 0, queued: 0 })
  })

  it('cancel(key) rejects one queued job as stopped and leaves the others', async () => {
    const scheduler = new TaskScheduler(LIMITS)
    const events: string[] = []
    const a = gate()
    const b = gate()
    const c = gate()
    void scheduler.submit(job('a', 'o1', ['x'], events, a))
    const queued = scheduler.submit(job('b', 'o1', ['x'], events, b))
    const other = scheduler.submit(job('c', 'o1', ['y'], events, c))
    await flush()

    expect(scheduler.cancel('b')).toBe(true)
    await expect(queued).resolves.toEqual({ status: 'rejected', reason: 'stopped' })
    expect(scheduler.snapshot()).toEqual({ running: 1, queued: 1 })
    a.open()
    await flush()
    c.open()
    await expect(other).resolves.toEqual({ status: 'ran', value: 'c' })
    expect(events).not.toContain('start:b')
  })

  it('cancel(key) aborts only that running job and reports whether it found the key', async () => {
    const scheduler = new TaskScheduler({ ...LIMITS, maxEffectPerOwner: 2 })
    const events: string[] = []
    const a = gate()
    const b = gate()
    const first = scheduler.submit(job('a', 'o1', ['x'], events, a))
    const second = scheduler.submit(job('b', 'o1', ['y'], events, b))
    await flush()

    expect(scheduler.cancel('a')).toBe(true)
    expect(scheduler.cancel('missing')).toBe(false)
    a.open()
    b.open()
    await expect(first).resolves.toEqual({ status: 'ran', value: 'a' })
    await expect(second).resolves.toEqual({ status: 'ran', value: 'b' })
    expect(events).toContain('end:a:aborted')
    expect(events).toContain('end:b')
  })

  it('rejects limits that are not positive integers', () => {
    expect(() => new TaskScheduler({ ...LIMITS, maxEffectPerOwner: 0 })).toThrow(TypeError)
    expect(() => new TaskScheduler({ ...LIMITS, maxQueueWaitMs: Number.NaN })).toThrow(TypeError)
  })
})
