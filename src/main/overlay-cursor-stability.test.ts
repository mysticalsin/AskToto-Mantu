import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as cursorWatch from './island/cursor-watch'
import { RIGHT_EDGE_UNHOVERED_REVEAL_GRACE_MS } from './island/cursor-watch'
import { hoverWatchRestRect, rightEdgeSidecarBounds, type DisplayMetrics, type Rect } from './island/geometry'
import { isIncompleteAskReveal, overlayUsesHover } from '@shared/overlay-chrome'

const source = readFileSync(join(__dirname, 'index.ts'), 'utf8').replace(/\r\n/g, '\n')

const DISPLAY: DisplayMetrics = {
  bounds: { x: 0, y: 0, width: 1800, height: 1169 },
  workArea: { x: 0, y: 39, width: 1800, height: 1130 },
  hasNotch: true,
  notchWidth: 200,
  menuBarHeight: 39,
  source: 'helper'
}

/** Execute the shipped native polling handler without booting Electron. Only the OS window/cursor,
 * IPC and timer side effects are substituted; hit testing and the watcher's state transitions are real.
 * The default fixture is the established top-edge Hide; `rightEdge` runs the same handler for a
 * right-edge Hide parked as its reveal band (or revealed as its drawer). */
function nativeHover(options: {
  rightEdge?: { resting: boolean; latched?: boolean; unhoveredRevealAt?: number | null }
} = {}) {
  const display = DISPLAY
  const rightEdge = options.rightEdge
  const placement = rightEdge ? 'right-edge' : 'top-center'
  const band = hoverWatchRestRect('hide', display, 'right-edge')
  const parked = rightEdge ? band : { x: 896, y: 0, width: 8, height: 2 }
  const revealed = rightEdge ? rightEdgeSidecarBounds(display, { open: true }) : { x: 460, y: 39, width: 880, height: 120 }
  let bounds: Rect = rightEdge && !rightEdge.resting ? revealed : parked
  let cursor = { x: 900, y: 600 }
  let now = 0
  let parkPending = false
  let restoreCount = 0
  const notifications: boolean[] = []
  const deps = {
    ...cursorWatch,
    win: { isDestroyed: () => false, isVisible: () => true, getBounds: () => bounds, setMinimumSize: () => {}, showInactive: () => {} },
    screen: { getDisplayMatching: () => display, getCursorScreenPoint: () => cursor },
    performance: { now: () => now },
    overlayCursorWatchWanted: () => true,
    stopOverlayCursorWatch: () => {},
    healHideGhostSlab: () => false,
    getDisplayMetrics: () => display,
    liveOverlayLayout: () => 'hide',
    resolvedOverlayPlacementForDisplay: () => placement,
    // The lifted native handler delegates the rest rectangle to index.ts so it can honor the selected
    // physical placement.
    overlayHoverRestRect: (layout: 'hide') => hoverWatchRestRect(layout, display, placement),
    hoverWatchRestRect,
    isIncompleteAskReveal,
    cancelOverlayLeavePark: () => { parkPending = false },
    scheduleOverlayLeavePark: () => { parkPending = true },
    notifyOverlayCursorHover: (hovering: boolean) => { notifications.push(hovering) },
    restoreWindow: () => { bounds = revealed; restoreCount++ },
    mainLog: { info: () => {} },
    // The lifted park handler (an explicit Hide) substitutes the same OS side effects.
    onboardingExclusiveLive: () => false,
    pointerInIslandOrBar: () => false,
    overlayUsesHover,
    parkedOverlayBounds: () => parked,
    applyOverlaySurfaceChrome: () => {},
    commitParkedOverlayBounds: (park: Rect) => { bounds = park },
    applyHideClickThrough: () => {}
  }
  // Lifts one shipped function, dropping only its TypeScript return annotation.
  const lift = (signature: string, stop: string): string => {
    const begin = source.indexOf(signature)
    const end = source.indexOf(stop, begin)
    expect(begin).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(begin)
    return source.slice(begin, end).replace(signature, signature.replace(/\): \w+ \{$/, ') {'))
  }
  const handler = lift('function tickOverlayCursorWatch(): void {', 'function notifyOverlayCursorHover')
  const parkHandler = lift('function parkOverlayAfterHideSpring(force = false): boolean {', 'function applyHideClickThrough')
  const build = new Function(...Object.keys(deps), `
    let islandResting = ${rightEdge ? rightEdge.resting : true};
    let settingsSurfaceOpen = false;
    let overlayCursorWatchHovering = false;
    let overlayCursorWatchEnteredAt = null;
    let overlayParkLatched = ${rightEdge?.latched === true};
    let rightEdgeUnhoveredRevealAt = ${rightEdge?.unhoveredRevealAt ?? null};
    let currentWidth = 0;
    let userAnchorY = 0;
    function restoreBarWidth() { overlayParkLatched = false; islandResting = false; restoreWindow(); }
    ${handler}
    ${parkHandler}
    return { tick: tickOverlayCursorWatch, park: parkOverlayAfterHideSpring };
  `) as (...args: unknown[]) => { tick: () => void; park: (force?: boolean) => boolean }
  const { tick, park } = build(...Object.values(deps))
  return {
    tick(at: number, y: number): void {
      now = at
      cursor = { x: 900, y }
      tick()
    },
    tickAt(at: number, point: { x: number; y: number }): void {
      now = at
      cursor = point
      tick()
    },
    /** An explicit Hide (a forced park: the Hide control, Escape, the hotkey or tray) with the pointer at `point`. */
    hideAt(at: number, point: { x: number; y: number }): void {
      now = at
      cursor = point
      expect(park(true)).toBe(true)
    },
    band,
    revealed,
    state: () => ({ bounds, parkPending, restoreCount, notifications: [...notifications] })
  }
}

