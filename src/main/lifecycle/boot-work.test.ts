import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({ mainLog: { info: vi.fn(), warn: vi.fn() }, auditLog: vi.fn() }))
vi.mock('../mac-helper', () => ({ macStatFlagsSpawnSpec: vi.fn(() => null) }))

import { mainLog } from '../logger'
import { createAdmission } from '../infra/storage/admission'
import { createBootWork, type BootWorkWindow } from './boot-work'

function fakeWindow(opts: { visible?: boolean; destroyed?: boolean } = {}): EventEmitter & BootWorkWindow & { show(): void } {
  const win = new EventEmitter() as EventEmitter & BootWorkWindow & { show(): void }
  let visible = opts.visible ?? false
  win.isDestroyed = () => opts.destroyed ?? false
  win.isVisible = () => visible
  win.show = () => {
    visible = true
    win.emit('show')
  }
  return win
}

const nextTask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const settle = async (tasks = 20): Promise<void> => {
  for (let i = 0; i < tasks; i++) await nextTask()
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

describe('createBootWork (M2-0031)', () => {
  it('starts no job before the boot window first shows, and none in the show task itself', async () => {
    const work = createBootWork({ limit: 2, fallbackMs: 60_000 })
    const win = fakeWindow()
    const job = vi.fn()
    work.run('ensureMeetingsFolder', job)
    work.releaseAfterFirstShow(win)
    await settle()
    expect(job).not.toHaveBeenCalled()

    win.show()
    expect(job).not.toHaveBeenCalled()
    await nextTask()
    expect(job).toHaveBeenCalledTimes(1)
  })

  it('never has more than `limit` jobs in flight, and starts the next as soon as one settles', async () => {
    const work = createBootWork({ limit: 2, holdMs: 60_000 })
    const gates = [deferred(), deferred(), deferred(), deferred()]
    const started: number[] = []
    let inFlight = 0
    let maxInFlight = 0
    gates.forEach((gate, i) =>
      work.run(`job${i}`, async () => {
        started.push(i)
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await gate.promise
        inFlight--
      })
    )
    work.releaseAfterFirstShow(fakeWindow({ visible: true }))
    await settle()
    expect(started).toEqual([0, 1])

    gates[1].resolve()
    await settle()
    expect(started).toEqual([0, 1, 2])

    gates[0].resolve()
    gates[2].resolve()
    gates[3].resolve()
    await settle()
    expect(started).toEqual([0, 1, 2, 3])
    expect(maxInFlight).toBe(2)
  })

  it('caps at the storage gateway pool capacity (poolSize - 2) by default', async () => {
    const saved = process.env.UV_THREADPOOL_SIZE
    process.env.UV_THREADPOOL_SIZE = '6'
    try {
      const work = createBootWork({ holdMs: 60_000 })
      const started: number[] = []
      const never = new Promise<void>(() => {})
      for (let i = 0; i < 8; i++) work.run(`job${i}`, () => (started.push(i), never))
      work.releaseAfterFirstShow(null)
      await settle()
      expect(started).toEqual([0, 1, 2, 3])
    } finally {
      if (saved === undefined) delete process.env.UV_THREADPOOL_SIZE
      else process.env.UV_THREADPOOL_SIZE = saved
    }
  })

  it('counts the storage gateway permits against the cap: no job starts while pinned reads hold it, and the next starts once a permit returns (M2-0433)', async () => {
    const pool = createAdmission(2)
    const work = createBootWork({ limit: 2, holdMs: 60_000, pool })
    // A FIFO-pinned read holds one permit for the whole run.
    await expect(pool.acquire('content', new AbortController().signal)).resolves.toBe('admitted')
    void pool.run(() => new Promise<void>(() => {}))
    await expect(pool.acquire('content', new AbortController().signal)).resolves.toBe('admitted')
    let finishRead: () => void = () => {}
    const read = pool.run(() => new Promise<void>((resolve) => (finishRead = resolve)))

    const started: number[] = []
    const never = new Promise<void>(() => {})
    for (let i = 0; i < 3; i++) work.run(`job${i}`, () => (started.push(i), never))
    work.releaseAfterFirstShow(null)
    await settle()
    expect(started).toEqual([])

    finishRead()
    await read
    await settle()
    expect(started).toEqual([0]) // one pinned permit + one job: the cap, never more
  })

  it('does not start a job the gateway took the room for between the pump and its task (M2-0433)', async () => {
    const pool = createAdmission(1)
    const work = createBootWork({ limit: 1, holdMs: 60_000, pool })
    const job = vi.fn()
    work.run('recoverImports', job)
    work.releaseAfterFirstShow(null) // schedules the start for the next task
    await expect(pool.acquire('content', new AbortController().signal)).resolves.toBe('admitted')
    await settle()
    expect(job).not.toHaveBeenCalled()

    pool.release()
    await settle()
    expect(job).toHaveBeenCalledTimes(1)
  })

  it('starts each job in a task of its own', async () => {
    const work = createBootWork({ limit: 4 })
    const order: string[] = []
    work.run('a', () => order.push('a'))
    work.run('b', () => order.push('b'))
    work.releaseAfterFirstShow(fakeWindow({ visible: true }))
    await nextTask()
    expect(order).toEqual(['a'])
    await nextTask()
    expect(order).toEqual(['a', 'b'])
  })

  it('a job that holds its slot past holdMs no longer blocks the queue', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const work = createBootWork({ limit: 1, holdMs: 1_000 })
      const second = vi.fn()
      work.run('catchUpIntelligenceIndexIfNeeded', () => new Promise<void>(() => {}))
      work.run('runConsolidationIfDue', second)
      work.releaseAfterFirstShow(null)
      await settle()
      expect(second).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1_000)
      await settle()
      expect(second).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens after the fallback when the window never reports a show', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const work = createBootWork({ fallbackMs: 5_000 })
      const job = vi.fn()
      work.run('recoverImports', job)
      work.releaseAfterFirstShow(fakeWindow())
      await settle()
      expect(job).not.toHaveBeenCalled()
      vi.advanceTimersByTime(5_000)
      await settle()
      expect(job).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens at once for a destroyed window, and logs a failing job without stopping the queue', async () => {
    const work = createBootWork({ limit: 1 })
    const after = vi.fn()
    work.run('throws', () => {
      throw new Error('sync boom')
    })
    work.run('rejects', () => Promise.reject(new Error('async boom')))
    work.run('after', after)
    work.releaseAfterFirstShow(fakeWindow({ destroyed: true }))
    await settle()
    expect(after).toHaveBeenCalledTimes(1)
    expect(vi.mocked(mainLog.warn)).toHaveBeenCalledWith('[boot] throws failed:', expect.any(Error))
    expect(vi.mocked(mainLog.warn)).toHaveBeenCalledWith('[boot] rejects failed:', expect.any(Error))
  })
})
