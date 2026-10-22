import { describe, expect, it, vi } from 'vitest'
import { QUIT_DRAIN_CAP_MS, drainWithCap, runQuitFlush } from './quit-flush'

describe('runQuitFlush', () => {
  it('flushes the live meeting, then acknowledges once', async () => {
    const order: string[] = []
    await runQuitFlush(
      async () => {
        order.push('flush')
      },
      () => order.push('ack')
    )
    expect(order).toEqual(['flush', 'ack'])
  })

  it('still acknowledges when the flush fails, so main never waits for the ceiling', async () => {
    const ack = vi.fn()
    await runQuitFlush(() => Promise.reject(new Error('save failed')), ack)
    expect(ack).toHaveBeenCalledTimes(1)
  })

  it('still acknowledges when the flush throws synchronously', async () => {
    const ack = vi.fn()
    await runQuitFlush(() => {
      throw new Error('boom')
    }, ack)
    expect(ack).toHaveBeenCalledTimes(1)
  })
})

describe('drainWithCap', () => {
  it('resolves when the drain callback fires, and clears the cap timer', async () => {
    vi.useFakeTimers()
    try {
      let settle = (): void => undefined
      const done = drainWithCap((onDrained) => (settle = onDrained), QUIT_DRAIN_CAP_MS)
      settle()
      await done
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves at the cap when the drain never settles', async () => {
    vi.useFakeTimers()
    try {
      let resolved = false
      void drainWithCap(() => undefined, QUIT_DRAIN_CAP_MS).then(() => (resolved = true))
      await vi.advanceTimersByTimeAsync(QUIT_DRAIN_CAP_MS - 1)
      expect(resolved).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(resolved).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves headroom under the main-process 12 s quit ceiling', () => {
    expect(QUIT_DRAIN_CAP_MS).toBeLessThanOrEqual(8_000)
  })
})
