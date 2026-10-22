import { describe, expect, it, vi } from 'vitest'
import { runQuitFlush } from './quit-flush'

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
