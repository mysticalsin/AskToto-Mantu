/**
 * RE-HIDE-3-meeting-hide (M2-0526): a Hide during a live meeting on macOS sometimes left the right-edge band
 * at {x:1020, y:29, w:4, h:560+32} instead of the requested {x:1020, y:61, w:4, h:560}.
 *
 * Root cause.
 * - OBSERVED (packaged-smoke geometry trace of this row, ms after the Hide click): 405 write = band, 413 frame =
 *   band, 529 frame = {y:29, h:592} with no app write of any kind in between. The frame change is native and
 *   lands on a later AppKit pass, which is why it is intermittent: it only fails the row when it lands before
 *   the row reads the band.
 * - OBSERVED: x, width and the bottom edge equal the band; the top is 32 px higher. In AppKit's bottom-left
 *   coordinates the origin is unchanged and only the height grew: the frame of a titled window re-derived from
 *   its content rect, which adds the title strip above the content.
 * - DERIVED (Electron, shell/browser/native_window_mac.mm): a `frame: false` window keeps
 *   NSWindowStyleMaskTitled unless `roundedCorners: false`, which makes it NSWindowStyleMaskBorderless. The
 *   overlay was built with `roundedCorners: true`, so its content rect is the whole frame and any re-derive
 *   adds a 32 px strip it never drew.
 *
 * Fix at the cause: the overlay chrome is borderless (`roundedCorners: false`). Frame and content rect are
 * then the same rect, so no later native pass, whatever triggers it, can move a parked band. The window below
 * models that AppKit behavior from the constructor options; `hidePark` runs the park's window writes in the
 * order parkOverlayAfterHideSpring issues them, and the native pass fires at the trace's 529 ms.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { overlayWindowChrome, rightEdgeHoverRestRect, rightEdgeSidecarBounds, type DisplayMetrics, type Rect } from './geometry'

/** The macOS packaged-smoke runner of the failing runs. */
const runner: DisplayMetrics = {
  bounds: { x: 0, y: 0, width: 1024, height: 768 },
  workArea: { x: 0, y: 31, width: 1024, height: 674 },
  hasNotch: false,
  notchWidth: 0,
  menuBarHeight: 31,
  source: 'heuristic'
}
const TITLE_STRIP_PX = 32
const NATIVE_REFRAME_MS = 529 - 405

interface MacWindowOptions {
  frame: boolean
  roundedCorners: boolean
}

/**
 * An NSWindow built the way Electron builds it on macOS. A frameless window's content view fills its frame;
 * a later native pass re-derives the frame from that content rect, keeping the bottom edge and adding the title
 * strip above it when the window is titled. No app call triggers the pass.
 */
class MacOverlayWindow {
  readonly titled: boolean
  bounds: Rect = rightEdgeSidecarBounds(runner, { open: true })
  opacity = 1
  clickThrough = false

  constructor(options: MacWindowOptions) {
    this.titled = options.frame || options.roundedCorners
  }

  getBounds(): Rect { return { ...this.bounds } }
  setMinimumSize(): void {}
  setOpacity(opacity: number): void { this.opacity = opacity }
  setIgnoreMouseEvents(ignore: boolean): void { this.clickThrough = ignore }

  setBounds(bounds: Rect): void {
    this.bounds = { ...bounds }
    setTimeout(() => this.reframeFromContentRect(), NATIVE_REFRAME_MS)
  }

  private reframeFromContentRect(): void {
    if (!this.titled) return
    const { x, y, width, height } = this.bounds
    this.bounds = { x, y: y - TITLE_STRIP_PX, width, height: height + TITLE_STRIP_PX }
  }
}

/** The overlay as createWindow builds it: frameless, with the transparent (post-onboarding) chrome. */
function overlayWindow(): MacOverlayWindow {
  return new MacOverlayWindow({ frame: false, roundedCorners: overlayWindowChrome(false).roundedCorners })
}

/** The explicit right-edge Hide park: minimum size, chrome (opacity 0), band, click-through. */
function hidePark(win: MacOverlayWindow): Rect {
  const band = rightEdgeHoverRestRect(undefined, runner)
  win.setMinimumSize()
  win.setOpacity(0)
  win.setBounds(band)
  win.setIgnoreMouseEvents(true)
  return band
}

afterEach(() => {
  vi.useRealTimers()
})

describe('right-edge Hide park on the macOS overlay window (RE-HIDE-3-meeting-hide)', () => {
  it('a titled frameless window reproduces the smoke failure: a native pass puts the band 32 px above itself', async () => {
    vi.useFakeTimers()
    const win = new MacOverlayWindow({ frame: false, roundedCorners: true })
    const band = hidePark(win)
    expect(band).toEqual({ x: 1020, y: 61, width: 4, height: 560 })
    expect(win.getBounds()).toEqual(band)
    await vi.advanceTimersByTimeAsync(NATIVE_REFRAME_MS)
    expect(win.getBounds()).toEqual({ x: 1020, y: 29, width: 4, height: 592 })
    expect(win.getBounds().y).toBeLessThan(runner.workArea.y)
  })

  it('the overlay chrome builds a borderless window', () => {
    expect(overlayWindow().titled).toBe(false)
    expect(new MacOverlayWindow({ frame: false, roundedCorners: overlayWindowChrome(true).roundedCorners }).titled).toBe(false)
  })

  it('an explicit Hide from the live-meeting drawer stays on the requested band after every native pass', async () => {
    vi.useFakeTimers()
    const win = overlayWindow()
    const band = hidePark(win)
    await vi.advanceTimersByTimeAsync(NATIVE_REFRAME_MS)
    expect(win.getBounds()).toEqual(band)
    await vi.runAllTimersAsync()
    expect(win.getBounds()).toEqual(band)
    expect(win.getBounds().y).toBeGreaterThanOrEqual(runner.workArea.y)
    expect(win.opacity).toBe(0)
    expect(win.clickThrough).toBe(true)
  })
})
