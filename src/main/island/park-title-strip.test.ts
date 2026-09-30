/**
 * RE-HIDE-3-meeting-hide (M2-0526): a Hide during a live meeting on macOS sometimes left the right-edge band
 * at {x:1020, y:29, w:4, h:560+32} instead of the requested {x:1020, y:61, w:4, h:560}.
 *
 * Root cause.
 * - OBSERVED (smoke evidence): x, width and the bottom edge equal the band; the top is 32 px higher. In
 *   AppKit's bottom-left coordinates the frame origin is unchanged and only the height grew, which is what a
 *   frame re-derived from a content rect of a titled window does: it adds the title strip above the content.
 *   No bounds writer in index.ts can produce it (every right-edge height is at most the 560 px drawer), so the
 *   frame is native.
 * - DERIVED (Electron source, shell/browser/native_window_mac.mm): a `frame: false` window keeps
 *   NSWindowStyleMaskTitled unless `roundedCorners: false`; Electron notes there that its frameless window
 *   "still has titlebar attached" and converts minimum sizes through the original content rect for that
 *   reason. The overlay is built with `roundedCorners: true`, so it carries a hidden title strip.
 * - ASSUMED (to be confirmed by the packaged-smoke geometry trace of this row): the trigger is the park's own
 *   `setMinimumSize(1, 1)`. It re-applied the native size constraints on every park even when they were
 *   already 1×1, and the frame change that follows is applied by AppKit on a later pass, not inside the
 *   call, so the synchronous park and its readback cannot see it. It lands after the park only sometimes:
 *   during a live meeting the Hide control parks immediately from the click (auto-hide is off while a
 *   capture runs, so no exit spring precedes it), while the drawer is still painting.
 *
 * Fix: the park never re-writes an unchanged minimum size, so no native constraint change follows it. The
 * window below models the assumed AppKit behavior and runs the shipped park path lifted from index.ts.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { overlayUsesHover } from '@shared/overlay-chrome'
import { pointInRect } from './cursor-watch'
import { rightAnchoredParkPosition, rightEdgeHoverRestRect, rightEdgeSidecarBounds, type DisplayMetrics, type Rect } from './geometry'

const source = readFileSync(join(__dirname, '../index.ts'), 'utf8').replace(/\r\n/g, '\n')

/** The macOS packaged-smoke runner of the two failing runs. */
const runner: DisplayMetrics = {
  bounds: { x: 0, y: 0, width: 1024, height: 768 },
  workArea: { x: 0, y: 31, width: 1024, height: 674 },
  hasNotch: false,
  notchWidth: 0,
  menuBarHeight: 31,
  source: 'heuristic'
}
const TITLE_STRIP_PX = 32

/**
 * A frameless-but-titled NSWindow. A minimum-size write re-applies its size constraints; AppKit re-derives
 * the frame from the content rect on a later pass, keeping the bottom edge and adding the title strip above.
 */
class TitledFramelessWindow {
  bounds: Rect = rightEdgeSidecarBounds(runner, { open: true })
  minimum: [number, number] = [1, 1]
  minimumWrites: Array<[number, number]> = []

  getBounds(): Rect { return { ...this.bounds } }
  isDestroyed(): boolean { return false }
  isVisible(): boolean { return true }
  showInactive(): void {}
  setBounds(bounds: Rect): void { this.bounds = { ...bounds } }
  setPosition(x: number, y: number): void { this.bounds = { ...this.bounds, x, y } }
  getMinimumSize(): [number, number] { return [...this.minimum] }

  setMinimumSize(width: number, height: number): void {
    this.minimum = [width, height]
    this.minimumWrites.push([width, height])
    setTimeout(() => {
      const { x, y, width: w, height: h } = this.bounds
      this.bounds = { x, y: y - TITLE_STRIP_PX, width: w, height: h + TITLE_STRIP_PX }
    }, 0)
  }
}

