import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { transformWithEsbuild } from 'vite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sourceIndexOf } from '../../scripts/lib/source-layout'
import {
  clampAxis,
  clampAxisMargin,
  clampHeight as islandClampHeight,
  hideParkWindowOpacity,
  hoverWatchRestRect,
  isReachable as islandIsReachable,
  overlayPlacementPosition,
  parkAfterExclusiveOnboarding,
  parkedHoverReanchor,
  recenterXForWidth,
  refitToDisplay as islandRefitToDisplay,
  resolveOverlayPlacement,
  rightAnchoredParkPosition,
  rightEdgeParkLayout,
  type DisplayMetrics
} from './island/geometry'
import { pointInRect } from './island/cursor-watch'
import { revealOverlaySurface } from './island/overlay-surface'
import { createRightEdgeAnchors } from './island/right-edge-anchor'
import { crashDetail } from './infra/observability/crash-taxonomy'
import { overlayUsesHover } from '@shared/overlay-chrome'
import { overlayDisplayKey } from '@shared/overlay-placement'
import {
  anchorFraction,
  anchorY,
  legacyDrawerRect,
  legacyTabCentreY,
  legacyTabRect,
  revealBand,
  type Rect as EdgeRect
} from '@shared/right-edge-geometry'

/**
 * Source-contract tests for the overlay-placement findings (MQA-196, MQA-197). src/main/index.ts boots
 * Electron at import time and both seams are closures inside a window-event callback / an app-scoped
 * screen listener, so the established pattern applies (index-audit-fixes.contract.test.ts,
 * main-lifecycle.contract.test.ts, c-main-fixes.contract.test.ts): lift the real source out of index.ts
 * and RUN it against stubs, so the assertions exercise the shipped arithmetic rather than its shape.
 *
 * The island positioning math itself now lives in the PURE `island/geometry.ts` module (Phase 1 of the
 * Métis rebuild) and is covered directly by geometry.test.ts; index.ts's `clampHeight`/`isReachable`/
 * `refitToDisplay` are thin wrappers that resolve the live `screen.*` display and forward to it. These
 * tests lift the wrappers + their callers (moveBy, registerScreenListeners, setWindowMode) and inject the
 * REAL geometry functions as stubs — so what runs here is still the shipped wiring end-to-end, just with
 * the already-covered pure math imported instead of re-sliced.
 */
const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8')

/** Slice the source from `from` up to (excluding) the next occurrence of `to`. Sliced inside each test so
 *  one drifted marker reports as its own failure instead of aborting collection for the whole file. */
function sliceBetween(from: string, to: string): string {
  const start = sourceIndexOf(indexSrc, from)
  expect(start, `marker not found: ${from}`).toBeGreaterThan(-1)
  const end = sourceIndexOf(indexSrc, to, start + 1)
  expect(end, `end marker not found after ${from}: ${to}`).toBeGreaterThan(-1)
  return indexSrc.slice(start, end)
}

/** Compile a lifted slice (real TypeScript, annotations and all) down to runnable JS with the same
 *  esbuild Vite/Vitest already use to load this repo — so what runs here is the shipped code, not a
 *  hand-stripped approximation of it. No new dependency: `vite` is already a devDependency. */
async function toJs(ts: string): Promise<string> {
  const { code } = await transformWithEsbuild(ts, 'lifted.ts', { loader: 'ts' })
  return code
}

const constant = (name: string): number => {
  const m = new RegExp(`^const ${name} = (\\d+)`, 'm').exec(indexSrc)
  expect(m, `constant not found: ${name}`).not.toBeNull()
  return Number(m?.[1])
}

