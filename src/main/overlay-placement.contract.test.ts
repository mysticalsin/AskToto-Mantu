import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { transformWithEsbuild } from 'vite'
import { describe, expect, it } from 'vitest'

/**
 * Source-contract tests for the overlay-placement findings (MQA-196, MQA-197). src/main/index.ts boots
 * Electron at import time and both seams are closures inside a window-event callback / an app-scoped
 * screen listener, so the established pattern applies (index-audit-fixes.contract.test.ts,
 * main-lifecycle.contract.test.ts, c-main-fixes.contract.test.ts): lift the real source out of index.ts
 * and RUN it against stubs, so the assertions exercise the shipped arithmetic rather than its shape.
 */
const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8')

/** Slice the source from `from` up to (excluding) the next occurrence of `to`. Sliced inside each test so
 *  one drifted marker reports as its own failure instead of aborting collection for the whole file. */
function sliceBetween(from: string, to: string): string {
  const start = indexSrc.indexOf(from)
  expect(start, `marker not found: ${from}`).toBeGreaterThan(-1)
  const end = indexSrc.indexOf(to, start)
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
        '// Dev-only: screenshot ONLY this window'
      )
    )
    const preamble = [
      'const { mainLog, auditLog, resetDustConversation, setTrayRecording, setRecordingPowerSaveBlock, before } = stubs',
      `const BAR_WIDTH = ${constant('BAR_WIDTH')}`,
      'let { listeningActive, lastPlainAskAt, audioArmed, isMinimized, currentWidth } = before',
      'let handler = null',
      // isDestroyed() -> true stops the handler before the reload, which needs a real BrowserWindow. The
      // reload itself is already pinned by c-main-fixes.contract.test.ts; this is about the reset above it.
      'const win = { webContents: { on: (evt, fn) => { if (evt === "render-process-gone") handler = fn } }, isDestroyed: () => true }',
      ''
    ].join('\n')
    const driver = [
      '',
      'if (!handler) throw new Error("render-process-gone handler was never registered")',
      'handler({}, { reason: "crashed", exitCode: 133 })',
      'return { listeningActive, lastPlainAskAt, audioArmed, isMinimized, currentWidth }'
    ].join('\n')
    const run = new Function('stubs', preamble + body + driver) as (stubs: unknown) => OverlayState
    return run({
      mainLog: { error: () => {} },
      auditLog: () => {},
      resetDustConversation: () => {},
      setTrayRecording: () => {},
      setRecordingPowerSaveBlock: () => {},
      before
    })
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
    const region = await toJs(sliceBetween('function clampAxis(pos: number', 'function toggleVisible('))
    const preamble = [
      'const { screen, start, BAR_MIN_HEIGHT } = stubs',
      'let current = { ...start }',
      'const win = { getBounds: () => ({ ...current }), setBounds: (b) => { current = { ...current, ...b } } }',
      'const ensureWindow = () => win',
      ''
    ].join('\n')
    const driver = ['', 'registerScreenListeners()', 'return { bounds: () => current, moveBy }'].join('\n')
    const run = new Function('stubs', preamble + region + driver) as (stubs: unknown) => {
      bounds: () => Rect
      moveBy: (dx: number, dy: number) => void
    }
    return run({ screen, start: bounds, BAR_MIN_HEIGHT: constant('BAR_MIN_HEIGHT') })
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
    const region = await toJs(
      sliceBetween('function setWindowMode(): void {', '/** Self-heal a null `win`')
    )
    const preamble = [
      'const { screen, clampHeight } = stubs',
      'let current = { x: 0, y: 0, width: 880, height: 400 }',
      'const win = { getBounds: () => ({ ...current }), setBounds: (b) => { current = { ...current, ...b } } }',
      'const currentWidth = 880',
      `const lastBarHeight = ${TALL}`,
      ''
    ].join('\n')
    const run = new Function('stubs', preamble + region + '\nsetWindowMode()\nreturn current') as (
      stubs: unknown
    ) => Rect
    const height = run({
      screen: fakeScreen([LAPTOP_ALONE]),
      clampHeight: (h: number, areaHeight: number) => Math.min(h, areaHeight - 48)
    }).height
    expect(height).toBeLessThanOrEqual(LAPTOP_ALONE.workArea.height - 48)
  })
})
