import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sourceIndexOf } from '../../scripts/lib/source-layout'
import * as cursorWatch from './island/cursor-watch'
import {
  CURSOR_LEAVE_GRACE_PX,
  RIGHT_EDGE_UNHOVERED_REVEAL_GRACE_MS,
  TOP_CENTER_REVEAL_DWELL_MS
} from './island/cursor-watch'
import {
  clampHeight as islandClampHeight,
  hoverRestTop,
  hoverWatchRestRect,
  overlayRestSize,
  recenterXForWidth,
  rightEdgeSidecarBounds,
  shouldIgnoreResizeWhilePeekResting,
  topClamp,
  type DisplayMetrics,
  type Rect
} from './island/geometry'
import {
  ASK_REVEAL_MIN_HEIGHT_PX,
  isIncompleteAskReveal,
  overlayRevealedContentHeight,
  overlayUsesHover,
  rememberBarContentHeight
} from '@shared/overlay-chrome'
import { createRightEdgeAnchors } from './island/right-edge-anchor'
import { createRightEdgeSession } from './island/right-edge-session'
import { RIGHT_EDGE_PINS, type RightEdgePin } from '@shared/right-edge-state'
import { readerRect } from '@shared/right-edge-geometry'
import { RE_BLUR_TOGGLE_GRACE_MS } from '@shared/right-edge-timing'

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
function nativeHover(
  options: { rightEdge?: { resting: boolean; latched?: boolean; unhoveredRevealAt?: number | null } } = {}
) {
  const display = DISPLAY
  const rightEdge = options.rightEdge
  const placement = rightEdge ? 'right-edge' : 'top-center'
  const band = hoverWatchRestRect('hide', display, 'right-edge')
  const parked = rightEdge ? band : { x: 896, y: 0, width: 8, height: 2 }
  const revealed = rightEdge
    ? rightEdgeSidecarBounds(display, { open: true })
    : { x: 460, y: 39, width: 880, height: 120 }
  let bounds: Rect = rightEdge && !rightEdge.resting ? revealed : parked
  let cursor = { x: 900, y: 600 }
  let now = 0
  let parkPending = false
  let restoreCount = 0
  const notifications: boolean[] = []
  /** Every reveal/park cause the lifted handlers report to noteOverlay (M2-0431). */
  const noted: string[] = []
  /** Every bounds write the lifted moveBy / resizeTo make. */
  const setBoundsCalls: Rect[] = []
  /** The reveal controller's reasons and the hotkey actions sent to the page (the lifted toggle, M2-0202 S3). */
  const reveals: string[] = []
  const hotkeys: string[] = []
  const win = {
    isDestroyed: () => false,
    isVisible: () => true,
    getBounds: () => bounds,
    setBounds: (next: Rect) => {
      bounds = { ...next }
      setBoundsCalls.push({ ...next })
    },
    setMinimumSize: () => {},
    showInactive: () => {},
    hide: () => {},
    webContents: {
      send: (_channel: string, action: string) => {
        hotkeys.push(action)
      }
    }
  }
  const deps = {
    ...cursorWatch,
    win,
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
    cancelOverlayLeavePark: () => {
      parkPending = false
    },
    scheduleOverlayLeavePark: () => {
      parkPending = true
    },
    notifyOverlayCursorHover: (hovering: boolean) => {
      notifications.push(hovering)
    },
    // `next` is the lifted rightEdgeBounds('open') on the right edge: the legacy drawer (equal to `revealed`
    // at the default anchor), or readerRect while the page holds a Reader.
    restoreWindow: (next?: Rect) => {
      bounds = next ?? revealed
      restoreCount++
      return bounds.width
    },
    noteReveal: (reason: string) => {
      reveals.push(reason)
    },
    IPC: { hotkey: 'hotkey' },
    parkLayoutForDisplay: (layout: string) => layout,
    mainLog: { info: () => {} },
    // Reveal/park cause logging (M2-0431) has no OS side effect; overlay-reveal-log.test.ts covers the log itself.
    noteOverlay: (cause: string) => {
      noted.push(cause)
    },
    // The lifted moveBy / resizeTo (a drag and the renderer's content resize) substitute the same OS side
    // effects; their placement math is the shipped geometry.
    ensureWindow: () => win,
    clampHeight: (height: number, areaHeight: number) => islandClampHeight(height, areaHeight, 44),
    isReachable: () => true,
    refitToDisplay: (next: Rect) => next,
    queueRightEdgeYForDisplay: () => {},
    overlayRestSize,
    shouldIgnoreResizeWhilePeekResting,
    overlayRevealedContentHeight,
    ASK_REVEAL_MIN_HEIGHT_PX,
    rememberBarContentHeight,
    hoverRestTop,
    topClamp,
    recenterXForWidth,
    ISLAND_TOP_MARGIN: 8,
    RESIZE_EDGE_MARGIN: 8,
    // The lifted park handler (an explicit Hide) substitutes the same OS side effects.
    onboardingExclusiveLive: () => false,
    pointerInIslandOrBar: () => false,
    overlayUsesHover,
    parkedOverlayBounds: () => parked,
    applyOverlaySurfaceChrome: () => {},
    commitParkedOverlayBounds: (park: Rect) => {
      bounds = park
    },
    applyHideClickThrough: () => {},
    startOverlayCursorWatch: () => {},
    // The right-edge hold region (M2-0202) is the real anchor store at the default anchor, nothing persisted.
    rightEdgeAnchors: createRightEdgeAnchors({
      stored: () => ({ anchors: {}, legacy: {} }),
      saveAnchors: () => {},
      lockedKeys: () => [],
      rightEdgeLive: () => true,
      warn: () => {},
      later: () => {}
    }),
    // The park gate (M2-0202) is the real session; a refused leave-park retries through the real schedule.
    rightEdgeSession: createRightEdgeSession({
      surface: () => ({ surface: 'island', restKind: 'none', edgeClass: 'W', cardMaxHeight: 0, slotMax: 0 }),
      send: () => {},
      onPinsCleared: () => {
        parkPending = true
      }
    })
  }
  // Lifts one shipped function, dropping only its TypeScript parameter and return annotations.
  const lift = (signature: string, stop: string, jsSignature = signature.replace(/\): \w+ \{$/, ') {')): string => {
    const begin = sourceIndexOf(source, signature)
    const end = sourceIndexOf(source, stop, begin)
    expect(begin).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(begin)
    return source.slice(begin, end).replace(signature, jsSignature)
  }
  const handler = lift('function tickOverlayCursorWatch(): void {', 'function notifyOverlayCursorHover')
  const parkHandler = lift(
    'function parkOverlayAfterHideSpring(force = false): boolean {',
    'function applyHideClickThrough'
  )
  const layoutChangeHandler = lift('function parkOverlayForLayoutChange(): void {', '/** Pin the overlay')
  const moveHandler = lift(
    'function moveBy(dx: number, dy: number): void {',
    '/**\n * Keep the overlay reachable',
    'function moveBy(dx, dy) {'
  )
  const resizeHandler = lift(
    'function resizeTo(height: number): void {',
    '/** Collapse to / expand',
    'function resizeTo(height) {'
  )
  const pageRevealHandler = lift('function revealTopCenterHoverInPage(): void {', 'const revealController')
  // M2-0202 S3: the right-edge open rect (the Reader or the drawer), the show/hide toggle and the blur park.
  const boundsHandler = lift(
    "function rightEdgeBounds(\n  surface: 'open' | 'rest',\n  display: Electron.Display,\n  layout: OverlayLayout = liveOverlayLayout()\n): Electron.Rectangle {",
    '/** The only writer of right-edge window bounds',
    'function rightEdgeBounds(surface, display, layout = liveOverlayLayout()) {'
  )
  const toggleHandler = lift(
    "function toggleOverlayVisibility(reason: Extract<RevealReason, 'hotkey' | 'tray'>): void {",
    'const shortcutActions',
    'function toggleOverlayVisibility(reason) {'
  )
  const blurHandler = lift('function parkRightEdgeReaderOnBlur(): void {', 'function currentRightEdgeSurface')
  const build = new Function(
    ...Object.keys(deps),
    `
    let islandResting = ${rightEdge ? rightEdge.resting : true};
    let settingsSurfaceOpen = false;
    let isMinimized = false;
    let overlayCursorWatchHovering = false;
    let overlayCursorWatchHeldCursor = null;
    let overlayCursorWatchEnteredAt = null;
    let overlayParkLatched = ${rightEdge?.latched === true};
    let rightEdgeUnhoveredRevealAt = ${rightEdge?.unhoveredRevealAt ?? null};
    let currentWidth = 0;
    let lastBarHeight = 120;
    let userAnchorY = 0;
    let overlayCursorWatchTimer = 1;
    function restoreBarWidth() {
      overlayParkLatched = false;
      islandResting = false;
      currentWidth = restoreWindow(${rightEdge ? "rightEdgeBounds('open', screen.getDisplayMatching(win.getBounds()))" : ''});
    }
    ${handler}
    ${parkHandler}
    ${layoutChangeHandler}
    ${moveHandler}
    ${resizeHandler}
    ${pageRevealHandler}
    ${boundsHandler}
    ${toggleHandler}
    ${blurHandler}
    // The reveal controller's restoreInteractiveLayout (a hotkey, tray or relaunch reveal) for this placement.
    function summon() { restoreBarWidth(); revealTopCenterHoverInPage(); }
    function reveal(reason) { noteReveal(reason); summon(); }
    return { tick: tickOverlayCursorWatch, park: parkOverlayAfterHideSpring, layoutChangePark: parkOverlayForLayoutChange, moveBy, resizeTo, summon, toggle: toggleOverlayVisibility, blur: parkRightEdgeReaderOnBlur };
  `
  ) as (...args: unknown[]) => {
    tick: () => void
    park: (force?: boolean) => boolean
    layoutChangePark: () => void
    moveBy: (dx: number, dy: number) => void
    resizeTo: (height: number) => void
    summon: () => void
    toggle: (reason: 'hotkey' | 'tray') => void
    blur: () => void
  }
  const { tick, park, layoutChangePark, moveBy, resizeTo, summon, toggle, blur } = build(...Object.values(deps))
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
    /** A park request: `force` is an explicit Hide, otherwise the page's park after its exit spring. */
    parkAt(at: number, point: { x: number; y: number }, force: boolean): boolean {
      now = at
      cursor = point
      return park(force)
    },
    /** The page's IPC.rightEdgeState report with these pins. */
    pin(pins: RightEdgePin[]): void {
      deps.rightEdgeSession.report({ surface: 'island', contentHeight: 0, pins })
    },
    /** The page's IPC.rightEdgeState report of the surface it renders (M2-0202 S3). */
    report(surface: 'island' | 'reader' | 'rest', pins: RightEdgePin[] = []): void {
      deps.rightEdgeSession.report({ surface, contentHeight: 0, pins })
    },
    /** The window lost focus, with the pointer at `point`. */
    blurAt(at: number, point: { x: number; y: number }): void {
      now = at
      cursor = point
      blur()
    },
    /** The show/hide toggle from the hotkey or the tray. */
    toggleAt(at: number, reason: 'hotkey' | 'tray'): void {
      now = at
      toggle(reason)
    },
    readerPending: () => deps.rightEdgeSession.readerPending(),
    /** The settings-driven re-park after a layout switch (Hide ↔ Island), with the pointer at `point`. */
    layoutChangeAt(at: number, point: { x: number; y: number }): void {
      now = at
      cursor = point
      layoutChangePark()
    },
    /** A drag step (the renderer's windowMoveBy). */
    moveBy(dx: number, dy: number): void {
      moveBy(dx, dy)
    },
    /** A hotkey, tray or relaunch reveal through the reveal controller, with the pointer at `point`. */
    summonAt(at: number, point: { x: number; y: number }): void {
      now = at
      cursor = point
      summon()
    },
    /** The renderer's content-height report (windowResize). */
    resizeTo(height: number): void {
      resizeTo(height)
    },
    band,
    revealed,
    state: () => ({
      bounds,
      parkPending,
      restoreCount,
      notifications: [...notifications],
      setBoundsCalls: [...setBoundsCalls],
      noted: [...noted],
      reveals: [...reveals],
      hotkeys: [...hotkeys]
    })
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

  // Dwell times follow the top-center notch-zone dwell (owner decision OD-23: 250 ms).
  it('leaving before reveal restarts the dwell on the next approach', () => {
    const hover = nativeHover()
    hover.tick(0, 12)
    hover.tick(120, 12)
    hover.tick(144, 600)
    hover.tick(168, 12)
    hover.tick(288, 12)
    expect(hover.state().restoreCount).toBe(0)
    hover.tick(336, 12)
    expect(hover.state().restoreCount).toBe(0)
    hover.tick(168 + TOP_CENTER_REVEAL_DWELL_MS, 12)
    expect(hover.state().restoreCount).toBe(1)
  })

  it('returning to the menu-bar strip during leave grace cancels collapse immediately', () => {
    const hover = nativeHover()
    const at = TOP_CENTER_REVEAL_DWELL_MS
    hover.tick(0, 12)
    hover.tick(at, 12)
    hover.tick(at + 24, 600)
    expect(hover.state().parkPending).toBe(true)
    expect(hover.state().notifications).toEqual([true, false])
    hover.tick(at + 48, 12)
    expect(hover.state().parkPending).toBe(false)
    expect(hover.state().notifications).toEqual([true, false, true])
    expect(hover.state().restoreCount).toBe(1)
    hover.tick(at + 72, 12)
    expect(hover.state().notifications).toEqual([true, false, true])
  })
})

