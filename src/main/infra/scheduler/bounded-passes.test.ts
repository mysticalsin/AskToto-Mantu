import { describe, expect, it, vi } from 'vitest'
import { runBoundedPasses, type PassTimers } from './bounded-passes'

/** A manual clock: timers fire only when the test advances it. */
function fakeClock(): PassTimers & { advance(ms: number): void; pending(): number } {
  let now = 0
  let next = 1
  const timers = new Map<number, { at: number; run: () => void }>()
  return {
    setTimeout(run, ms) {
      const id = next++
      timers.set(id, { at: now + ms, run })
      return id
    },
    clearTimeout(handle) {
      timers.delete(handle as number)
    },
    advance(ms) {
      const target = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        due[1].run()
      }
      now = target
    },
    pending: () => timers.size
  }
}

describe('runBoundedPasses', () => {
  it('runs offset 0 synchronously and the rest at their offsets, then leaves no timer behind', () => {
    const clock = fakeClock()
    const seen: number[] = []
    runBoundedPasses([0, 250, 1000, 2500], (index) => seen.push(index), clock)
    expect(seen).toEqual([0])
    clock.advance(250)
    expect(seen).toEqual([0, 1])
    clock.advance(750)
    expect(seen).toEqual([0, 1, 2])
    clock.advance(1500)
    expect(seen).toEqual([0, 1, 2, 3])
    expect(clock.pending()).toBe(0)
    clock.advance(60_000)
    expect(seen).toEqual([0, 1, 2, 3])
  })

  it('does not run pass 1 before 250 ms', () => {
    const clock = fakeClock()
    const pass = vi.fn()
    runBoundedPasses([0, 250], pass, clock)
    clock.advance(249)
    expect(pass).toHaveBeenCalledTimes(1)
    clock.advance(1)
    expect(pass).toHaveBeenCalledTimes(2)
  })

  it('cancel stops every pass that has not run yet', () => {
    const clock = fakeClock()
    const pass = vi.fn()
    const cancel = runBoundedPasses([0, 250, 1000], pass, clock)
    clock.advance(250)
    cancel()
    clock.advance(10_000)
    expect(pass).toHaveBeenCalledTimes(2)
    expect(clock.pending()).toBe(0)
  })

  it('a throwing pass is reported and does not stop the later passes', () => {
    const clock = fakeClock()
    const onError = vi.fn()
    const pass = vi.fn((index: number) => {
      if (index === 0) throw new Error('synthetic pass failure')
    })
    runBoundedPasses([0, 250], pass, clock, onError)
    clock.advance(250)
    expect(pass).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('arms every timer once up front: no pass re-arms another (bounded, not a poll)', () => {
    const clock = fakeClock()
    runBoundedPasses([0, 250, 1000, 2500], () => undefined, clock)
    expect(clock.pending()).toBe(3)
  })
})