describe('MQA-196 — a renderer crash restores the overlay geometry, not just the meeting state', () => {
  type OverlayState = {
    listeningActive: boolean
    lastPlainAskAt: number
    audioArmed: boolean
    isMinimized: boolean
    currentWidth: number
  }

  /** Run the real `render-process-gone` handler over module-scope state seeded to what the crash would
   *  have found, and hand back that state afterwards. */
  async function crash(before: OverlayState): Promise<OverlayState> {
    const body = await toJs(
      sliceBetween(
        "win.webContents.on('render-process-gone', (_e, details) => {",
        'const rendererUrl = overlayRendererUrl()'
      )
    )
    const preamble = [
      'const { mainLog, auditLog, crashDetail, resetDustConversation, setTrayRecording, setRecordingPowerSaveBlock, discardActiveLiveSpeakerSession, invalidateCloudSttOwner, commandControl, responsiveness, before } = stubs',
      `const BAR_WIDTH = ${constant('BAR_WIDTH')}`,
      'let { listeningActive, lastPlainAskAt, audioArmed, isMinimized, currentWidth } = before',
      'const setListeningActive = (on) => { listeningActive = on }',
      'const setAudioArmed = (on) => { audioArmed = on }',
      'let handler = null',
      // isDestroyed() -> true stops the handler before the reload, which needs a real BrowserWindow. The
      // reload itself is already pinned by c-main-fixes.contract.test.ts; this is about the reset above it.
      'const win = { webContents: { on: (evt, fn) => { if (evt === "render-process-gone") handler = fn } }, isDestroyed: () => true }',
      'const self = win',
      // Captured beside `const self = win` in main, outside this handler, because the real callback runs
      // after the WebContents is gone (MQA-340).
      'const selfWebContentsId = 1',
      'const onboardingExclusiveLive = () => false',
      'const overlayRendererUrl = () => "file:///fixture/renderer/index.html"',
      ''
    ].join('\n')
    const driver = [
      '',
      'if (!handler) throw new Error("render-process-gone handler was never registered")',
      'handler({}, { reason: "crashed", exitCode: 133 })',
      'return { listeningActive, lastPlainAskAt, audioArmed, isMinimized, currentWidth }'
    ].join('\n')
    const run = new Function('stubs', preamble + body + driver) as (stubs: unknown) => OverlayState
    const revokeForLifecycleEvent = vi.fn()
    const after = run({
      mainLog: { error: () => {} },
      auditLog: () => {},
      crashDetail,
      resetDustConversation: () => {},
      setTrayRecording: () => {},
      setRecordingPowerSaveBlock: () => {},
      discardActiveLiveSpeakerSession: () => {},
      invalidateCloudSttOwner: () => {},
      commandControl: { revokeForLifecycleEvent },
      responsiveness: { markGone: () => {} },
      before
    })
    expect(revokeForLifecycleEvent).toHaveBeenCalledExactlyOnceWith('renderer_replaced')
    return after
  }

  /** The overlay collapsed to the control mini-pill: isMinimized true, and currentWidth already narrowed
   *  past PILL_WIDTH by the pill's own [data-hug-width] report (index.ts, IPC.windowResize). */
  const collapsed = (): OverlayState => ({
    listeningActive: true,
    lastPlainAskAt: 1_700_000_000_000,
    audioArmed: true,
    isMinimized: true,
    currentWidth: 130
  })

  it('MQA-196 — a crash while collapsed to the mini-pill recovers at full bar width', async () => {
    // Recovery reloads the SAME window, so createWindow()'s crash guard (which resets exactly these two)
    // never runs. The remounted App renders the full Bar and its mount effect calls windowMode('bar') ->
    // setBounds({ width: currentWidth }); with a stale pill width the recovered bar is squeezed to a
    // ~130px sliver, and resizable:false leaves the user no way to drag it back.
    const after = await crash(collapsed())
    expect(after.isMinimized).toBe(false)
    expect(after.currentWidth).toBe(constant('BAR_WIDTH'))
  })

  it('MQA-196 — still clears the meeting state MQA-038 reset', async () => {
    const after = await crash(collapsed())
    expect(after.listeningActive).toBe(false)
    expect(after.lastPlainAskAt).toBe(0)
    expect(after.audioArmed).toBe(false)
  })
})