describe('MQA-298 native overlay hover stability', () => {
  it('a brief menu-bar crossing never reveals or notifies the renderer', () => {
    const hover = nativeHover()
    hover.tick(0, 12)
    hover.tick(24, 12)
    hover.tick(48, 600)
    hover.tick(192, 600)
    expect(hover.state().restoreCount).toBe(0)
    expect(hover.state().notifications).toEqual([])
    expect(hover.state().bounds).toEqual({ x: 896, y: 0, width: 8, height: 2 })
  })

  it('a continuous intentional hover reveals once after the dwell and stays settled', () => {
    const hover = nativeHover()
    for (let at = 0; at < 150; at += 24) hover.tick(at, 12)
    expect(hover.state().restoreCount).toBe(0)
    for (let at = 168; at < 600; at += 24) hover.tick(at, 12)
    expect(hover.state().restoreCount).toBe(1)
    expect(hover.state().notifications).toEqual([true])
  })

  it('leaving before reveal restarts the dwell on the next approach', () => {
    const hover = nativeHover()
    hover.tick(0, 12)
    hover.tick(120, 12)
    hover.tick(144, 600)
    hover.tick(168, 12)
    hover.tick(288, 12)
    expect(hover.state().restoreCount).toBe(0)
    hover.tick(336, 12)
    expect(hover.state().restoreCount).toBe(1)
  })

  it('returning to the menu-bar strip during leave grace cancels collapse immediately', () => {
    const hover = nativeHover()
    hover.tick(0, 12)
    hover.tick(168, 12)
    hover.tick(192, 600)
    expect(hover.state().parkPending).toBe(true)
    expect(hover.state().notifications).toEqual([true, false])
    hover.tick(216, 12)
    expect(hover.state().parkPending).toBe(false)
    expect(hover.state().notifications).toEqual([true, false, true])
    expect(hover.state().restoreCount).toBe(1)
    hover.tick(240, 12)
    expect(hover.state().notifications).toEqual([true, false, true])
  })
})

