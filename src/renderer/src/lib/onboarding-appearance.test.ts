import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  appearancePreviewInitialPhase,
  appearancePreviewRestKind,
  appearancePreviewShowsBar,
  appearancePreviewShowsHint,
  appearancePreviewShowsIsland,
  appearancePreviewShowsDock,
  appearancePreviewDockOpen,
  appearanceSettingsPatch,
  ONBOARDING_APPEARANCE_COPY,
  ONBOARDING_APPEARANCE_HEADING,
  ONBOARDING_APPEARANCE_LEAD,
  chromeSettingsPatch,
  onboardingChromeForPlacement,
  ONBOARDING_PLACEMENT_COPY,
  ONBOARDING_PLACEMENT_HEADING,
  ONBOARDING_CHROME_HEADING,
  placementSettingsPatch,
  reduceAppearancePreview,
  resolveOnboardingPlacementSync,
  saveOnboardingAppearanceChoice,
  seedOnboardingAppearance,
  seedOnboardingPlacement,
  placementDemoLayout,
  placementDemoChromeId,
  placementPreviewCaption
} from './onboarding-appearance'
import { shouldMountKineticGrid, KINETIC_GRID_SCENES } from './onboarding-kinetic-grid'
import { shouldMountStarfield } from './onboarding-starfield-spec'
import {
  sceneAfterAppearance,
  sceneAfterLicense,
  sceneAfterPersonalize,
  sceneAfterReveal,
  sceneAfterSetup
} from './onboarding-flow'

const appearanceLib = readFileSync(join(__dirname, './onboarding-appearance.ts'), 'utf8')
const experience = readFileSync(join(__dirname, '../components/OnboardingExperience.tsx'), 'utf8')
const component = readFileSync(join(__dirname, '../components/OnboardingAppearance.tsx'), 'utf8')
const css = readFileSync(join(__dirname, '../styles.css'), 'utf8')
const design = readFileSync(join(__dirname, '../../../../DESIGN.md'), 'utf8')
const geometry = readFileSync(join(__dirname, '../../../main/island/geometry.ts'), 'utf8')
const indexMain = readFileSync(join(__dirname, '../../../main/index.ts'), 'utf8')

