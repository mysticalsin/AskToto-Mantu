import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as cursorWatch from './island/cursor-watch'
import { hoverWatchRestRect, type DisplayMetrics } from './island/geometry'
import { isIncompleteAskReveal } from '@shared/overlay-chrome'

const source = readFileSync(join(__dirname, 'index.ts'), 'utf8').replace(/\r\n/g, '\n')

/** Execute the shipped native polling handler without booting Electron. Only the OS window/cursor,
 * IPC and timer side effects are substituted; hit testing and the watcher's state transitions are real. */
function nativeHover() {
  const display: DisplayMetrics = {
    bounds: { x: 0, y: 0, width: 1800, height: 1169 },
    workArea: { x: 0, y: 39, width: 1800, height: 1130 },
    hasNotch: true,
    notchWidth: 200,
    menuBarHeight: 39,
    source: 'helper'
  }
  const parked = { x: 896, y: 0, width: 8, height: 2 }
  const revealed = { x: 460, y: 39, width: 880, height: 120 }
  let bounds = parked
  let cursor = { x: 900, y: 600 }
  let now = 0
  let parkPending = false
  let restoreCount = 0
  const notifications: boolean[] = []
  const deps = {
    ...cursorWatch,
    win: { isDestroyed: () => false, isVisible: () => true, getBounds: () => bounds },
    screen: { getDisplayMatching: () => display, getCursorScreenPoint: () => cursor },
    performance: { now: () => now },
    overlayCursorWatchWanted: () => true,
    stopOverlayCursorWatch: () => {},
    healHideGhostSlab: () => false,
    getDisplayMetrics: () => display,
    liveOverlayLayout: () => 'hide',
    hoverWatchRestRect,
    isIncompleteAskReveal,
    cancelOverlayLeavePark: () => { parkPending = false },
    scheduleOverlayLeavePark: () => { parkPending = true },
    notifyOverlayCursorHover: (hovering: boolean) => { notifications.push(hovering) },
    restoreWindow: () => { bounds = revealed; restoreCount++ },
    mainLog: { info: () => {} }
  }
  const begin = source.indexOf('function tickOverlayCursorWatch(): void {')
  const end = source.indexOf('function notifyOverlayCursorHover', begin)
  expect(begin).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(begin)
  const handler = source.slice(begin, end).replace('(): void {', '() {')
  const build = new Function(...Object.keys(deps), `
    let islandResting = true;
    let settingsSurfaceOpen = false;
    let overlayCursorWatchHovering = false;
    let overlayCursorWatchEnteredAt = null;
    function restoreBarWidth() { islandResting = false; restoreWindow(); }
    ${handler}
    return tickOverlayCursorWatch;
  `) as (...args: unknown[]) => () => void
  const tick = build(...Object.values(deps))
  return {
    tick(at: number, y: number): void {
      now = at
      cursor = { x: 900, y }
      tick()
    },
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
