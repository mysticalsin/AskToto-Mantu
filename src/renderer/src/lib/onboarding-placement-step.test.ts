import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ONBOARDING_PLACEMENTS,
  chromeSettingsPatch,
  onboardingChromeForPlacement
} from './onboarding-appearance'

/**
 * onboarding-placement-step.test.ts
 *
 * Placement step must show diagrams (not words alone). Style step Tony HARD 2026-09-21:
 * Invisible → Pill → Orbs (Circle/Jarvis). Top and Right both follow that order.
 */

describe('the placement step shows what it is offering', () => {
  const scene = readFileSync(join(__dirname, '..', 'components', 'OnboardingAppearance.tsx'), 'utf8')

  it('each placement card draws the surface where it will actually sit', () => {
    expect(scene).toMatch(/overlay-placement-diagram overlay-placement-diagram--\$\{id\}/)
    expect(scene).toMatch(/overlay-placement-diagram__desktop/)
    expect(scene).toMatch(/overlay-placement-diagram__mark/)
  })

  it('the diagram is decoration, so it is not announced twice', () => {
    const card = scene.slice(scene.indexOf('overlay-placement-diagram'))
    expect(card.slice(0, 400)).toMatch(/aria-hidden="true"/)
  })

  it('the styles those classes need already exist', () => {
    const css = readFileSync(join(__dirname, '..', 'styles.css'), 'utf8')
    for (const id of ONBOARDING_PLACEMENTS) {
      expect(css).toContain(`.overlay-placement-diagram--${id}`)
    }
  })
})

describe('Tony voice circle picker — style step', () => {
  it('Top and Right both offer Invisible → Pill → Orbs (Circle/Jarvis)', () => {
    expect(onboardingChromeForPlacement('top-center').map((s) => s.id)).toEqual([
      'hidden',
      'bar-stays',
      'circle',
      'jarvis'
    ])
    expect(onboardingChromeForPlacement('top-center').map((s) => s.title)).toEqual([
      'Invisible',
      'Pill',
      'Circle',
      'Jarvis'
    ])
    // Right-edge: Invisible dock, Pill rail, then Orbs — never a horizontal bar peer.
    const right = onboardingChromeForPlacement('right-edge')
    expect(right.map((s) => s.id)).toEqual(['dock-hidden', 'dock', 'circle', 'jarvis'])
    expect(right.map((s) => s.title)).toEqual(['Invisible', 'Pill', 'Circle', 'Jarvis'])
    expect(right.map((s) => s.id)).not.toContain('bar-hides')
    expect(right.map((s) => s.id)).not.toContain('bar-stays')
  })

  it('Invisible is the default; Jarvis stays first-class under Orbs', () => {
    const invisible = onboardingChromeForPlacement('top-center').find((s) => s.id === 'hidden')
    const jarvis = onboardingChromeForPlacement('top-center').find((s) => s.id === 'jarvis')
    expect(invisible?.default).toBe(true)
    expect(invisible?.title).toBe('Invisible')
    expect(jarvis?.overlayOrbStyle).toBe('obsidian')
    expect(jarvis?.title).toMatch(/Jarvis/i)
  })

  it('chrome cards render large Circle + Jarvis thumbs on the board', () => {
    const scene = readFileSync(join(__dirname, '..', 'components', 'OnboardingAppearance.tsx'), 'utf8')
    expect(scene).toMatch(/ChromeCardThumb/)
    expect(scene).toMatch(/JarvisOrbButton/)
    expect(scene).toMatch(/ObsidianOrb/)
    expect(scene).toMatch(/onboard-appearance-preview__circle-stage/)
    const css = readFileSync(join(__dirname, '..', 'styles.css'), 'utf8')
    expect(css).toMatch(/onboard-appearance-preview__circle-stage/)
    expect(css).toMatch(/circle-stage/)
    expect(scene).toMatch(/overlay-orb-diagram/)
  })
})

