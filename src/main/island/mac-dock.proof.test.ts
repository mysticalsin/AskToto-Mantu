/**
 * mac-dock.proof.test.ts — the dock's Ultron pins.
 *
 * Every other rest surface has live-Mac geometry written down as PASS/FAIL numbers (hide 8x2 at
 * bounds.y, island 132x15 at the notch), so an Ultron CGWindowList listing can be checked against
 * something. The dock shipped without any, which means a live run had nothing to compare to and
 * "looks right on screen" was the only available verdict.
 *
 * These are the numbers an Ultron listing must show on Tony's built-in Retina. Same fixtures and same
 * idiom as mac-hide-island.proof.test.ts. Geometry only: this is not the Mac, it is the arithmetic the
 * Mac will be measured against.
 */
import { describe, expect, it } from 'vitest'
import { overlayWatchStep, pointInRect } from './cursor-watch'
import {
  OVERLAY_DOCK_PANEL,
  OVERLAY_DOCK_SLIVER,
  OVERLAY_HIDE_PARK,
  OVERLAY_PEEK_HEIGHT_PAD,
  OVERLAY_PEEK_WIDTH_PAD,
  RIGHT_EDGE_MARGIN_PX,
  dockSliverRect,
  hideParkWindowOpacity,
  hoverWatchRestRect,
  isVisibleHideSlab,
  overlayPlacementPosition,
  overlayRestSize,
  parkAfterExclusiveOnboarding,
  resolveOverlayPlacement,
  type DisplayMetrics
} from './geometry'

/** Tony built-in Retina (notch). workArea.y ≈ 39. Same fixture the hide/island proof uses. */
const TOTOS_MAC: DisplayMetrics = {
  bounds: { x: 0, y: 0, width: 1800, height: 1169 },
  workArea: { x: 0, y: 39, width: 1800, height: 1130 },
  hasNotch: true,
  notchWidth: 200,
  menuBarHeight: 39,
  source: 'helper'
}

/** A genuinely narrow panel, to prove the fit rule is about the REVEALED width, not the bar's 880. */
const NARROW: DisplayMetrics = {
  bounds: { x: 0, y: 0, width: 700, height: 900 },
  workArea: { x: 0, y: 39, width: 700, height: 861 },
  hasNotch: false,
  notchWidth: 0,
  menuBarHeight: 39,
  source: 'heuristic'
}

describe('dock rest — what Ultron must list when the dock is parked', () => {
  it('is 20x108 flush to the usable right edge, with no outboard margin', () => {
    const rest = overlayRestSize('dock', TOTOS_MAC)
    expect(rest.width).toBe(OVERLAY_DOCK_SLIVER.width + OVERLAY_PEEK_WIDTH_PAD)
    expect(rest.height).toBe(OVERLAY_DOCK_SLIVER.height + OVERLAY_PEEK_HEIGHT_PAD)
    expect(rest).toEqual({ width: 20, height: 108 })

    const park = dockSliverRect(TOTOS_MAC)
    expect(park.width).toBe(20)
    expect(park.height).toBe(108)
    // Flush: right edge of the window IS the right edge of the work area. A gap here is the bug that
    // makes a docked sliver read as a floating chip.
    expect(park.x + park.width).toBe(TOTOS_MAC.workArea.x + TOTOS_MAC.workArea.width)
    expect(park.x).toBe(1780)
  })

  it('parks through the same resolver every other layout uses', () => {
    expect(parkAfterExclusiveOnboarding('dock', TOTOS_MAC, 8, 'right-edge')).toEqual(
      dockSliverRect(TOTOS_MAC)
    )
  })

  it('is VISIBLE, unlike the hide hairline — it is the affordance that says Metis is there', () => {
    // Hide parks at opacity 0 while resting. The dock must not: an invisible dock is a dock nobody
    // can find, and its whole reason to exist over Hide is that you can see it.
    expect(hideParkWindowOpacity('hide', true)).toBe(0)
    expect(hideParkWindowOpacity('dock', true)).toBe(1)
    const park = dockSliverRect(TOTOS_MAC)
    expect(isVisibleHideSlab(park)).toBe(true)
    // And it is not the hide hairline by another name.
    expect(park.width).toBeGreaterThan(OVERLAY_HIDE_PARK.width)
    expect(park.height).toBeGreaterThan(OVERLAY_HIDE_PARK.height)
  })

  it('stays on the work area vertically', () => {
    const park = dockSliverRect(TOTOS_MAC)
    expect(park.y).toBeGreaterThanOrEqual(TOTOS_MAC.workArea.y)
    expect(park.y + park.height).toBeLessThanOrEqual(TOTOS_MAC.workArea.y + TOTOS_MAC.workArea.height)
  })
})

