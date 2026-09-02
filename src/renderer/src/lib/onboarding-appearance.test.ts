import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
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
  reduceAppearancePreview,
  seedOnboardingAppearance
} from './onboarding-appearance'
import { shouldMountKineticGrid, KINETIC_GRID_SCENES } from './onboarding-kinetic-grid'
import { shouldMountStarfield } from './onboarding-starfield-spec'
import { sceneAfterAppearance, sceneAfterLicense, sceneAfterPersonalize } from './onboarding-flow'

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

  it('finish / onDone never writes overlayLayout', () => {
    expect(experience).toMatch(/mode, recordingConsent, onboardingDone: true, onboardingDoneAt: Date\.now\(\)/)
    expect(experience).not.toMatch(/onDone\(\{[\s\S]*overlayLayout/)
    expect(experience).toMatch(/appearanceSettingsPatch\(id\)/)
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

describe('onboarding appearance — scene hop is a tail beat', () => {
  it('sits after personalize/license and before Ready; KineticGrid is the bed, not skip', () => {
    expect(sceneAfterPersonalize(false)).toBe('appearance')
    expect(sceneAfterPersonalize(true)).toBe('license')
    expect(sceneAfterLicense()).toBe('appearance')
    expect(sceneAfterAppearance()).toBe('ready')
    expect(KINETIC_GRID_SCENES).toContain('appearance')
    expect(shouldMountKineticGrid('appearance')).toBe(true)
    expect(shouldMountStarfield('appearance')).toBe(false)
    expect(shouldMountStarfield('hero')).toBe(false)
    expect(shouldMountStarfield('reveal')).toBe(false)
    expect(experience).toMatch(/GUIDED_SCENES: Scene\[\] = \['problem', 'reveal', 'setup', 'personalize'\]/)
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
