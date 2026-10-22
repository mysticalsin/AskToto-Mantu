import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFrontmostVerifier } from './desktop-frontmost-verifier'
import type { ForegroundInfo, ForegroundWatcher } from './foreground-watcher'

function harness() {
  let emit: (info: ForegroundInfo) => void = () => undefined
  const stop = vi.fn()
  const start = vi.fn((onChange: (info: ForegroundInfo) => void): ForegroundWatcher => {
    emit = onChange
    return { stop, current: () => null, healthy: () => true }
  })
  const send = (windowId: string) => emit({ windowId, pid: 1, title: '' })
  return { start, stop, send, verifier: createFrontmostVerifier({ start }) }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('frontmost verifier: verified only on a later activation of the expected bundle within the window', () => {
  it('matches a later activation of the expected bundle id', async () => {
    const h = harness()
    const observation = h.verifier.observe('com.apple.Notes', 3_000)
    h.send('com.example.other') // baseline
    expect(await observation.ready()).toBe(true)
    const matched = observation.matched()
    h.send('com.apple.Notes')
    expect(await matched).toBe(true)
    observation.cancel()
    expect(h.stop).toHaveBeenCalled()
  })

  it('does not count the baseline: an app already in front proves nothing', async () => {
    const h = harness()
    const observation = h.verifier.observe('com.apple.Notes', 3_000)
    h.send('com.apple.Notes') // the stream's first line is the state before the launch
    expect(await observation.ready()).toBe(true)
    const matched = observation.matched()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(await matched).toBe(false)
    observation.cancel()
  })

  it('does not count another app, or an activation after the window', async () => {
    const h = harness()
    const observation = h.verifier.observe('com.apple.Notes', 3_000)
    h.send('com.example.a')
    await observation.ready()
    const matched = observation.matched()
    h.send('com.example.b')
    await vi.advanceTimersByTimeAsync(3_000)
    h.send('com.apple.Notes')
    expect(await matched).toBe(false)
    observation.cancel()
  })

  it('is not ready, and proves nothing, when the stream never reports a baseline', async () => {
    const h = harness()
    const observation = h.verifier.observe('com.apple.Notes', 3_000)
    const ready = observation.ready()
    await vi.advanceTimersByTimeAsync(1_500)
    expect(await ready).toBe(false)
    expect(await observation.matched()).toBe(false)
    h.send('com.apple.Notes')
    expect(await observation.matched()).toBe(false)
    observation.cancel()
  })

  it('a stream that cannot start is not an observation, and cancel is idempotent', async () => {
    const throwing = createFrontmostVerifier({
      start: () => {
        throw new Error('no helper')
      }
    })
    const observation = throwing.observe('com.apple.Notes', 3_000)
    expect(await observation.ready()).toBe(false)
    expect(await observation.matched()).toBe(false)
    observation.cancel()
    observation.cancel()
  })
})