describe('the saved patch cannot leave a stale rest behind', () => {
  it('writes dockRest when dock is chosen from Settings/catalog', () => {
    expect(chromeSettingsPatch('right-edge', 'dock').dockRest).toBe('sliver')
    expect(chromeSettingsPatch('right-edge', 'dock-hidden').dockRest).toBe('hidden')
  })

  it('a right-edge style choice always saves the right-edge placement with it', () => {
    const patch = chromeSettingsPatch('right-edge', 'jarvis')
    expect(patch.overlayPlacement).toBe('right-edge')
    expect(patch.overlayLayout).toBe('bar')
    expect(patch.overlayOrbStyle).toBe('obsidian')
  })

  it('a top choice never smuggles a dock in', () => {
    const patch = chromeSettingsPatch('top-center', 'circle')
    expect(patch.overlayPlacement).toBe('top-center')
    expect(patch.overlayLayout).not.toBe('dock')
  })
})

describe('selection click stays smooth (Tony voice ~8:43pm ET)', () => {
  const scene = readFileSync(join(__dirname, '..', 'components', 'OnboardingAppearance.tsx'), 'utf8')
  const css = readFileSync(join(__dirname, '..', 'styles.css'), 'utf8')

  it('does not remount the live preview on every Top|Right / chrome click', () => {
    // A key that includes placement/chrome/step remounts the board and flashes app-wide.
    expect(scene).not.toMatch(/key=\{\`\$\{placement\}:\$\{previewLayout\}/)
  })

  it('cards transition border/background instead of snapping', () => {
    expect(css).toMatch(/\.overlay-chrome-card \{[\s\S]*?transition:/)
    expect(css).toMatch(/\.onboard-appearance \.overlay-chrome-card \{[\s\S]*?transition:/)
  })

  it('persona border also eases on is-selected (not transform-only)', () => {
    expect(css).toMatch(/\.onboard-persona \{[\s\S]*?border-color 200ms/)
  })
})


describe('selection has zero flash (Tony FAIL b756778a / Cap4 Appearance 12c295e9 DNA)', () => {
  const experience = readFileSync(join(__dirname, '..', 'components', 'OnboardingExperience.tsx'), 'utf8')
  const scene = readFileSync(join(__dirname, '..', 'components', 'OnboardingAppearance.tsx'), 'utf8')
  const css = readFileSync(join(__dirname, '..', 'styles.css'), 'utf8')

  it('does not raise busy/Saving on chrome or placement pick', () => {
    // Optimistic UI; silent persist. busy:true dimmed the whole card grid.
    const chrome = experience.slice(experience.indexOf('const pickChrome'))
    expect(chrome.slice(0, 900)).not.toMatch(/setAppearanceSave\(\{ busy: true/)
    const place = experience.slice(experience.indexOf('const pickPlacement'))
    expect(place.slice(0, 900)).not.toMatch(/setAppearanceSave\(\{ busy: true/)
  })

  it('keeps Circle and Jarvis painted and crossfades with is-on/is-off', () => {
    expect(scene).toMatch(/circle-stage--typical/)
    expect(scene).toMatch(/circle-stage--jarvis/)
    expect(scene).toMatch(/is-on/)
    expect(scene).toMatch(/is-off/)
    expect(css).toMatch(/ZERO flash: stacked chrome layers/)
  })

  it('Right dock chrome thumbs render a vertical sidecar, not a horizontal bar', () => {
    expect(scene).toMatch(/onboard-chrome-thumb--dock/)
    expect(scene).toMatch(/onboard-chrome-thumb__sidecar/)
    expect(scene).toMatch(/onboard-chrome-thumb__rail/)
    // dock / dock-hidden must not fall through to bar-stays art
    const thumb = scene.slice(scene.indexOf('function ChromeCardThumb'))
    const dockBranch = thumb.slice(0, thumb.indexOf('if (id === \'bar-hides\')'))
    expect(dockBranch).toMatch(/id === 'dock'/)
    expect(dockBranch).not.toMatch(/bar-stays/)
  })
})