describe('onboarding appearance — persist existing overlay', () => {
  it('seeds Hidden on a fresh install and keeps a saved island or bar', () => {
    expect(seedOnboardingAppearance(undefined)).toBe('hide')
    expect(seedOnboardingAppearance({})).toBe('hide')
    expect(seedOnboardingAppearance({ overlayLayout: 'island' })).toBe('island')
    expect(seedOnboardingAppearance({ overlayLayout: 'bar' })).toBe('bar')
    expect(seedOnboardingAppearance({ overlayLayout: 'hide' })).toBe('hide')
  })

  it('patches overlayLayout immediately and does not invent other settings', () => {
    expect(appearanceSettingsPatch('hide')).toEqual({ overlayLayout: 'hide', autoHideOverlay: true })
    expect(appearanceSettingsPatch('island')).toEqual({ overlayLayout: 'island', autoHideOverlay: true })
    expect(appearanceSettingsPatch('bar')).toEqual({ overlayLayout: 'bar', autoHideOverlay: false })
  })

  it('keeps physical placement independent and defaults it to top-center', () => {
    expect(seedOnboardingPlacement(undefined)).toBe('top-center')
    expect(seedOnboardingPlacement({})).toBe('top-center')
    expect(seedOnboardingPlacement({ overlayPlacement: 'right-edge' })).toBe('right-edge')
    expect(placementSettingsPatch('right-edge')).toEqual({ overlayPlacement: 'right-edge' })
    expect(placementSettingsPatch('top-center')).toEqual({ overlayPlacement: 'top-center' })
  })

  it('adopts real or managed settings after boot without overwriting an in-flow choice', () => {
    expect(resolveOnboardingPlacementSync({ current: 'top-center', incoming: 'right-edge', userSelected: false, managed: false })).toBe('right-edge')
    expect(resolveOnboardingPlacementSync({ current: 'top-center', incoming: 'right-edge', userSelected: true, managed: false })).toBeNull()
    expect(resolveOnboardingPlacementSync({ current: 'top-center', incoming: 'right-edge', userSelected: true, managed: true })).toBe('right-edge')
  })

  it('commits an appearance only when the trusted settings response confirms it', async () => {
    await expect(
      saveOnboardingAppearanceChoice(
        async () => ({ overlayLayout: 'hide', overlayPlacement: 'top-center' }),
        (saved) => saved.overlayPlacement === 'right-edge'
      )
    ).resolves.toBe(false)
    await expect(
      saveOnboardingAppearanceChoice(
        async () => { throw new Error('keychain unavailable') },
        (saved) => saved.overlayLayout === 'bar'
      )
    ).resolves.toBe(false)
    await expect(
      saveOnboardingAppearanceChoice(
        async () => ({ overlayLayout: 'bar', overlayPlacement: 'right-edge' }),
        (saved) => saved.overlayLayout === 'bar'
      )
    ).resolves.toBe(true)
  })

  it('finish / onDone never writes overlayLayout', () => {
    expect(experience).toMatch(/mode, recordingConsent, onboardingDone: true, onboardingDoneAt: Date\.now\(\)/)
    expect(experience).not.toMatch(/onDone\(\{[\s\S]*overlayLayout/)
    expect(experience).toMatch(/chromeSettingsPatch\(placement, id\)/)
    expect(experience).toMatch(/placementSettingsPatch\(id\)/)
    expect(experience).toMatch(/saveOnboardingAppearanceChoice/)
    expect(experience).toMatch(/resolveOnboardingPlacementSync/)
    expect(experience).toMatch(/const placementUserSelectedRef = useRef\(false\)/)
    expect(experience).toMatch(/placementUserSelectedRef\.current = true/)
    expect(experience).toMatch(/incoming: settings\?\.overlayPlacement/)
    expect(experience).toMatch(/managed: placementManaged/)
  })
})

describe('onboarding appearance — 2.0 two-step', () => {
  it('places Top vs Right first, then chrome without Island or em dash', () => {
    expect(ONBOARDING_PLACEMENT_HEADING).toBe('Where should Métis sit?')
    expect(ONBOARDING_CHROME_HEADING).toBe('How should it look?')
    const styles = ['hidden', 'bar-stays', 'circle', 'jarvis']
    expect(onboardingChromeForPlacement('top-center').map((c) => c.id)).toEqual(styles)
    // Tony voice 2026-09-20: same circle-picker styles on Right; dock stays Settings-only.
    // Right-edge park is geometry (2f06669e), not "dock-only cards".
    // The right edge drops the two FULL-bar styles: an 880-wide strip is not an edge sidecar, and
    // choosing one saved a top-centre chrome against a right-edge placement (the mid-screen sliver).
    // Circle and Jarvis stay, because their rest is a 41px circle that sits on an edge fine.
    expect(onboardingChromeForPlacement('right-edge').map((c) => c.id)).toEqual([
      'dock-hidden',
      'dock',
      'circle',
      'jarvis'
    ])
    expect(onboardingChromeForPlacement('top-center').map((c) => c.title)).toEqual([
      'Invisible',
      'Pill',
      'Circle',
      'Jarvis'
    ])
    expect(onboardingChromeForPlacement('top-center').map((c) => c.title).join(' ')).not.toMatch(/Island/)
    const all = [
      ONBOARDING_PLACEMENT_HEADING,
      ONBOARDING_CHROME_HEADING,
      ...Object.values(ONBOARDING_PLACEMENT_COPY).flatMap((c) => [c.title, c.desc]),
      ...onboardingChromeForPlacement('top-center').flatMap((c) => [c.title, c.desc]),
      ...onboardingChromeForPlacement('right-edge').flatMap((c) => [c.title, c.desc])
    ].join(' ')
    expect(all).not.toMatch(/Vibe Island|—/)
  })

  it('maps chrome cards to layout + autoHide + orbStyle', () => {
    expect(chromeSettingsPatch('top-center', 'hidden')).toMatchObject({
      overlayLayout: 'hide',
      autoHideOverlay: true,
      overlayPlacement: 'top-center'
    })
    expect(chromeSettingsPatch('top-center', 'jarvis')).toMatchObject({
      overlayLayout: 'bar',
      overlayOrbStyle: 'obsidian',
      overlayPlacement: 'top-center'
    })
    expect(chromeSettingsPatch('right-edge', 'circle')).toMatchObject({
      overlayLayout: 'bar',
      overlayOrbStyle: 'jakub',
      overlayPlacement: 'right-edge'
    })
    expect(chromeSettingsPatch('right-edge', 'jarvis')).toMatchObject({
      overlayLayout: 'bar',
      overlayOrbStyle: 'obsidian',
      overlayPlacement: 'right-edge'
    })
    expect(chromeSettingsPatch('right-edge', 'dock')).toMatchObject({
      overlayLayout: 'dock',
      overlayPlacement: 'right-edge'
    })
  })
})

describe('onboarding appearance — live preview, no lag', () => {
  it('Hidden rests empty until a top click; hover does not reveal', () => {
    expect(appearancePreviewRestKind('hide')).toBe('empty')
    expect(appearancePreviewInitialPhase('hide')).toBe('rest')
    expect(appearancePreviewShowsHint('hide', 'rest')).toBe(true)
    expect(reduceAppearancePreview('hide', 'rest', 'hover-enter')).toBe('rest')
    expect(reduceAppearancePreview('hide', 'rest', 'click-top')).toBe('in')
    expect(appearancePreviewShowsBar('in')).toBe(true)
    expect(reduceAppearancePreview('hide', 'in', 'spring-in-end')).toBe('settled')
    expect(reduceAppearancePreview('hide', 'settled', 'hover-leave')).toBe('out')
    expect(reduceAppearancePreview('hide', 'out', 'spring-out-end')).toBe('rest')
  })

  it('Island rest is the camera/notch square; hover expands, leave returns', () => {
    expect(appearancePreviewRestKind('island')).toBe('island')
    expect(appearancePreviewShowsIsland('island', 'rest')).toBe(true)
    expect(reduceAppearancePreview('island', 'rest', 'hover-enter')).toBe('in')
    expect(reduceAppearancePreview('island', 'settled', 'hover-leave')).toBe('out')
    expect(reduceAppearancePreview('island', 'rest', 'click-top')).toBe('in')
  })

  it('Bar stays the mock bar', () => {
    expect(appearancePreviewRestKind('bar')).toBe('bar')
    expect(appearancePreviewInitialPhase('bar')).toBe('settled')
    expect(reduceAppearancePreview('bar', 'settled', 'hover-leave')).toBe('settled')
    expect(reduceAppearancePreview('bar', 'settled', 'click-top')).toBe('settled')
  })

  it('Tony FAIL: dock rests slim — Invisible never opens a fat panel; Pill opens only on hover', () => {
    expect(appearancePreviewRestKind('dock')).toBe('dock')
    expect(appearancePreviewInitialPhase('dock')).toBe('rest')
    expect(appearancePreviewShowsDock('dock', 'rest', 'dock-hidden')).toBe(false)
    expect(appearancePreviewDockOpen('dock-hidden', 'settled')).toBe(false)
    expect(appearancePreviewDockOpen('dock-hidden', 'in')).toBe(false)
    expect(appearancePreviewShowsDock('dock', 'rest', 'dock')).toBe(true)
    expect(appearancePreviewDockOpen('dock', 'rest')).toBe(false)
    expect(appearancePreviewDockOpen('dock', 'in')).toBe(true)
    expect(appearancePreviewDockOpen('dock', 'settled')).toBe(true)
    expect(reduceAppearancePreview('dock', 'rest', 'hover-enter')).toBe('in')
    expect(css).toMatch(/Tony FAIL/)
    expect(css).not.toMatch(/width:\s*min\(34%,\s*120px\)/)
    expect(css).not.toMatch(/width:\s*min\(36%,\s*128px\)/)
  })

  it('preview is CSS-only: no setBounds, Bar, Listen, orb, WebGL, or rAF', () => {
    expect(component).toMatch(/onboard-appearance-preview/)
    expect(component).toMatch(/overlay-spring/)
    expect(component).not.toMatch(/setBounds/)
    expect(component).not.toMatch(/from '\.\/Bar'/)
    expect(component).not.toMatch(/Listen/)
    expect(component).not.toMatch(/requestAnimationFrame/)
    expect(component).not.toMatch(/WebGL/)
    expect(component).not.toMatch(/from 'three'/)
    expect(css).toMatch(/\.onboard-appearance-preview__island/)
    expect(css).toMatch(/\.onboard-appearance-preview__bar/)
    expect(css).not.toMatch(/\.onboard-appearance-preview\s*\{[^}]*backdrop-filter/)
  })
})

describe('onboarding appearance — scene hop sits after the demo', () => {
  it('sits after the demo and before Your setup; KineticGrid is the bed, not skip', () => {
    expect(sceneAfterReveal()).toBe('appearance')
    expect(sceneAfterAppearance()).toBe('setup')
    expect(sceneAfterSetup()).toBe('personalize')
    expect(sceneAfterPersonalize(false)).toBe('ready')
    expect(sceneAfterPersonalize(true)).toBe('license')
    expect(sceneAfterLicense()).toBe('ready')
    expect(KINETIC_GRID_SCENES).toContain('appearance')
    expect(KINETIC_GRID_SCENES.indexOf('appearance')).toBeLessThan(KINETIC_GRID_SCENES.indexOf('setup'))
    expect(shouldMountKineticGrid('appearance')).toBe(true)
    expect(shouldMountStarfield('appearance')).toBe(false)
    expect(shouldMountStarfield('hero')).toBe(false)
    expect(shouldMountStarfield('reveal')).toBe(false)
    expect(experience).toMatch(
      /GUIDED_SCENES: Scene\[\] = \['problem', 'reveal', 'appearance', 'setup', 'personalize'\]/
    )
    expect(experience).toMatch(/setScene\(sceneAfterReveal\(\)\)/)
    expect(experience).toMatch(/scene === 'appearance'/)
    expect(experience).toMatch(/<OnboardingAppearance/)
    expect(experience).not.toMatch(/scene === 'skip'/)
  })
})

describe('onboarding appearance — overlay park and Island hover stay out', () => {
  it('does not edit Hide 8x2, Island peek, or overlay park leftover', () => {
    expect(geometry).toMatch(/export const OVERLAY_HIDE_PARK = \{ width: 8, height: 2 \}/)
    expect(geometry).toMatch(/export const OVERLAY_ISLAND_PEEK = \{ width: 132, height: 15 \}/)
    expect(design).toMatch(/Onboarding appearance \(Tony ask\)/)
    expect(appearanceLib).not.toMatch(/restoreParkAfterShow|OVERLAY_HIDE_PARK|hoverWatchRestRect/)
    expect(component).not.toMatch(/src\/main\/island/)
    expect(indexMain).not.toMatch(/from '\.\/onboarding-appearance'/)
  })
})


describe('onboarding appearance — placement-step live preview (Tony FAIL 01cfd705)', () => {
  it('forces a clear Top bar / Right dock demo instead of default Hidden', () => {
    expect(placementDemoLayout('top-center')).toBe('bar')
    expect(placementDemoChromeId('top-center')).toBe('bar-stays')
    expect(placementDemoLayout('right-edge')).toBe('dock')
    expect(placementDemoChromeId('right-edge')).toBe('dock')
  })

  it('captions placement under the preview', () => {
    expect(placementPreviewCaption('top-center')).toBe('Along the top')
    expect(placementPreviewCaption('right-edge')).toBe('Along the right edge')
  })

  it('CSS hugs the right edge — no mid-screen 68% pill', () => {
    expect(css).toMatch(/\.onboard-appearance-preview--right-edge \.onboard-appearance-preview__bar-slot[^{]*\{[^}]*width:\s*min\(36%, 120px\)/)
    expect(css).not.toMatch(/\.onboard-appearance-preview--right-edge \.onboard-appearance-preview__bar-slot[^{]*\{[^}]*width:\s*68%/)
    expect(css).toMatch(/\.onboard-appearance-preview__dock[^{]*\{[^}]*right:\s*16px/)
  })

  it('placement step stays put on click; Continue advances (source contract)', () => {
    expect(component).toMatch(/const continueFromPlacement/)
    expect(component).toMatch(/data-onboard-placement-continue/)
    expect(component).toMatch(/placementDemoLayout\(placement\)/)
    // pickPlacement must NOT setStep('chrome') anymore
    const pick = component.slice(component.indexOf('const pickPlacement'), component.indexOf('const continueFromPlacement'))
    expect(pick).not.toMatch(/setStep\(['"]chrome['"]\)/)
  })
})
