import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CIRCLE_REST_HOST_PX,
  CIRCLE_REST_SHADOW_PAD_PX,
  CIRCLE_REST_VIEWPORT_MAX_PX,
  DEFAULT_OVERLAY_ORB_STYLE,
  OVERLAY_ORB_COPY,
  OVERLAY_ORB_STYLES,
  circleRestWindowPx,
  isCircleRestWrongSlab,
  minimizedCircleRestBounds,
  overlayOrbRestIsCircle,
  overlayUsesObsidianOrb,
  overlayUsesJarvisOrb,
  overlayUsesThinkingOrb,
  overlayOrbPickerSelected,
  OVERLAY_ORB_PICKER_CARDS,
  parseOverlayOrbStyle
} from './overlay-orb'
import {
  overlayAllowsMinimize,
  overlayShowsBarOrb,
  overlayDocksBarCircle,
  overlayHugNextWidth,
  overlayHugWidthFloor,
  WINDOW_RESIZE_HUG_FLOOR_PX
} from './overlay-chrome'

describe('orb selection persist + Bar-only law', () => {
  it('default Circle rest is jakub thinking-orb; garbage parses to jakub', () => {
    expect(DEFAULT_OVERLAY_ORB_STYLE).toBe('jakub')
    expect(OVERLAY_ORB_STYLES).toEqual(['bar', 'jakub', 'obsidian'])
    expect(parseOverlayOrbStyle(undefined)).toBe('jakub')
    expect(parseOverlayOrbStyle('nope')).toBe('jakub')
    expect(parseOverlayOrbStyle('obsidian')).toBe('obsidian')
    expect(parseOverlayOrbStyle('jakub')).toBe('jakub')
    expect(parseOverlayOrbStyle('bar')).toBe('bar')
  })

  it('Hide and Island never show a circle even if the orb style is set', () => {
    expect(overlayOrbRestIsCircle('hide', 'jakub')).toBe(false)
    expect(overlayOrbRestIsCircle('island', 'obsidian')).toBe(false)
    expect(overlayOrbRestIsCircle('bar', 'jakub')).toBe(true)
    expect(overlayOrbRestIsCircle('bar', 'obsidian')).toBe(true)
    expect(overlayOrbRestIsCircle('bar', 'bar')).toBe(false)
    expect(overlayUsesJarvisOrb('bar', 'obsidian')).toBe(true)
    expect(overlayUsesJarvisOrb('bar', 'jakub')).toBe(false)
    expect(overlayUsesJarvisOrb('bar', 'bar')).toBe(false)
    expect(overlayUsesJarvisOrb('hide', 'obsidian')).toBe(false)
    expect(overlayUsesThinkingOrb('bar', 'jakub')).toBe(true)
    expect(overlayUsesThinkingOrb('bar', 'bar')).toBe(true)
    expect(overlayUsesThinkingOrb('bar', 'obsidian')).toBe(false)
    expect(overlayUsesObsidianOrb('bar', 'obsidian')).toBe(true)
    expect(overlayUsesObsidianOrb('bar', 'jakub')).toBe(false)
    expect(overlayUsesObsidianOrb('hide', 'obsidian')).toBe(false)
    expect(OVERLAY_ORB_PICKER_CARDS).toEqual(['jakub', 'obsidian', 'bar'])
    expect(overlayOrbPickerSelected('jakub')).toBe('jakub')
    expect(overlayOrbPickerSelected('obsidian')).toBe('obsidian')
    expect(overlayOrbPickerSelected('bar')).toBe('bar')
    expect(overlayShowsBarOrb('hide', true)).toBe(false)
    expect(overlayShowsBarOrb('island', true)).toBe(false)
    expect(overlayAllowsMinimize('hide')).toBe(false)
    expect(overlayDocksBarCircle('hide')).toBe(false)
  })

  it('Settings captions have no em dash and no Vibe Island', () => {
    const all = Object.values(OVERLAY_ORB_COPY)
      .map((c) => `${c.title} ${c.desc}`)
      .join(' ')
    expect(all).not.toMatch(/\u2014/)
    expect(all).not.toMatch(/Vibe Island/)
    expect(OVERLAY_ORB_COPY.bar.desc).toMatch(/Ask bar stays on screen/)
    expect(OVERLAY_ORB_COPY.jakub.title).toBe('Circle')
    expect(OVERLAY_ORB_COPY.obsidian.title).toBe('Jarvis')
    expect(OVERLAY_ORB_COPY.jakub.desc).toMatch(/thinking orb/)
    expect(OVERLAY_ORB_COPY.obsidian.desc).toMatch(/Particle sphere/)
    expect(all).not.toMatch(/Obsidian/)
    expect(all).not.toMatch(/Jarvis \/ Obsidian/)
  })

  it('minimized Circle/Jarvis rest is ~41 square, never 220 × lastBarHeight or hug-floor 120', () => {
    const lastBarHeight = 192
    const pillWidth = 220
    expect(CIRCLE_REST_HOST_PX).toBe(41)
    expect(circleRestWindowPx()).toBe(CIRCLE_REST_HOST_PX + CIRCLE_REST_SHADOW_PAD_PX)
    expect(circleRestWindowPx()).toBeLessThanOrEqual(CIRCLE_REST_VIEWPORT_MAX_PX)

    const jarvis = minimizedCircleRestBounds({ layout: 'bar', style: 'obsidian' })
    const circle = minimizedCircleRestBounds({ layout: 'bar', style: 'jakub' })
    expect(jarvis).toEqual({ width: 51, height: 51 })
    expect(circle).toEqual({ width: 51, height: 51 })
    expect(jarvis!.width).not.toBe(pillWidth)
    expect(jarvis!.height).not.toBe(lastBarHeight)
    expect(circle!.height).not.toBe(800)
    expect(isCircleRestWrongSlab({ width: 220, height: 192 })).toBe(true)
    expect(isCircleRestWrongSlab({ width: 220, height: lastBarHeight })).toBe(true)
    expect(isCircleRestWrongSlab({ width: 120, height: 44 })).toBe(true)
    expect(isCircleRestWrongSlab({ width: 51, height: 51 })).toBe(false)
    expect(isCircleRestWrongSlab({ width: 41, height: 44 })).toBe(false)
    expect(isCircleRestWrongSlab({ width: 60, height: 55 })).toBe(false)
    expect(minimizedCircleRestBounds({ layout: 'hide', style: 'obsidian' })).toBeNull()
    expect(minimizedCircleRestBounds({ layout: 'island', style: 'jakub' })).toBeNull()
    expect(minimizedCircleRestBounds({ layout: 'bar', style: 'bar' })).toBeNull()

    expect(WINDOW_RESIZE_HUG_FLOOR_PX).toBe(120)
    expect(overlayHugWidthFloor(true)).toBe(51)
    expect(overlayHugWidthFloor(false)).toBe(120)
    expect(overlayHugNextWidth({ reportedWidth: 41, maxWidth: 880, circleRest: true })).toBe(51)
    expect(overlayHugNextWidth({ reportedWidth: 41, maxWidth: 880, circleRest: true })).toBeLessThan(120)
    expect(overlayHugNextWidth({ reportedWidth: 41, maxWidth: 880, circleRest: false })).toBe(120)
    expect(overlayHugNextWidth({ reportedWidth: 500, maxWidth: 880, circleRest: true })).toBe(510)

    const index = readFileSync(join(__dirname, '../main/index.ts'), 'utf8')
    expect(index).toMatch(/minimizedCircleRestBounds/)
    expect(index).toMatch(/overlayHugNextWidth/)
    expect(index).toMatch(/overlayOrbRestIsCircle/)
    const setMin = index.slice(
      index.indexOf('function setMinimizedWidth'),
      index.indexOf('function applySettingsSurface')
    )
    expect(setMin).toMatch(/if \(circleRest\)/)
    expect(setMin).toMatch(/currentWidth = circleRest\.width/)
    expect(setMin).toMatch(/resizeTo\(circleRest\.height\)/)
    expect(setMin).not.toMatch(/currentWidth = PILL_WIDTH\n\s+applyHideClickThrough/)
    const hug = index.slice(
      index.indexOf('ipcMain.handle(IPC.windowResize'),
      index.indexOf('ipcMain.handle(IPC.windowMode')
    )
    expect(hug).toMatch(/overlayHugNextWidth/)
    expect(hug).not.toMatch(/const nextWidth = Math\.max\(120/)
  })
})