describe('MQA-197 — the overlay height is re-clamped whenever it changes display', () => {
  type Rect = { x: number; y: number; width: number; height: number }
  type Display = { id: number; workArea: Rect }

  /** Minimal stand-in for Electron's `screen`: getDisplayMatching picks the largest-overlap display
   *  (falling back to the first), which is the behaviour the placement math relies on. */
  function fakeScreen(displays: Display[]): {
    on: (evt: string, fn: () => void) => void
    getAllDisplays: () => Display[]
    getDisplayMatching: (r: Rect) => Display
    fire: (evt: string) => void
  } {
    const listeners: Record<string, () => void> = {}
    return {
      on: (evt, fn) => {
        listeners[evt] = fn
      },
      getAllDisplays: () => displays,
      getDisplayMatching: (r) => {
        let best = displays[0]
        let bestArea = -1
        for (const d of displays) {
          const w = Math.max(0, Math.min(r.x + r.width, d.workArea.x + d.workArea.width) - Math.max(r.x, d.workArea.x))
          const h = Math.max(
            0,
            Math.min(r.y + r.height, d.workArea.y + d.workArea.height) - Math.max(r.y, d.workArea.y)
          )
          if (w * h > bestArea) {
            bestArea = w * h
            best = d
          }
        }
        return best
      },
      fire: (evt) => {
        expect(listeners[evt], `no screen listener registered for ${evt}`).toBeTypeOf('function')
        listeners[evt]()
      }
    }
  }

  /** Lift the whole placement block (clampAxis .. registerScreenListeners) and run it over a fake window
   *  and a fake screen. */
  async function overlay(
    bounds: Rect,
    screen: ReturnType<typeof fakeScreen>
  ): Promise<{ bounds: () => Rect; moveBy: (dx: number, dy: number) => void }> {
    // Starts at the clampHeight wrapper (clampAxis/clampAxisMargin are now direct imports from
    // island/geometry.ts, not local functions — nothing left to lift for them).
    const region = await toJs(
      sliceBetween('function clampHeight(height: number, areaHeight: number): number {', 'function toggleVisible(')
    )
    const preamble = [
      'const { screen, start, BAR_MIN_HEIGHT, DRAG_VISIBLE_MARGIN, islandClampHeight, islandIsReachable, islandRefitToDisplay, clampAxis, clampAxisMargin, overlayUsesHover } = stubs',
      'let current = { ...start }',
      'let userAnchorY = null',
      'const win = { getBounds: () => ({ ...current }), setBounds: (b) => { current = { ...current, ...b } } }',
      'const ensureWindow = () => win',
      'const onboardingExclusiveLive = () => false',
      'const islandResting = false',
      'const settingsSurfaceOpen = false',
      'const liveOverlayLayout = () => "bar"',
      'const resolvedOverlayPlacementForDisplay = () => "top-center"',
      'const rightEdgeYForDisplay = () => undefined',
      'const parkedHoverReanchor = () => null',
      'const getDisplayMetrics = () => ({})',
      'const ISLAND_TOP_MARGIN = 8',
      'let overlayCursorWatchHovering = false',
      'function parkOverlayAfterHideSpring() {}',
      ''
    ].join('\n')
    const driver = ['', 'registerScreenListeners()', 'return { bounds: () => current, moveBy }'].join('\n')
    const run = new Function('stubs', preamble + region + driver) as (stubs: unknown) => {
      bounds: () => Rect
      moveBy: (dx: number, dy: number) => void
    }
    return run({
      screen,
      start: bounds,
      BAR_MIN_HEIGHT: constant('BAR_MIN_HEIGHT'),
      DRAG_VISIBLE_MARGIN: constant('DRAG_VISIBLE_MARGIN'),
      islandClampHeight,
      islandIsReachable,
      islandRefitToDisplay,
      clampAxis,
      clampAxisMargin,
      overlayUsesHover
    })
  }

  const RETINA: Display = { id: 1, workArea: { x: 0, y: 0, width: 3840, height: 2112 } }
  const LAPTOP_ALONE: Display = { id: 2, workArea: { x: 0, y: 0, width: 1920, height: 1032 } }
  const LAPTOP_RIGHT: Display = { id: 2, workArea: { x: 3840, y: 0, width: 1920, height: 1032 } }
  /** What resizeTo leaves a full-height post-meeting Review at on the 4K: workArea.height - 48. */
  const TALL = RETINA.workArea.height - 48

  it('MQA-197 — an unplugged tall monitor leaves a height the remaining display can actually show', async () => {
    // The window still overlaps the laptop's work area, so the reachability guard skips it — which is
    // exactly why the height clamp has to run BEFORE that guard, not after it.
    const screen = fakeScreen([LAPTOP_ALONE])
    const win = await overlay({ x: 500, y: 0, width: 880, height: TALL }, screen)
    screen.fire('display-removed')
    const b = win.bounds()
    expect(b.height).toBeLessThanOrEqual(LAPTOP_ALONE.workArea.height - 48)
    expect(b.y + b.height).toBeLessThanOrEqual(LAPTOP_ALONE.workArea.y + LAPTOP_ALONE.workArea.height)
  })

  it('MQA-197 — dragging onto a shorter monitor re-clamps the height to that monitor', async () => {
    const screen = fakeScreen([RETINA, LAPTOP_RIGHT])
    const win = await overlay({ x: 3000, y: 0, width: 880, height: TALL }, screen)
    win.moveBy(900, 0) // across the seam onto the laptop
    const b = win.bounds()
    expect(b.x).toBe(3900)
    expect(b.height).toBeLessThanOrEqual(LAPTOP_RIGHT.workArea.height - 48)
    expect(b.y + b.height).toBeLessThanOrEqual(LAPTOP_RIGHT.workArea.y + LAPTOP_RIGHT.workArea.height)
  })

  it('MQA-197 — a drag that stays on one display still moves freely and keeps its height', async () => {
    const screen = fakeScreen([RETINA, LAPTOP_RIGHT])
    const win = await overlay({ x: 1000, y: 120, width: 880, height: 1400 }, screen)
    win.moveBy(60, -40)
    expect(win.bounds()).toMatchObject({ x: 1060, y: 80, height: 1400 })
  })

  it('MQA-197 — a window stranded off every display is still pulled back in', async () => {
    // The pre-existing reanchor contract: it must keep working, not be traded for the height clamp.
    const screen = fakeScreen([LAPTOP_ALONE])
    const win = await overlay({ x: 6000, y: 4000, width: 880, height: 600 }, screen)
    screen.fire('display-metrics-changed')
    const b = win.bounds()
    expect(b.x).toBeLessThanOrEqual(LAPTOP_ALONE.workArea.width - b.width)
    expect(b.y).toBeLessThanOrEqual(LAPTOP_ALONE.workArea.height - b.height)
  })

  it('MQA-197 — restoring the bar cannot re-apply a height measured on a taller display', async () => {
    // setWindowMode writes lastBarHeight straight back; the renderer fires windowMode('bar') on every
    // mount (including the reload after a renderer crash), which can land after the overlay has moved.
    const region = await toJs(sliceBetween('function setWindowMode(): void {', '/** Self-heal a null `win`'))
    const preamble = [
      'const { screen, clampHeight, recenterXForWidth, rememberBarContentHeight } = stubs',
      'let current = { x: 0, y: 0, width: 880, height: 400 }',
      'const win = { getBounds: () => ({ ...current }), setBounds: (b) => { current = { ...current, ...b } }, setBackgroundColor: () => {} }',
      'const currentWidth = 880',
      `const lastBarHeight = ${TALL}`,
      'const BAR_IDLE_HEIGHT_PX = 84',
      'const OVERLAY_REST_BACKGROUND = "#00000000"',
      'const onboardingExclusiveLive = () => false',
      'const islandResting = false',
      'const createRevealTrace = () => ({ trace: (_reason, reveal) => reveal() })',
      'const auditLog = () => {}',
      'const liveOverlayLayout = () => "bar"',
      'const resolvedOverlayPlacementForDisplay = () => "top-center"',
      ''
    ].join('\n')
    const run = new Function('stubs', preamble + region + '\nsetWindowMode()\nreturn current') as (
      stubs: unknown
    ) => Rect
    const height = run({
      screen: fakeScreen([LAPTOP_ALONE]),
      clampHeight: (h: number, areaHeight: number) => Math.min(h, areaHeight - 48),
      recenterXForWidth,
      rememberBarContentHeight: (h: number) => h
    }).height
    expect(height).toBeLessThanOrEqual(LAPTOP_ALONE.workArea.height - 48)
  })
})

