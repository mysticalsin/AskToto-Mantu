import { describe, expect, it } from 'vitest'
import { mapWithConcurrency } from './concurrency'

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('mapWithConcurrency', () => {
  it('never runs more than the limit at once and keeps result order', async () => {
    let active = 0
    let peak = 0
    const items = Array.from({ length: 50 }, (_, i) => i)
    const out = await mapWithConcurrency(items, 16, async (n) => {
      active += 1
      peak = Math.max(peak, active)
      await tick()
      active -= 1
      return n * 2
    })
    expect(peak).toBe(16)
    expect(out).toEqual(items.map((n) => n * 2))
  })

  it('handles an empty list and a limit larger than the list', async () => {
    expect(await mapWithConcurrency([], 16, async (n: number) => n)).toEqual([])
    expect(await mapWithConcurrency([1, 2], 16, async (n) => n + 1)).toEqual([2, 3])
  })

  it('rejects with the first failure and starts nothing new afterwards', async () => {
    const started: number[] = []
    await expect(
      mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
        started.push(n)
        await tick()
        if (n === 2) throw new Error('boom')
        return n
      })
    ).rejects.toThrow('boom')
    expect(started.length).toBeLessThan(6)
  })

  it('stops taking new items once stop() is true; started items still finish, skipped slots are undefined', async () => {
    let done = 0
    const out = await mapWithConcurrency(
      Array.from({ length: 40 }, (_, i) => i),
      4,
      async (n) => {
        await tick()
        done += 1
        return n
      },
      () => done >= 8
    )
    expect(done).toBeGreaterThanOrEqual(8)
    expect(done).toBeLessThan(40)
    expect(out).toHaveLength(40)
    expect(out.slice(0, 8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(out[39]).toBeUndefined()
  })
})