describe('M2-0431 top-center Hide stability (owner decision OD-23: the notch area only)', () => {
  /** Rest `ms` at `point`, one 24 ms watch tick at a time, starting at `from`. Returns the next tick time. */
  const dwell = (
    hover: ReturnType<typeof nativeHover>,
    from: number,
    point: { x: number; y: number },
    ms: number
  ): number => {
    let at = from
    for (; at <= from + ms; at += 24) hover.tickAt(at, point)
    return at
  }
  /** Rest in the notch until the dwell has elapsed (ticks 0..264 ms); the bar is revealed. */
  const revealFromNotch = (hover: ReturnType<typeof nativeHover>): void => {
    for (let at = 0; at <= TOP_CENTER_REVEAL_DWELL_MS + 24; at += 24) hover.tickAt(at, { x: 900, y: 12 })
  }

  it('400 ms stops on menu-bar items outside the notch area never reveal, notify or move the window', () => {
    const hover = nativeHover()
    let at = 0
    for (const stop of [
      { x: 24, y: 12 },
      { x: 1253, y: 27 },
      { x: 1770, y: 8 },
      { x: 24, y: 38 },
      { x: 1770, y: 0 }
    ]) {
      at = dwell(hover, at, stop, 400)
      at = dwell(hover, at, { x: 900, y: 600 }, 48)
    }
    expect(hover.state().restoreCount).toBe(0)
    expect(hover.state().notifications).toEqual([])
    expect(hover.state().bounds).toEqual({ x: 896, y: 0, width: 8, height: 2 })
    expect(hover.state().setBoundsCalls).toEqual([])
  })

  it('the notch area reveals exactly once, only after the 250 ms dwell', () => {
    const hover = nativeHover()
    for (let at = 0; at < TOP_CENTER_REVEAL_DWELL_MS; at += 24) hover.tickAt(at, { x: 900, y: 12 })
    expect(hover.state().restoreCount).toBe(0)
    for (let at = TOP_CENTER_REVEAL_DWELL_MS; at <= 600; at += 24) hover.tickAt(at, { x: 900, y: 12 })
    expect(hover.state().restoreCount).toBe(1)
    expect(hover.state().notifications).toEqual([true])
  })

  it('M2-0431: the cursor watch reports its reveal with cause cursor-watch, and a menu-bar stop reports nothing', () => {
    const hover = nativeHover()
    const next = dwell(hover, 0, { x: 1770, y: 8 }, 400)
    expect(hover.state().noted).toEqual([])
    dwell(hover, next, { x: 900, y: 12 }, TOP_CENTER_REVEAL_DWELL_MS + 48)
    expect(hover.state().restoreCount).toBe(1)
    expect(hover.state().noted).toEqual(['cursor-watch'])
  })

  it('a height collapse under a still pointer does not park; the pointer moving off the bar does', () => {
    const hover = nativeHover()
    revealFromNotch(hover)
    expect(hover.state().restoreCount).toBe(1)
    hover.resizeTo(576)
    // The owner's 09-29 park: the pointer on a 576 px answer, which then shrank to 144 px under it.
    const onAnswer = { x: 524, y: 194 }
    hover.tickAt(300, onAnswer)
    expect(hover.state().parkPending).toBe(false)
    hover.resizeTo(144)
    expect(hover.state().bounds.height).toBe(144)
    hover.tickAt(324, onAnswer)
    hover.tickAt(348, onAnswer)
    expect(hover.state().parkPending).toBe(false)
    expect(hover.state().notifications).toEqual([true])
    hover.tickAt(372, { x: 524, y: 260 })
    expect(hover.state().parkPending).toBe(true)
    expect(hover.state().notifications).toEqual([true, false])
  })

  it('a drag while revealed does not move the bar, and the resize and tick after it do not park', () => {
    const hover = nativeHover()
    revealFromNotch(hover)
    const top = hover.state().bounds.y
    expect(top).toBe(39)
    hover.tickAt(300, { x: 900, y: top + 30 })
    hover.moveBy(0, 150)
    hover.resizeTo(144)
    hover.tickAt(324, { x: 900, y: top + 60 })
    expect(hover.state().parkPending).toBe(false)
    expect(hover.state().bounds.y).toBe(top)
    expect(hover.state().setBoundsCalls.map((b) => b.y)).toEqual([top])
  })

  it('a hotkey or tray reveal of the parked Hide tells the page it is revealed; the pointer staying away never parks it', () => {
    const hover = nativeHover()
    const away = { x: 900, y: 600 }
    hover.summonAt(0, away)
    expect(hover.state().restoreCount).toBe(1)
    expect(hover.state().bounds).toEqual(hover.revealed)
    // Without this the page still believed it was parked and painted the restored bar at opacity 0.
    expect(hover.state().notifications).toEqual([true])
    const at = dwell(hover, 24, away, 2000)
    expect(hover.state().parkPending).toBe(false)
    expect(hover.state().notifications).toEqual([true])
    // A pointer that visits the bar and leaves parks it as usual.
    hover.tickAt(at, { x: 900, y: 80 })
    hover.tickAt(at + 24, away)
    expect(hover.state().parkPending).toBe(true)
    expect(hover.state().notifications).toEqual([true, true, false])
  })

  it('a hotkey or tray reveal leaves the right-edge dock to its own page reveal (M2-0428)', () => {
    const hover = nativeHover({ rightEdge: { resting: true } })
    hover.summonAt(0, { x: 900, y: 600 })
    expect(hover.state().notifications).toEqual([])
  })

  it('a drag never moves the parked Hide window away from the notch', () => {
    const hover = nativeHover()
    hover.moveBy(0, 150)
    hover.moveBy(-60, 0)
    expect(hover.state().bounds).toEqual({ x: 896, y: 0, width: 8, height: 2 })
    expect(hover.state().setBoundsCalls).toEqual([])
    revealFromNotch(hover)
    expect(hover.state().restoreCount).toBe(1)
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

  it('M2-0202 RE-G05: a reveal at wa.bottom−60 (f = 0.15) holds while the pointer moves diagonally into the drawer over 800 ms', () => {
    const hover = nativeHover({ rightEdge: { resting: true } })
    const reveal = { x: edge, y: DISPLAY.workArea.y + DISPLAY.workArea.height - 60 }
    // The drawer opens far above that point: the path to it leaves the band and runs below the drawer.
    expect(reveal.y).toBeGreaterThan(hover.revealed.y + hover.revealed.height + CURSOR_LEAVE_GRACE_PX)
    let at = 0
    for (; at <= 192 && hover.state().restoreCount === 0; at += 24) hover.tickAt(at, reveal)
    expect(hover.state().restoreCount).toBe(1)
    const target = { x: hover.revealed.x + hover.revealed.width / 2, y: hover.revealed.y + hover.revealed.height / 2 }
    for (let t = 24; t <= 800; t += 24, at += 24) {
      hover.tickAt(at, {
        x: Math.round(reveal.x + ((target.x - reveal.x) * t) / 800),
        y: Math.round(reveal.y + ((target.y - reveal.y) * t) / 800)
      })
    }
    expect(hover.state().parkPending).toBe(false)
    expect(hover.state().notifications).toEqual([true])
    // Once the pointer has entered the drawer the corridor is gone: the same spot below the drawer is a leave.
    hover.tickAt(at, { x: target.x + 60, y: reveal.y - 40 })
    expect(hover.state().parkPending).toBe(true)
    expect(hover.state().notifications).toEqual([true, false])
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

  it('a layout switch re-parks without an earlier Hide latch: the next edge approach reveals', () => {
    // Windows packaged smoke RE-HIDE-4: an explicit Hide during a meeting latched with the pointer in the
    // band; the switch to Island re-parked and the pointer returned to the edge before any tick sampled it
    // away, so the stale latch blocked every edge reveal of the Island.
    const hover = nativeHover({ rightEdge: { resting: false } })
    const inBand = { x: edge, y: hover.band.y + Math.round(hover.band.height / 2) }
    hover.hideAt(0, inBand)
    hover.layoutChangeAt(10, { x: 400, y: 500 })
    expect(hover.state().bounds).toEqual(hover.band)
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

  it('RE-P01: while a pin holds the dock, the pointer leaving is reported but never parks it; clearing the pins parks', () => {
    // The owner's D2 path: click into an empty composer (the typing pin), then move the pointer away.
    const hover = nativeHover({ rightEdge: { resting: true } })
    const inBand = { x: edge, y: hover.band.y + Math.round(hover.band.height / 2) }
    const away = { x: 400, y: 500 }
    let at = 0
    for (; at <= 400 && hover.state().restoreCount === 0; at += 24) hover.tickAt(at, inBand)
    expect(hover.state().restoreCount).toBe(1)
    hover.pin(['typing'])
    hover.tickAt(at, away)
    expect(hover.state().notifications).toEqual([true, false])
    expect(hover.state().parkPending).toBe(false)
    // The page's own park after its exit spring is refused as well, and the window stays open.
    expect(hover.parkAt(at + 24, away, false)).toBe(false)
    for (let t = at + 48; t <= at + 8_000; t += 24) hover.tickAt(t, away)
    expect(hover.state().parkPending).toBe(false)
    expect(hover.state().bounds).toEqual(hover.revealed)
    // The pin expires (the page reports no pins): the refused leave-park runs.
    hover.pin([])
    expect(hover.state().parkPending).toBe(true)
  })

  it('RE-P01: the unhovered auto-park waits while a pin is set and fires once the pins clear', () => {
    const hover = nativeHover({ rightEdge: { resting: false, unhoveredRevealAt: 0 } })
    const away = { x: 400, y: 500 }
    hover.pin(['approval'])
    let at = 0
    for (; at <= RIGHT_EDGE_UNHOVERED_REVEAL_GRACE_MS + 2_000; at += 24) hover.tickAt(at, away)
    expect(hover.state().notifications).toEqual([])
    hover.pin([])
    hover.tickAt(at, away)
    expect(hover.state().notifications).toEqual([false])
  })

  it('RE-P01: an explicit Hide parks under every pin except an IME composition', () => {
    for (const pin of RIGHT_EDGE_PINS) {
      const hover = nativeHover({ rightEdge: { resting: false } })
      hover.pin([pin])
      expect(hover.parkAt(0, { x: 400, y: 500 }, true), pin).toBe(pin !== 'ime')
      expect(hover.state().bounds, pin).toEqual(pin === 'ime' ? hover.revealed : hover.band)
    }
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

describe('right-edge Reader (M2-0202 S3, RE-P01 Reader rows)', () => {
  const edge = DISPLAY.bounds.x + DISPLAY.bounds.width - 1
  const away = { x: 400, y: 500 }
  const READER = readerRect(DISPLAY.workArea)

  it('while the Reader is open the watch stands down: no leave, no unhovered auto-park, no dwell park', () => {
    const hover = nativeHover({ rightEdge: { resting: false, unhoveredRevealAt: 0 } })
    hover.report('reader')
    for (let at = 0; at <= RIGHT_EDGE_UNHOVERED_REVEAL_GRACE_MS + 8_000; at += 24) hover.tickAt(at, away)
    expect(hover.state().notifications).toEqual([])
    expect(hover.state().parkPending).toBe(false)
    expect(hover.state().setBoundsCalls).toEqual([])
    // The page's own pointer park after its exit spring is refused too, and a pin clearing never parks it.
    expect(hover.parkAt(9_000, away, false)).toBe(false)
    hover.report('reader', ['typing'])
    hover.report('reader')
    expect(hover.state().parkPending).toBe(false)
    expect(hover.state().bounds).toEqual(hover.revealed)
  })

  it('the explicit Hide parks the Reader and the next hotkey toggle restores it, without the ask input', () => {
    const hover = nativeHover({ rightEdge: { resting: false } })
    hover.report('reader')
    hover.hideAt(0, away)
    expect(hover.state().bounds).toEqual(hover.band)
    hover.report('rest')
    hover.toggleAt(2_000, 'hotkey')
    expect(hover.state().reveals).toEqual(['hotkey'])
    expect(hover.state().bounds).toEqual(READER)
    expect(hover.state().hotkeys).toEqual([])
  })

  it('blur, then the hotkey within 500 ms → Reader restored', () => {
    const hover = nativeHover({ rightEdge: { resting: false } })
    hover.report('reader')
    hover.blurAt(1_000, away)
    expect(hover.state().bounds).toEqual(hover.band)
    hover.report('rest')
    expect(hover.readerPending()).toBe(true)
    hover.toggleAt(1_000 + RE_BLUR_TOGGLE_GRACE_MS - 100, 'hotkey')
    expect(hover.state().reveals).toEqual(['hotkey'])
    expect(hover.state().bounds).toEqual(READER)
  })

  it('blur, then a tray toggle within the grace is that same Hide; a later tray toggle restores the Reader', () => {
    const hover = nativeHover({ rightEdge: { resting: false } })
    hover.report('reader')
    hover.blurAt(1_000, away)
    hover.report('rest')
    hover.toggleAt(1_000 + RE_BLUR_TOGGLE_GRACE_MS - 100, 'tray')
    expect(hover.state().reveals).toEqual([])
    expect(hover.state().bounds).toEqual(hover.band)
    hover.toggleAt(1_000 + RE_BLUR_TOGGLE_GRACE_MS + 400, 'tray')
    expect(hover.state().reveals).toEqual(['tray'])
    expect(hover.state().bounds).toEqual(READER)
  })

  it('a blur with the island open (no Reader) parks nothing', () => {
    const hover = nativeHover({ rightEdge: { resting: false } })
    hover.report('island')
    hover.blurAt(1_000, away)
    expect(hover.state().bounds).toEqual(hover.revealed)
  })

  it('a pointer on the band reveals the island over a parked Reader, which then follows the ordinary leave rule', () => {
    const hover = nativeHover({ rightEdge: { resting: false } })
    hover.report('reader')
    hover.hideAt(0, away)
    hover.report('rest')
    const inBand = { x: edge, y: hover.band.y + Math.round(hover.band.height / 2) }
    let at = 1_000
    for (; at <= 1_400 && hover.state().restoreCount === 0; at += 24) hover.tickAt(at, inBand)
    expect(hover.state().bounds).toEqual(hover.revealed)
    expect(hover.readerPending()).toBe(false)
    hover.tickAt(at + 24, away)
    expect(hover.state().parkPending).toBe(true)
  })
})
