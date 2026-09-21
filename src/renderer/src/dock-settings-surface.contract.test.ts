import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { overlayShowsSettingsSheet } from '@shared/overlay-chrome'

/**
 * dock-settings-surface.contract.test.ts
 *
 * Opening Settings from the dock showed a big black box. The cause is a layout collision, not styling:
 *
 *   - `applySettingsSurface` resizes the overlay to the wide, centred SETTINGS_WINDOW_MIN rect. Settings
 *     is NOT rendered inside the 380-wide dock window; it renders as a sheet BELOW the ask surface.
 *   - `DockPanel` is built to fill its own window (`h-full min-h-0`), because that is exactly right when
 *     the window IS the dock.
 *
 * Put together, the dock panel claimed the entire tall settings window with an empty body, squeezing the
 * settings sheet to nothing behind a full-height slab of dark glass. At settings width the bar is the
 * correct surface, so App hands back to it.
 */
const app = readFileSync(join(__dirname, 'App.tsx'), 'utf8')

describe('the dock never renders as the ask surface while Settings is open', () => {
  it('App picks DockPanel only when the settings sheet is closed', () => {
    expect(app).toMatch(/const settingsSheetOpen = overlayShowsSettingsSheet\(view, minimized\)/)
    // The optional type annotation carries the one dock-only prop (bodyFills) through a single call
    // site; the guarded contract - DockPanel only when the settings sheet is closed - is unchanged.
    expect(app).toMatch(
      /const AskSurface(: ComponentType<DockPanelProps>)?\s*=\s*\n?\s*overlayLayout === 'dock' && !settingsSheetOpen \? DockPanel :/
    )
  })

  it('the edge spring is dropped with it, since the settings window is not edge-docked', () => {
    expect(app).toMatch(
      /const overlaySpringEdge: OverlayEdge = overlayLayout === 'dock' && !settingsSheetOpen \? 'right' : 'top'/
    )
  })

  it('the helper this depends on still means what the guard assumes', () => {
    // If overlayShowsSettingsSheet ever stopped being true for a non-minimized settings view, the guard
    // above would silently stop firing and the black box would return.
    expect(overlayShowsSettingsSheet('settings', false)).toBe(true)
    expect(overlayShowsSettingsSheet('settings', true)).toBe(false)
    expect(overlayShowsSettingsSheet('answer', false)).toBe(false)
  })

  it('every other full view renders INSIDE the dock, not as a panel squeezed behind it', () => {
    // History / Review / Brain / Agenda hit the same collision as Settings: a <Panel> below a surface
    // that fills the window has nowhere to go. The dock is itself a panel, so they belong in its body.
    expect(app).toMatch(/const dockSurfaceLive = overlayLayout === 'dock' && !settingsSheetOpen/)
    expect(app).toMatch(/const barBody = \(answerView \|\| dockSurfaceLive\) && !collapsed \? body : undefined/)
    expect(app).toMatch(/const isPanelBody = body != null && !answerView && !dockSurfaceLive/)
  })

  it('DockPanel still fills its OWN window, which is what made it right there', () => {
    const dock = readFileSync(join(__dirname, 'components', 'DockPanel.tsx'), 'utf8')
    expect(dock).toMatch(/h-full min-h-0 w-full flex-col/)
  })
})
