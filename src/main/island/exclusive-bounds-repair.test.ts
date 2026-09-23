import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  observeExclusiveBounds,
  type ExclusiveBoundsWindow
} from './exclusive-bounds-repair'

type Rect = { x: number; y: number; width: number; height: number }

const fullDisplay: Rect = { x: 0, y: 0, width: 1512, height: 982 }
const nativeInset: Rect = { x: 0, y: 39, width: 1512, height: 943 }

class NativeWindow extends EventEmitter implements ExclusiveBoundsWindow {
  bounds: Rect = { ...fullDisplay }
  setBoundsCount = 0
  destroyed = false
  refusesFullBounds = false
  asyncReclampsRemaining = 0

  getBounds(): Rect { return { ...this.bounds } }
  isDestroyed(): boolean { return this.destroyed }

  setBounds(bounds: Rect): void {
    this.setBoundsCount += 1
    this.bounds = this.refusesFullBounds ? { ...nativeInset } : { ...bounds }
    this.emit('resize')
    this.emit('move')
    if (this.asyncReclampsRemaining > 0) {
      this.asyncReclampsRemaining -= 1
      setTimeout(() => this.compositorClamp(nativeInset), 1)
    }
  }

  setPosition(x: number, y: number): void {
    this.bounds.x = x
    this.bounds.y = this.refusesFullBounds ? nativeInset.y : y
    this.emit('move')
  }

  compositorClamp(bounds: Rect): void {
    this.bounds = { ...bounds }
    this.emit('resize')
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('native exclusive onboarding bounds', () => {
  it('MQA-342 repairs a late compositor inset while Right edge is selected, without rearming a poller', async () => {
    vi.useFakeTimers()
    const window = new NativeWindow()
    const placement = 'right-edge'
    const stop = observeExclusiveBounds(window, {
      expected: () => fullDisplay,
      ownsDisplay: () => placement === 'right-edge' && !window.destroyed
    })

    // The initial two-second startup watcher has already expired; only a native geometry event remains.
    await vi.advanceTimersByTimeAsync(2_500)
    expect(vi.getTimerCount()).toBe(0)
    window.compositorClamp(nativeInset)
    await vi.advanceTimersByTimeAsync(1)

    expect(window.getBounds()).toEqual(fullDisplay)
    expect(window.setBoundsCount).toBeGreaterThan(0)
    expect(vi.getTimerCount()).toBe(0)
    stop()
  })

  it('does not resize a window after onboarding ownership ends', async () => {
    vi.useFakeTimers()
    const window = new NativeWindow()
    let onboardingLive = true
    const stop = observeExclusiveBounds(window, {
      expected: () => fullDisplay,
      ownsDisplay: () => onboardingLive
    })

    onboardingLive = false
    window.compositorClamp(nativeInset)
    await vi.advanceTimersByTimeAsync(1)

    expect(window.getBounds()).toEqual(nativeInset)
    expect(window.setBoundsCount).toBe(0)
    stop()
  })

  it('bounds native refusal instead of looping on resize events', async () => {
    vi.useFakeTimers()
    const window = new NativeWindow()
    window.refusesFullBounds = true
    const stop = observeExclusiveBounds(window, {
      expected: () => fullDisplay,
      ownsDisplay: () => true
    })

    window.compositorClamp(nativeInset)
    await vi.advanceTimersByTimeAsync(100)

    expect(window.setBoundsCount).toBeGreaterThan(0)
    expect(window.setBoundsCount).toBeLessThanOrEqual(8)
    expect(vi.getTimerCount()).toBe(0)
    stop()
  })

  it('MQA-342 bounds repeated asynchronous compositor reclamps during one unsettled episode', async () => {
    vi.useFakeTimers()
    const window = new NativeWindow()
    window.asyncReclampsRemaining = 12
    const stop = observeExclusiveBounds(window, {
      expected: () => fullDisplay,
      ownsDisplay: () => true
    })

    window.compositorClamp(nativeInset)
    await vi.advanceTimersByTimeAsync(100)

    expect(window.setBoundsCount).toBeLessThanOrEqual(4)
    stop()
  })

  it('allows a new repair after the full-screen bounds have stayed stable', async () => {
    vi.useFakeTimers()
    const window = new NativeWindow()
    window.asyncReclampsRemaining = 12
    const stop = observeExclusiveBounds(window, {
      expected: () => fullDisplay,
      ownsDisplay: () => true
    })

    window.compositorClamp(nativeInset)
    await vi.advanceTimersByTimeAsync(100)
    expect(window.setBoundsCount).toBe(4)

    window.asyncReclampsRemaining = 0
    window.compositorClamp(fullDisplay)
    await vi.advanceTimersByTimeAsync(1_001)
    window.compositorClamp(nativeInset)
    await vi.advanceTimersByTimeAsync(1)

    expect(window.getBounds()).toEqual(fullDisplay)
    expect(window.setBoundsCount).toBe(5)
    stop()
  })
})