describe('right-edge Hide native watch', () => {
  const edge = DISPLAY.bounds.x + DISPLAY.bounds.width - 1

  it('RE-HIDE-1: the pointer resting at the physical right edge beside the drawer reveals it within 400 ms', () => {
    const hover = nativeHover({ rightEdge: { resting: true } })
    const y = hover.band.y + Math.round(hover.band.height / 2)
    let revealedAt: number | null = null
    for (let at = 0; at <= 400 && revealedAt === null; at += 24) {
      hover.tickAt(at, { x: edge, y })
      if (hover.state().restoreCount > 0) revealedAt = at
    }
    expect(revealedAt).not.toBeNull()
    expect(revealedAt!).toBeLessThanOrEqual(400)
    expect(hover.state().bounds).toEqual(hover.revealed)
    expect(hover.state().notifications).toEqual([true])
  })

  it('RE-HIDE-2: the pointer 40 px inside the work area at the old tab position never reveals', () => {
    const hover = nativeHover({ rightEdge: { resting: true } })
    const tab = rightEdgeSidecarBounds(DISPLAY, { open: false })
    for (let at = 0; at <= 600; at += 24) {
      hover.tickAt(at, { x: DISPLAY.workArea.x + DISPLAY.workArea.width - 40, y: tab.y + 20 })
    }
    expect(hover.state().restoreCount).toBe(0)
    expect(hover.state().bounds).toEqual(hover.band)
    expect(hover.state().notifications).toEqual([])
  })

  it('RE-HIDE-5: an explicit Hide stays parked under the pointer until it leaves the band, then the band works again', () => {
    const hover = nativeHover({ rightEdge: { resting: true, latched: true } })
    const inBand = { x: edge, y: hover.band.y + 40 }
    for (let at = 0; at <= 600; at += 24) hover.tickAt(at, inBand)
    expect(hover.state().restoreCount).toBe(0)
    expect(hover.state().bounds).toEqual(hover.band)
    hover.tickAt(624, { x: 600, y: 500 })
    for (let at = 648; at <= 1000; at += 24) hover.tickAt(at, inBand)
    expect(hover.state().restoreCount).toBe(1)
  })

  it('RE-HIDE-5: an explicit Hide issued with the pointer in the band latches the park until the pointer leaves', () => {
    const hover = nativeHover({ rightEdge: { resting: false } })
    const inBand = { x: edge, y: hover.band.y + 40 }
    hover.hideAt(0, inBand)
    expect(hover.state().bounds).toEqual(hover.band)
    for (let at = 24; at <= 624; at += 24) hover.tickAt(at, inBand)
    expect(hover.state().restoreCount).toBe(0)
    hover.tickAt(648, { x: 600, y: 500 })
    for (let at = 672; at <= 1000; at += 24) hover.tickAt(at, inBand)
    expect(hover.state().restoreCount).toBe(1)
  })

  it('an explicit Hide issued with the pointer away from the band never latches: the next edge approach reveals', () => {
    // Windows packaged smoke: the pointer was already away at Hide time, then reached the edge before any
    // 24 ms tick sampled it away, so a latch armed regardless of the pointer blocked every later reveal.
    const hover = nativeHover({ rightEdge: { resting: false } })
    hover.hideAt(0, { x: 400, y: 500 })
    expect(hover.state().bounds).toEqual(hover.band)
    const inBand = { x: edge, y: hover.band.y + Math.round(hover.band.height / 2) }
    for (let at = 24; at <= 400; at += 24) hover.tickAt(at, inBand)
    expect(hover.state().restoreCount).toBe(1)
    expect(hover.state().bounds).toEqual(hover.revealed)
  })

  it('RE-HIDE-6: a reveal the pointer never visited reports a leave once, after the right-edge grace', () => {
    const hover = nativeHover({ rightEdge: { resting: false, unhoveredRevealAt: 0 } })
    const away = { x: 400, y: 500 }
    for (let at = 0; at < RIGHT_EDGE_UNHOVERED_REVEAL_GRACE_MS; at += 24) hover.tickAt(at, away)
    expect(hover.state().notifications).toEqual([])
    hover.tickAt(RIGHT_EDGE_UNHOVERED_REVEAL_GRACE_MS, away)
    hover.tickAt(RIGHT_EDGE_UNHOVERED_REVEAL_GRACE_MS + 24, away)
    expect(hover.state().notifications).toEqual([false])
    expect(hover.state().parkPending).toBe(false)
  })

  it('a pointer that visits the unhovered reveal hands it to the ordinary leave → park rule', () => {
    const hover = nativeHover({ rightEdge: { resting: false, unhoveredRevealAt: 0 } })
    hover.tickAt(24, { x: hover.revealed.x + 20, y: hover.revealed.y + 20 })
    expect(hover.state().notifications).toEqual([true])
    hover.tickAt(48, { x: 400, y: 500 })
    expect(hover.state().parkPending).toBe(true)
    for (let at = 72; at <= RIGHT_EDGE_UNHOVERED_REVEAL_GRACE_MS + 100; at += 24) hover.tickAt(at, { x: 400, y: 500 })
    expect(hover.state().notifications).toEqual([true, false])
  })
})
