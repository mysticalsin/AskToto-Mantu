import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BAR_IDLE_HEIGHT_PX,
  isBarIdleGhostPanel,
  rememberBarContentHeight
} from '@shared/overlay-chrome'
import { SETTINGS_SURFACE_BACKGROUND } from '@shared/settings-bounds'

const index = readFileSync(join(__dirname, 'index.ts'), 'utf8')
const app = readFileSync(join(__dirname, '../renderer/src/App.tsx'), 'utf8')

describe('Bar idle must not keep a Settings-tall ghost slab', () => {
  it('fails if Bar idle is settings-tall or still uses the Settings background', () => {
    expect(
      isBarIdleGhostPanel({
        layout: 'bar',
        settingsSurfaceOpen: false,
        width: 880,
        height: 800
      })
    ).toBe(true)
    expect(
      isBarIdleGhostPanel({
        layout: 'bar',
        settingsSurfaceOpen: false,
        width: 41,
        height: 800,
        minimized: true
      })
    ).toBe(true)
    expect(
      isBarIdleGhostPanel({
        layout: 'bar',
        settingsSurfaceOpen: false,
        width: 880,
        height: BAR_IDLE_HEIGHT_PX,
        background: SETTINGS_SURFACE_BACKGROUND
      })
    ).toBe(true)
    expect(
      isBarIdleGhostPanel({
        layout: 'bar',
        settingsSurfaceOpen: false,
        width: 880,
        height: BAR_IDLE_HEIGHT_PX
      })
    ).toBe(false)
    expect(rememberBarContentHeight(800)).toBe(BAR_IDLE_HEIGHT_PX)
    expect(rememberBarContentHeight(84)).toBe(84)
  })

  it('main forgets Settings 800+ as lastBarHeight and hugs Bar idle / Circle', () => {
    expect(index).toMatch(/rememberBarContentHeight/)
    expect(index).toMatch(/isSettingsTallHeight/)
    expect(index).toMatch(/BAR_IDLE_HEIGHT_PX/)
    expect(index).toMatch(/usesHover: overlayUsesHover\(liveOverlayLayout\(\)\)/)
    expect(index).toMatch(/if \(settingsSurfaceOpen\) return/)
    expect(index).toMatch(/A Settings-tall lastBarHeight was the gray box under Jarvis/)
    expect(index).toMatch(/lastBarHeight = rememberBarContentHeight\(lastBarHeight, BAR_IDLE_HEIGHT_PX\)/)
    expect(index).toMatch(/setBackgroundColor\(OVERLAY_REST_BACKGROUND\)/)
  })

  it('renderer mounts Settings / cl-root only while view is settings; Circle click expands, not Settings', () => {
    expect(app).toMatch(/data-settings-surface=\{view === 'settings' \|\| undefined\}/)
    expect(app).toMatch(/view === 'settings' \? 'h-full min-h-0'/)
    expect(app).toMatch(/\(view === 'settings' \|\| DEMO === 'settings'\) && settings/)
    expect(app).toMatch(/view === 'settings' \|\| DEMO === 'settings' \? \(/)
    expect(app).toMatch(/onExpand=\{unminimize\}/)
    expect(app).not.toMatch(/onExpand=\{openSettings/)
    expect(app).not.toMatch(/onExpand=\{onBarSettings/)
    const settingsBody = app.slice(app.indexOf('const settingsBody'), app.indexOf('const historyBody'))
    expect(settingsBody).toMatch(/<Settings/)
    const idleReturn = app.slice(app.indexOf('const body: JSX.Element | null'))
    expect(idleReturn).toMatch(/view === 'settings' \|\| DEMO === 'settings'/)
  })
})
