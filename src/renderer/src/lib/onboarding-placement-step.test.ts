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
 * Placement step must show diagrams (not words alone). Style step is Tony voice circle picker:
 * Hidden bar | Persistent bar | Circle | Jarvis — same on Top and Right. Right-edge park stays a
 * geometry duty (2f06669e), not a reason to hide bars/circles from the board.
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
  it('Top and Right offer the same four styles', () => {
    const ids = ['bar-hides', 'bar-stays', 'circle', 'jarvis']
    expect(onboardingChromeForPlacement('top-center').map((s) => s.id)).toEqual(ids)
    expect(onboardingChromeForPlacement('right-edge').map((s) => s.id)).toEqual(ids)
  })

  it('Circle is the default and Jarvis is first-class', () => {
    const circle = onboardingChromeForPlacement('top-center').find((s) => s.id === 'circle')
    const jarvis = onboardingChromeForPlacement('top-center').find((s) => s.id === 'jarvis')
    expect(circle?.default).toBe(true)
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