/** Lifts one shipped function, dropping its TypeScript parameter and return annotations. */
function lift(signature: string, jsSignature: string, stop: string): string {
  const begin = source.indexOf(signature)
  const end = source.indexOf(stop, begin)
  expect(begin).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(begin)
  return source.slice(begin, end).replace(signature, jsSignature)
}

/** The shipped explicit Hide (parkOverlayAfterHideSpring + commitParkedOverlayBounds) on a right-edge Hide. */
function rightEdgeHide(win: TitledFramelessWindow): { park: (force?: boolean) => boolean; band: Rect } {
  const band = rightEdgeHoverRestRect(undefined, runner)
  const display = { id: 1, bounds: runner.bounds, workArea: runner.workArea }
  const deps = {
    win,
    screen: { getDisplayMatching: () => display, getCursorScreenPoint: () => ({ x: 1023, y: band.y + 280 }) },
    onboardingExclusiveLive: () => false,
    pointerInIslandOrBar: () => true,
    cancelOverlayLeavePark: () => {},
    liveOverlayLayout: () => 'hide',
    overlayUsesHover,
    parkedOverlayBounds: () => band,
    applyOverlaySurfaceChrome: () => {},
    applyHideClickThrough: () => {},
    pointInRect,
    overlayHoverRestRect: () => band,
    resolvedOverlayPlacementForDisplay: () => 'right-edge',
    rightAnchoredParkPosition,
    notifyOverlayCursorHover: () => {},
    mainLog: { info: () => {} }
  }
  const commit = lift(
    'function commitParkedOverlayBounds(park: { x: number; y: number; width: number; height: number }): void {',
    'function commitParkedOverlayBounds(park) {',
    'function stopExclusiveBoundsWatch'
  )
  const park = lift(
    'function parkOverlayAfterHideSpring(force = false): boolean {',
    'function parkOverlayAfterHideSpring(force = false) {',
    '/** Hide rest is click-through'
  )
  const build = new Function(...Object.keys(deps), `
    let settingsSurfaceOpen = false;
    let islandResting = false;
    let currentWidth = 360;
    let userAnchorY = 0;
    let overlayCursorWatchHovering = true;
    let rightEdgeUnhoveredRevealAt = null;
    let overlayParkLatched = false;
    ${commit}
    ${park}
    return parkOverlayAfterHideSpring;
  `) as (...args: unknown[]) => (force?: boolean) => boolean
  return { park: build(...Object.values(deps)), band }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('right-edge Hide park on a frameless titled macOS window (RE-HIDE-3-meeting-hide)', () => {
  it('the modeled late frame change is the smoke failure: the band grows 32 px above itself', async () => {
    vi.useFakeTimers()
    const win = new TitledFramelessWindow()
    const { park, band } = rightEdgeHide(win)
    expect(park(true)).toBe(true)
    expect(win.getBounds()).toEqual({ x: 1020, y: 61, width: 4, height: 560 })
    win.setMinimumSize(1, 1)
    await vi.runAllTimersAsync()
    expect(win.getBounds()).toEqual({ x: 1020, y: 29, width: 4, height: 592 })
    expect(win.getBounds().y).toBeLessThan(runner.workArea.y)
    expect(band).toEqual({ x: 1020, y: 61, width: 4, height: 560 })
  })

  it('an explicit Hide from the live-meeting drawer stays on the requested band after every native pass', async () => {
    vi.useFakeTimers()
    const win = new TitledFramelessWindow()
    const { park, band } = rightEdgeHide(win)
    expect(park(true)).toBe(true)
    await vi.runAllTimersAsync()
    expect(win.getBounds()).toEqual(band)
    expect(win.getBounds().y).toBeGreaterThanOrEqual(runner.workArea.y)
    expect(win.minimumWrites).toEqual([])
  })

  it('still releases a leftover larger minimum on park', () => {
    vi.useFakeTimers()
    const win = new TitledFramelessWindow()
    win.minimum = [880, 600]
    const { park } = rightEdgeHide(win)
    expect(park(true)).toBe(true)
    expect(win.minimumWrites).toEqual([[1, 1]])
    expect(win.getMinimumSize()).toEqual([1, 1])
  })
})
