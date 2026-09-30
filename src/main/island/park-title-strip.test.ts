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
 * Fix: the park releases the minimum size through `releaseParkMinimumSize`, which never re-writes an unchanged
 * minimum, so no native constraint change follows the park. The window below models the assumed AppKit
 * behavior; `hidePark` runs the park's window writes in the order parkOverlayAfterHideSpring issues them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rightEdgeHoverRestRect, rightEdgeSidecarBounds, type DisplayMetrics, type Rect } from './geometry'
import { releaseParkMinimumSize } from './park-minimum-size'

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
  setBounds(bounds: Rect): void { this.bounds = { ...bounds } }
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

/** The explicit right-edge Hide park: release the minimum size, then commit the band. */
function hidePark(win: TitledFramelessWindow, releaseMinimum: (win: TitledFramelessWindow) => void): Rect {
  const band = rightEdgeHoverRestRect(undefined, runner)
  releaseMinimum(win)
  win.setBounds(band)
  return band
}

afterEach(() => {
  vi.useRealTimers()
})

describe('right-edge Hide park on a frameless titled macOS window (RE-HIDE-3-meeting-hide)', () => {
  it('the park before the fix (an unconditional 1×1 write) reproduces the smoke failure: 32 px above the band', async () => {
    vi.useFakeTimers()
    const win = new TitledFramelessWindow()
    const band = hidePark(win, (w) => w.setMinimumSize(1, 1))
    expect(band).toEqual({ x: 1020, y: 61, width: 4, height: 560 })
    expect(win.getBounds()).toEqual(band)
    await vi.runAllTimersAsync()
    expect(win.getBounds()).toEqual({ x: 1020, y: 29, width: 4, height: 592 })
    expect(win.getBounds().y).toBeLessThan(runner.workArea.y)
  })

  it('an explicit Hide from the live-meeting drawer stays on the requested band after every native pass', async () => {
    vi.useFakeTimers()
    const win = new TitledFramelessWindow()
    const band = hidePark(win, releaseParkMinimumSize)
    await vi.runAllTimersAsync()
    expect(win.getBounds()).toEqual(band)
    expect(win.getBounds().y).toBeGreaterThanOrEqual(runner.workArea.y)
    expect(win.minimumWrites).toEqual([])
  })

  it('still releases a leftover larger minimum on park', () => {
    vi.useFakeTimers()
    const win = new TitledFramelessWindow()
    win.minimum = [880, 600]
    hidePark(win, releaseParkMinimumSize)
    expect(win.minimumWrites).toEqual([[1, 1]])
    expect(win.getMinimumSize()).toEqual([1, 1])
  })

  it('a headless window whose minimum size cannot be read does not break the park', () => {
    const headless = {
      getMinimumSize: (): number[] => { throw new Error('headless') },
      setMinimumSize: vi.fn()
    }
    expect(() => releaseParkMinimumSize(headless)).not.toThrow()
    expect(headless.setMinimumSize).not.toHaveBeenCalled()
  })
})