describe('dock hover band — the sliver IS the sensor', () => {
  it('the band is the sliver itself, not a compact target beside it', () => {
    const band = hoverWatchRestRect('dock', TOTOS_MAC, 'right-edge')
    expect(band).toEqual(dockSliverRect(TOTOS_MAC))
  })

  it('a pointer on the visible top or bottom of the sliver reveals, not a dead zone', () => {
    const band = hoverWatchRestRect('dock', TOTOS_MAC, 'right-edge')
    const top = { x: band.x + 2, y: band.y + 1 }
    const bottom = { x: band.x + 2, y: band.y + band.height - 2 }
    const beside = { x: band.x - 40, y: band.y + band.height / 2 }
    expect(pointInRect(top, band)).toBe(true)
    expect(pointInRect(bottom, band)).toBe(true)
    expect(pointInRect(beside, band)).toBe(false)
  })

  it('the watch reveals on the sliver and parks away from it', () => {
    const band = hoverWatchRestRect('dock', TOTOS_MAC, 'right-edge')
    const revealed = overlayPlacementPosition({
      placement: 'right-edge',
      width: OVERLAY_DOCK_PANEL.width,
      height: OVERLAY_DOCK_PANEL.height,
      layout: 'dock',
      metrics: TOTOS_MAC,
      topMargin: 8
    })
    const revealedRect = { ...revealed, ...OVERLAY_DOCK_PANEL }

    const onSliver = overlayWatchStep({
      cursor: { x: band.x + 2, y: band.y + 10 },
      restRect: band,
      revealedRect,
      islandResting: true,
      windowVisible: true,
      osHoverSeen: false
    })
    expect(onSliver.action).not.toBe('park')

    const away = overlayWatchStep({
      cursor: { x: 400, y: 600 },
      restRect: band,
      revealedRect,
      islandResting: false,
      windowVisible: true,
      osHoverSeen: true
    })
    expect(away.action).toBe('park')
  })
})

describe('dock revealed — what Ultron must list when it is open', () => {
  it('is 380x560, taller than it is wide: a sidecar, never a bar', () => {
    expect(OVERLAY_DOCK_PANEL).toEqual({ width: 380, height: 560 })
    expect(OVERLAY_DOCK_PANEL.height).toBeGreaterThan(OVERLAY_DOCK_PANEL.width)
  })

  it('opens inboard of the edge, keeping its breathing room', () => {
    const { x, y } = overlayPlacementPosition({
      placement: 'right-edge',
      width: OVERLAY_DOCK_PANEL.width,
      height: OVERLAY_DOCK_PANEL.height,
      layout: 'dock',
      metrics: TOTOS_MAC,
      topMargin: 8
    })
    const right = TOTOS_MAC.workArea.x + TOTOS_MAC.workArea.width
    // The revealed panel keeps RIGHT_EDGE_MARGIN_PX; only the resting sliver is flush.
    expect(x + OVERLAY_DOCK_PANEL.width).toBe(right - RIGHT_EDGE_MARGIN_PX)
    expect(y).toBeGreaterThanOrEqual(TOTOS_MAC.workArea.y)
    expect(y + OVERLAY_DOCK_PANEL.height).toBeLessThanOrEqual(
      TOTOS_MAC.workArea.y + TOTOS_MAC.workArea.height
    )
  })

  it('fits displays the 880 bar cannot, because the fit rule reads the REVEALED width', () => {
    // 380 + 2*12 = 404, comfortably inside a 700pt work area; the bar's 880 + 24 is not.
    expect(resolveOverlayPlacement('right-edge', NARROW, OVERLAY_DOCK_PANEL.width)).toBe('right-edge')
    expect(resolveOverlayPlacement('right-edge', NARROW)).toBe('top-center')
  })
})
