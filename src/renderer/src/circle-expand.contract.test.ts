import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CIRCLE_REST_HOST_PX,
  circleRestWindowPx,
  decideCircleRestMinimize,
  isCircleRestWrongSlab,
  minimizedCircleRestBounds
} from '@shared/overlay-orb'
import { overlayHugNextWidth, overlayHugWidthFloor } from '@shared/overlay-chrome'
import { pillClickShouldExpand, runOrbPillActivate } from './lib/bar-pill-orb'

const root = join(__dirname)
const app = readFileSync(join(root, 'App.tsx'), 'utf8')
const orb = readFileSync(join(root, 'components', 'ObsidianOrb.tsx'), 'utf8')
const pill = readFileSync(join(root, 'components', 'ControlPill.tsx'), 'utf8')
const index = readFileSync(join(__dirname, '../../main/index.ts'), 'utf8')

describe('circle-expand: click Expand Métis must not snap back', () => {
  it('auto-collapses only when styleChanged, not every expanded frame', () => {
    const expandedJarvis = {
      layout: 'bar' as const,
      style: 'obsidian' as const,
      minimized: false,
      styleChanged: false
    }
    // Totos-Mac: unminimize then overlayOrbRestIsCircle && !minimized re-collapsed.
    expect(decideCircleRestMinimize(expandedJarvis)).toBe('stay')
    expect(decideCircleRestMinimize({ ...expandedJarvis, style: 'jakub' })).toBe('stay')
    expect(decideCircleRestMinimize({ ...expandedJarvis, styleChanged: true })).toBe('minimize')
    expect(decideCircleRestMinimize({ ...expandedJarvis, minimized: true, styleChanged: true })).toBe(
      'stay'
    )
    expect(
      decideCircleRestMinimize({
        layout: 'bar',
        style: 'bar',
        minimized: true,
        styleChanged: true
      })
    ).toBe('expand')
    expect(app).toMatch(/styleChanged/)
    expect(app).toMatch(/decideCircleRestMinimize/)
    expect(app).not.toMatch(/if \(view !== 'settings' && !minimized\)/)
    expect(app).not.toMatch(/overlayOrbRestIsCircle\(overlayLayout, overlayOrbStyle\)[\s\S]*!minimized/)
  })

  it('Expand Métis click on Jarvis/ObsidianOrb activates when dragMoved is false', () => {
    let n = 0
    expect(pillClickShouldExpand(false)).toBe(true)
    expect(runOrbPillActivate({ enableDrag: true, dragMoved: false, onActivate: () => { n++ } })).toBe(
      true
    )
    expect(n).toBe(1)
    expect(runOrbPillActivate({ enableDrag: true, dragMoved: true, onActivate: () => { n++ } })).toBe(
      false
    )
    expect(n).toBe(1)
    expect(orb).toMatch(/runOrbPillActivate\(\{ enableDrag, dragMoved: dragMovedRef\.current, onActivate \}\)/)
    expect(pill).toMatch(/onActivate=\{onExpand\}/)
    expect(pill).toMatch(/ariaLabel="Expand Métis"/)
    expect(app).toMatch(/onExpand=\{unminimize\}/)
    expect(app).toMatch(/setMinimized\(false\)/)
    expect(app).toMatch(/window\.toto\.minimize\(false\)/)
  })

  it('keeps 41 Circle/Jarvis rest window and hug floor, not 220 × lastBarHeight', () => {
    expect(CIRCLE_REST_HOST_PX).toBe(41)
    expect(circleRestWindowPx()).toBe(51)
    expect(minimizedCircleRestBounds({ layout: 'bar', style: 'obsidian' })).toEqual({
      width: 51,
      height: 51
    })
    expect(isCircleRestWrongSlab({ width: 220, height: 192 })).toBe(true)
    expect(overlayHugWidthFloor(true)).toBe(41 + 10)
    expect(overlayHugNextWidth({ reportedWidth: 41, maxWidth: 880, circleRest: true })).toBe(51)
    expect(overlayHugNextWidth({ reportedWidth: 41, maxWidth: 880, circleRest: false })).toBe(120)
    expect(index).toMatch(/minimizedCircleRestBounds/)
    expect(index).toMatch(/overlayHugNextWidth/)
    expect(index).not.toMatch(/const nextWidth = Math\.max\(120/)
  })
})