/**
 * M2-0202 RE-G10: every right-edge setBounds goes through applyRightEdgeBounds, and windowResize never changes
 * right-edge bounds. The shipped right-edge paths are lifted out of index.ts and run over a fake window and
 * screen with the real geometry and anchor modules; applyRightEdgeBounds is wrapped after lifting, so every
 * native write records whether it ran inside it.
 */
describe('M2-0202 RE-G10 — right-edge window bounds have one writer', () => {
  const wa = (width: number, height: number, x = 0, y = 0): EdgeRect => ({ x, y, width, height })
  const right = (r: EdgeRect): number => r.x + r.width
  const bottom = (r: EdgeRect): number => r.y + r.height

  interface Display {
    id: number
    bounds: EdgeRect
    workArea: EdgeRect
  }
  interface Write {
    kind: 'setBounds' | 'setPosition'
    rect: EdgeRect
    insideApply: boolean
  }
  interface Harness {
    bounds: () => EdgeRect
    writes: Write[]
    settings: Record<string, unknown>
    settingsWrites: Array<Record<string, unknown>>
    setDisplays: (next: Display[]) => void
    fire: (event: string) => void
    run: Record<string, (...args: unknown[]) => unknown>
    setResting: (resting: boolean) => void
  }

  afterEach(() => vi.useRealTimers())

  async function harness(options: {
    displays: Display[]
    layout?: 'hide' | 'island'
    resting?: boolean
    settings?: Record<string, unknown>
    lockedKeys?: string[]
    start?: EdgeRect
  }): Promise<Harness> {
    const lifted = await toJs(
      [
        sliceBetween('function commitParkedOverlayBounds(', 'function stopExclusiveBoundsWatch'),
        sliceBetween('const rightEdgeAnchors = createRightEdgeAnchors({', 'function overlayCursorWatchWanted'),
        sliceBetween('function anchorTopCenter(): void {', 'function applySettingsSurface('),
        sliceBetween('function setWindowMode(): void {', 'const reveals = createRevealTrace'),
        sliceBetween('function moveBy(dx: number, dy: number): void {', 'function toggleVisible('),
        sliceBetween('function resizeTo(height: number): void {', '/** Collapse to / expand'),
        sliceBetween('ipcMain.handle(IPC.windowResize,', 'ipcMain.handle(IPC.windowMode')
      ].join('\n')
    )
    let displays = options.displays
    let current: EdgeRect = options.start ?? { x: 0, y: 0, width: 4, height: 4 }
    let depth = 0
    const writes: Write[] = []
    const listeners: Record<string, () => void> = {}
    const handlers: Record<string, (...args: unknown[]) => unknown> = {}
    const settings: Record<string, unknown> = {
      overlayRightEdgeAnchorByDisplay: {},
      overlayRightEdgeYByDisplay: {},
      ...options.settings
    }
    const settingsWrites: Array<Record<string, unknown>> = []
    const overlap = (a: EdgeRect, b: EdgeRect): number =>
      Math.max(0, Math.min(right(a), right(b)) - Math.max(a.x, b.x)) *
      Math.max(0, Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y))
    const metrics = (d: Display): DisplayMetrics => ({
      bounds: d.bounds,
      workArea: d.workArea,
      hasNotch: false,
      notchWidth: 0,
      menuBarHeight: 0,
      source: 'heuristic'
    })
    const win = {
      isDestroyed: () => false,
      isVisible: () => true,
      showInactive: () => {},
      getBounds: () => ({ ...current }),
      setBounds: (rect: EdgeRect) => {
        current = { ...rect }
        writes.push({ kind: 'setBounds', rect: { ...rect }, insideApply: depth > 0 })
      },
      setPosition: (x: number, y: number) => {
        current = { ...current, x, y }
        writes.push({ kind: 'setPosition', rect: { ...current }, insideApply: depth > 0 })
      },
      setAlwaysOnTop: () => {},
      setBackgroundColor: () => {},
      getBackgroundColor: () => '#000000',
      setOpacity: () => {},
      getOpacity: () => 1,
      setIgnoreMouseEvents: () => {}
    }
    const stubs = {
      win,
      screen: {
        getDisplayMatching: (rect: EdgeRect) =>
          displays.reduce(
            (best, d) => (overlap(rect, d.workArea) > overlap(rect, best.workArea) ? d : best),
            displays[0]
          ),
        getAllDisplays: () => displays,
        getCursorScreenPoint: () => ({ x: 0, y: 0 }),
        on: (event: string, fn: () => void) => {
          listeners[event] = fn
        }
      },
      ipcMain: {
        handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
          handlers[channel] = fn
        }
      },
      IPC: { windowResize: 'window:resize' },
      assertMainWindow: () => {},
      getSettings: () => settings,
      setSettings: (patch: Record<string, unknown>) => {
        settingsWrites.push(patch)
        Object.assign(settings, patch)
      },
      getLockedKeys: () => options.lockedKeys ?? [],
      createRightEdgeAnchors,
      mainLog: { warn: () => {}, info: () => {} },
      liveOverlayPlacement: () => 'right-edge',
      liveOverlayLayout: () => options.layout ?? 'hide',
      resolvedOverlayPlacementForDisplay: (d: Display) => resolveOverlayPlacement('right-edge', metrics(d)),
      getDisplayMetrics: metrics,
      onboardingExclusiveLive: () => false,
      overlayUsesHover,
      overlayPlacementPosition,
      parkAfterExclusiveOnboarding,
      parkedHoverReanchor,
      hoverWatchRestRect,
      rightEdgeParkLayout,
      rightAnchoredParkPosition,
      hideParkWindowOpacity,
      revealOverlaySurface,
      pointInRect,
      ensureWindow: () => win,
      cancelOverlayLeavePark: () => {},
      applyHideClickThrough: () => {},
      applyOverlaySurfaceChrome: () => {},
      parkOverlayAfterHideSpring: () => {},
      rememberBarContentHeight: (h: number) => h,
      ISLAND_TOP_MARGIN: 8,
      BAR_IDLE_HEIGHT_PX: 84,
      BAR_HEIGHT: 120,
      OVERLAY_REST_BACKGROUND: '#00000000',
      enterDepth: () => {
        depth += 1
      },
      leaveDepth: () => {
        depth -= 1
      }
    }
    const body = [
      `const { ${Object.keys(stubs).join(', ')} } = stubs`,
      `let islandResting = ${options.resting ?? false}`,
      'let settingsSurfaceOpen = false',
      'let isMinimized = false',
      'let currentWidth = 0',
      'let userAnchorY = null',
      'let lastBarHeight = 120',
      'let overlayCursorWatchHovering = false',
      'let overlayParkLatched = false',
      lifted,
      'const shippedApply = applyRightEdgeBounds',
      'applyRightEdgeBounds = function (...args) { enterDepth(); try { return shippedApply(...args) } finally { leaveDepth() } }',
      'registerScreenListeners()',
      'return {',
      '  run: { commitParkedOverlayBounds, parkedOverlayBounds, restoreBarWidth, repairOverlayBoundsForReveal, setWindowMode, anchorTopCenter, moveBy, resizeTo, rightEdgeAnchorY: (d) => rightEdgeAnchors.y(d) },',
      '  setResting: (resting) => { islandResting = resting }',
      '}'
    ].join('\n')
    const built = new Function('stubs', body)(stubs) as Pick<Harness, 'run' | 'setResting'>
    return {
      ...built,
      run: { ...built.run, windowResize: (payload: unknown) => handlers['window:resize']({}, payload) },
      bounds: () => ({ ...current }),
      writes,
      settings,
      settingsWrites,
      setDisplays: (next) => {
        displays = next
      },
      fire: (event) => listeners[event]()
    }
  }

  const DISPLAY: Display = { id: 1, bounds: wa(1440, 900), workArea: wa(1440, 875, 0, 25) }

  it('parks, reveals, drags, re-anchors and re-modes only through applyRightEdgeBounds, at the authority rects', async () => {
    const h = await harness({ displays: [DISPLAY], layout: 'island', resting: true })
    vi.useFakeTimers()
    const area = DISPLAY.workArea
    const a = anchorY(area)
    h.run.commitParkedOverlayBounds(h.run.parkedOverlayBounds('island', DISPLAY))
    expect(h.bounds()).toEqual(legacyTabRect(area, a))
    h.setResting(false)
    h.run.restoreBarWidth()
    expect(h.bounds()).toEqual(legacyDrawerRect(area, a))
    h.run.repairOverlayBoundsForReveal()
    h.run.setWindowMode()
    h.run.anchorTopCenter()
    expect(h.bounds()).toEqual(legacyDrawerRect(area, a))
    // A header drag changes only A: the drawer moves, and the parked tab follows the same anchor.
    h.run.moveBy(0, 40)
    expect(h.bounds()).toEqual(legacyDrawerRect(area, a + 40))
    expect(h.run.rightEdgeAnchorY(DISPLAY)).toBe(a + 40)
    h.setResting(true)
    h.run.commitParkedOverlayBounds(h.run.parkedOverlayBounds('island', DISPLAY))
    expect(h.bounds()).toEqual(legacyTabRect(area, a + 40))
    // A drag of the parked tab moves the tab (spec v3 §2: through legacyTabRect(A), not the old normalized Y).
    h.run.moveBy(0, 30)
    expect(h.bounds()).toEqual(legacyTabRect(area, a + 70))
    // Persisted once, after the drag settles, as the anchor fraction; the legacy key is untouched.
    expect(h.settingsWrites).toEqual([])
    vi.advanceTimersByTime(350)
    expect(h.settingsWrites).toEqual([
      { overlayRightEdgeAnchorByDisplay: { [overlayDisplayKey(1) as string]: anchorFraction(area, a + 70) } }
    ])
    expect(h.settings.overlayRightEdgeYByDisplay).toEqual({})
    // A display change re-anchors the rest, then the open drawer, at the stored anchor on the new work area.
    const smaller: Display = { id: 1, bounds: wa(1024, 576), workArea: wa(1024, 528) }
    h.setDisplays([smaller])
    h.fire('display-metrics-changed')
    const f = anchorFraction(area, a + 70)
    expect(h.bounds()).toEqual(legacyTabRect(smaller.workArea, anchorY(smaller.workArea, f)))
    h.setResting(false)
    h.fire('display-removed')
    expect(h.bounds()).toEqual(legacyDrawerRect(smaller.workArea, anchorY(smaller.workArea, f)))
    expect(h.writes.length).toBeGreaterThan(0)
    expect(h.writes.filter((write) => !write.insideApply)).toEqual([])
  })

  it('parks Hide on the reveal band through the same writer', async () => {
    const h = await harness({ displays: [DISPLAY], layout: 'hide', resting: true })
    h.run.commitParkedOverlayBounds(h.run.parkedOverlayBounds('hide', DISPLAY))
    expect(h.bounds()).toEqual(revealBand(DISPLAY.workArea, anchorY(DISPLAY.workArea)))
    expect(h.writes.every((write) => write.insideApply)).toBe(true)
  })

  it('windowResize and resizeTo never change right-edge bounds', async () => {
    const h = await harness({ displays: [DISPLAY], layout: 'island' })
    h.run.restoreBarWidth()
    const open = h.bounds()
    const before = h.writes.length
    for (const payload of [{ height: 900 }, { height: 40, width: 220 }, { height: Number.NaN }])
      h.run.windowResize(payload)
    h.run.resizeTo(900)
    expect(h.writes.length).toBe(before)
    expect(h.bounds()).toEqual(open)
  })

  it('RE-G04: a legacy-only display converts on its first resolve, and a display absent at upgrade on first attach', async () => {
    const legacy = { 'display:1': 0.5, 'display:2': 0.25 }
    const h = await harness({
      displays: [DISPLAY],
      layout: 'island',
      resting: true,
      settings: { overlayRightEdgeYByDisplay: legacy }
    })
    h.run.commitParkedOverlayBounds(h.run.parkedOverlayBounds('island', DISPLAY))
    const tab = h.bounds()
    expect(Math.abs(tab.y + tab.height / 2 - legacyTabCentreY(DISPLAY.workArea, 0.5))).toBeLessThanOrEqual(1)
    expect(Object.keys(h.settings.overlayRightEdgeAnchorByDisplay as object)).toEqual(['display:1'])
    // Display 2 was not attached at upgrade: it converts when the window first lands on it.
    const second: Display = { id: 2, bounds: wa(1920, 1080, 1440, 0), workArea: wa(1920, 1040, 1440, 0) }
    h.setDisplays([second])
    h.fire('display-removed')
    expect(Object.keys(h.settings.overlayRightEdgeAnchorByDisplay as object).sort()).toEqual(['display:1', 'display:2'])
    const secondTab = h.bounds()
    expect(Math.abs(secondTab.y + secondTab.height / 2 - legacyTabCentreY(second.workArea, 0.25))).toBeLessThanOrEqual(
      1
    )
    // Each display migrated exactly once; the legacy key stays read-only.
    expect(h.settingsWrites).toHaveLength(2)
    expect(h.settings.overlayRightEdgeYByDisplay).toEqual(legacy)
  })

  it('RE-G04: a lock on the old key locks the new one: no migration write, no persisted drag', async () => {
    const h = await harness({
      displays: [DISPLAY],
      layout: 'island',
      settings: { overlayRightEdgeYByDisplay: { 'display:1': 0.5 } },
      lockedKeys: ['overlayRightEdgeYByDisplay']
    })
    vi.useFakeTimers()
    h.run.restoreBarWidth()
    const open = h.bounds()
    h.run.moveBy(0, 60)
    vi.advanceTimersByTime(1000)
    expect(h.settingsWrites).toEqual([])
    expect(h.bounds()).toEqual(open)
  })
})
