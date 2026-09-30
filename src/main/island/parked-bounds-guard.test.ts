import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { observeParkedBounds, type ParkedBoundsWindow } from './parked-bounds-guard'
import { rightAnchoredParkHolds, rightAnchoredParkPosition, rightEdgeHoverRestRect, type DisplayMetrics, type Rect } from './geometry'

/** The macOS packaged-smoke runner of the two failing RE-HIDE-3-meeting-hide runs. */
const runner: DisplayMetrics = {
  bounds: { x: 0, y: 0, width: 1024, height: 768 },
  workArea: { x: 0, y: 31, width: 1024, height: 674 },
  hasNotch: false,
  notchWidth: 0,
  menuBarHeight: 31,
  source: 'heuristic'
}
const TITLE_STRIP_PX = 32

/** Top-left-origin frame of a native window. `minWidth` models the Windows minimum frameless width. */
class NativeWindow extends EventEmitter implements ParkedBoundsWindow {
  bounds: Rect = { x: 652, y: 61, width: 360, height: 560 }
  destroyed = false
  minWidth = 1
  writes: Rect[] = []

  getBounds(): Rect { return { ...this.bounds } }
  isDestroyed(): boolean { return this.destroyed }

  setBounds(bounds: Rect): void {
    this.writes.push({ ...bounds })
    this.bounds = { ...bounds, width: Math.max(bounds.width, this.minWidth) }
    this.emit('resize')
    this.emit('move')
  }

  setPosition(x: number, y: number): void {
    this.bounds = { ...this.bounds, x, y }
    this.emit('move')
  }

  /** The frame re-derived from the content rect: content stays put, a title strip grows above it. */
  addTitleStrip(): void {
    this.bounds = { ...this.bounds, y: this.bounds.y - TITLE_STRIP_PX, height: this.bounds.height + TITLE_STRIP_PX }
    this.emit('resize')
    this.emit('move')
  }
}

/** index.ts's park: one setBounds and a synchronous readback that right-anchors a widened band. */
function commitPark(window: NativeWindow, park: Rect): void {
  window.setBounds(park)
  const after = window.getBounds()
  const target = rightAnchoredParkPosition(park, after.width)
  if (after.x !== target.x || after.y !== target.y) window.setPosition(target.x, target.y)
}

function parkedWindow(options: { minWidth?: number } = {}): { window: NativeWindow; band: Rect; state: { parked: Rect | null } } {
  const window = new NativeWindow()
  window.minWidth = options.minWidth ?? 1
  const band = rightEdgeHoverRestRect(undefined, runner)
  const state: { parked: Rect | null } = { parked: band }
  observeParkedBounds(window, {
    parked: () => state.parked,
    holds: rightAnchoredParkHolds,
    commit: (rect) => commitPark(window, rect)
  })
  commitPark(window, band)
  return { window, band, state }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('parked right-edge Hide band', () => {
  it('re-commits the requested band when a native frame change lands after the park (RE-HIDE-3-meeting-hide)', async () => {
    vi.useFakeTimers()
    const { window, band } = parkedWindow()
    expect(band).toEqual({ x: 1020, y: 61, width: 4, height: 560 })
    await vi.advanceTimersByTimeAsync(1)
    expect(window.getBounds()).toEqual(band)

    window.addTitleStrip()
    // The smoke evidence: the bottom edge unchanged, the top 32 px higher, above the work area.
    expect(window.getBounds()).toEqual({ x: 1020, y: 29, width: 4, height: 592 })
    await vi.advanceTimersByTimeAsync(1)

    expect(window.getBounds()).toEqual(band)
    expect(window.getBounds().y).toBeGreaterThanOrEqual(runner.workArea.y)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves a band the OS widened alone, and re-parks it right-anchored after a title strip', async () => {
    vi.useFakeTimers()
    const { window, band } = parkedWindow({ minWidth: 32 })
    await vi.advanceTimersByTimeAsync(1)
    expect(window.getBounds()).toEqual({ x: 992, y: band.y, width: 32, height: band.height })
    expect(window.writes).toHaveLength(1)

    window.addTitleStrip()
    await vi.advanceTimersByTimeAsync(1)
    expect(window.getBounds()).toEqual({ x: 992, y: band.y, width: 32, height: band.height })
  })

  it('never moves a window that is not parked on the band', async () => {
    vi.useFakeTimers()
    const { window, state } = parkedWindow()
    await vi.advanceTimersByTimeAsync(1)
    state.parked = null
    window.addTitleStrip()
    await vi.advanceTimersByTimeAsync(1)
    expect(window.getBounds()).toEqual({ x: 1020, y: 29, width: 4, height: 592 })
    expect(window.writes).toHaveLength(1)
  })

  it('stops after a bounded number of re-commits when the native frame keeps changing', async () => {
    vi.useFakeTimers()
    const { window } = parkedWindow()
    await vi.advanceTimersByTimeAsync(1)
    for (let change = 0; change < 10; change++) {
      window.addTitleStrip()
      await vi.advanceTimersByTimeAsync(1)
    }
    expect(window.writes.length).toBeLessThanOrEqual(1 + 4)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('gives each park its own budget', async () => {
    vi.useFakeTimers()
    const { window, band, state } = parkedWindow()
    for (let change = 0; change < 6; change++) {
      window.addTitleStrip()
      await vi.advanceTimersByTimeAsync(1)
    }
    state.parked = { ...band }
    commitPark(window, state.parked)
    window.addTitleStrip()
    await vi.advanceTimersByTimeAsync(1)
    expect(window.getBounds()).toEqual(band)
  })
})

describe('rightAnchoredParkHolds', () => {
  const band: Rect = { x: 1020, y: 61, width: 4, height: 560 }

  it('holds the requested band and a right-anchored widening of it', () => {
    expect(rightAnchoredParkHolds(band, band)).toBe(true)
    expect(rightAnchoredParkHolds({ x: 992, y: 61, width: 32, height: 560 }, band)).toBe(true)
  })

  it('rejects a title strip above the band, a left-anchored widening and a narrower frame', () => {
    expect(rightAnchoredParkHolds({ x: 1020, y: 29, width: 4, height: 592 }, band)).toBe(false)
    expect(rightAnchoredParkHolds({ x: 1020, y: 61, width: 32, height: 560 }, band)).toBe(false)
    expect(rightAnchoredParkHolds({ x: 1021, y: 61, width: 3, height: 560 }, band)).toBe(false)
  })
})
