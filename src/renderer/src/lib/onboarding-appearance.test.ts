import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { PublicSettings } from '@shared/ipc'
import { persistOverlayPlacement } from './overlay-placement-save'
import {
  appearancePreviewInitialPhase,
  appearancePreviewRestKind,
  appearancePreviewShowsBar,
  appearancePreviewShowsHint,
  appearancePreviewShowsIsland,
  appearanceSettingsPatch,
  ONBOARDING_APPEARANCE_COPY,
  ONBOARDING_APPEARANCE_HEADING,
  ONBOARDING_APPEARANCE_LEAD,
  placementSettingsPatch,
  reduceAppearancePreview,
  resolveOnboardingPlacementSync,
  saveOnboardingAppearanceChoice,
  seedOnboardingAppearance,
  seedOnboardingPlacement
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
    expect(placementSettingsPatch('right-edge', 'bar')).toEqual({
      overlayPlacement: 'right-edge',
      overlayLayout: 'island',
      autoHideOverlay: true
    })
    expect(placementSettingsPatch('top-center', 'island')).toEqual({
      overlayPlacement: 'top-center',
      overlayLayout: 'island',
      autoHideOverlay: true
    })
  })

  it('atomically saves right-edge with Island and auto-hide', async () => {
    const saveSettings = vi.fn(async (next: Partial<PublicSettings>) => ({
      overlayPlacement: next.overlayPlacement ?? 'top-center',
      overlayLayout: next.overlayLayout ?? 'hide',
      autoHideOverlay: next.autoHideOverlay ?? true
    }))

    await expect(persistOverlayPlacement('right-edge', 'bar', saveSettings)).resolves.toBe(true)
    expect(saveSettings).toHaveBeenCalledWith({
      overlayPlacement: 'right-edge',
      overlayLayout: 'island',
      autoHideOverlay: true
    })
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
    expect(experience).toMatch(/appearanceSettingsPatch\(id\)/)
    expect(experience).toMatch(/persistOverlayPlacement\(id, appearance, patch\)/)
    expect(experience).toMatch(/saveOnboardingAppearanceChoice/)
    expect(experience).toMatch(/resolveOnboardingPlacementSync/)
    expect(experience).toMatch(/const placementUserSelectedRef = useRef\(false\)/)
    expect(experience).toMatch(/placementUserSelectedRef\.current = true/)
    expect(experience).toMatch(/incoming: settings\?\.overlayPlacement/)
    expect(experience).toMatch(/managed: placementManaged/)
  })
})

describe('onboarding appearance — Tony copy', () => {
  it('asks Hidden vs Island vs Bar with click-to-open Hidden and no em dash', () => {
    expect(ONBOARDING_APPEARANCE_COPY.hide.title).toBe('Hidden')
    expect(ONBOARDING_APPEARANCE_COPY.hide.desc).toBe('Move to the top, then click to open.')
    expect(ONBOARDING_APPEARANCE_COPY.island.title).toBe('Island')
    expect(ONBOARDING_APPEARANCE_COPY.bar.title).toBe('Bar')
    expect(ONBOARDING_APPEARANCE_HEADING).toBe('Where should Métis live?')
    expect(ONBOARDING_APPEARANCE_LEAD).toMatch(/Hidden is the default/)
    const all = `${ONBOARDING_APPEARANCE_HEADING} ${ONBOARDING_APPEARANCE_LEAD} ${Object.values(ONBOARDING_APPEARANCE_COPY)
      .map((c) => `${c.title} ${c.desc}`)
      .join(' ')}`
    expect(all).not.toMatch(/\u2014/)
    expect(all).not.toMatch(/Vibe Island/)
    expect(appearanceLib).not.toMatch(/\u2014/)
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

  it('preview is CSS-only: no setBounds, Bar, Listen, orb, WebGL, or rAF', () => {
    expect(component).toMatch(/onboard-appearance-preview/)
    expect(component).toMatch(/resolveOverlayPresentation/)
    expect(component).toMatch(/data-edge-tab="true"/)
    expect(component).toMatch(/data-edge-drawer="true"/)
    expect(component.indexOf('<OverlayPlacementPicker')).toBeLessThan(component.indexOf('<OverlayChromePicker'))
    expect(component).toMatch(/overlay-spring/)
    expect(component).not.toMatch(/setBounds/)
    expect(component).not.toMatch(/from '\.\/Bar'/)
    expect(component).not.toMatch(/Listen/)
    expect(component).not.toMatch(/requestAnimationFrame/)
    expect(component).not.toMatch(/WebGL/)
    expect(component).not.toMatch(/from 'three'/)
    expect(css).toMatch(/\.onboard-appearance-preview__island/)
    expect(css).toMatch(/\.onboard-appearance-preview__bar/)
    expect(css).not.toMatch(/\.onboard-appearance-preview[^{]*\{[^}]*backdrop-filter/)
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
