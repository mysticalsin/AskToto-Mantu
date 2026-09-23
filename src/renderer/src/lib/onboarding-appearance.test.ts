import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { PublicSettings } from '@shared/ipc'
import { OnboardingAppearance } from '../components/OnboardingAppearance'
import { persistOverlayPlacement } from './overlay-placement-save'
import {
  appearancePreviewEdgeState,
  appearancePreviewInitialPhase,
  appearancePreviewStateKey,
  appearancePreviewRestKind,
  appearancePreviewShowsBar,
  appearancePreviewShowsHint,
  appearancePreviewShowsIsland,
  appearanceSettingsPatch,
  onboardingAppearanceCopy,
  ONBOARDING_APPEARANCE_COPY,
  ONBOARDING_APPEARANCE_HEADING,
  ONBOARDING_APPEARANCE_LEAD,
  placementSettingsPatch,
  placementDemoLayout,
  placementPreviewCaption,
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
const e2eSmoke = readFileSync(join(__dirname, '../../../../scripts/e2e-smoke.mjs'), 'utf8')

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
    expect(ONBOARDING_APPEARANCE_HEADING).toBe('How should Métis look?')
    expect(ONBOARDING_APPEARANCE_LEAD).toMatch(/Choose a resting shape/)
    const all = `${ONBOARDING_APPEARANCE_HEADING} ${ONBOARDING_APPEARANCE_LEAD} ${Object.values(ONBOARDING_APPEARANCE_COPY)
      .map((c) => `${c.title} ${c.desc}`)
      .join(' ')}`
    expect(all).not.toMatch(/\u2014/)
    expect(all).not.toMatch(/Vibe Island/)
    expect(appearanceLib).not.toMatch(/\u2014/)
  })
})

describe('onboarding appearance — live preview, no lag', () => {
  // MQA-341: a right-edge placement must not preview an almost invisible top-edge resting state.
  it('shows a legible placement demonstration without changing the saved resting shape', () => {
    expect(placementDemoLayout('top-center')).toBe('bar')
    expect(placementDemoLayout('right-edge')).toBe('island')
    expect(placementPreviewCaption('top-center')).toMatch(/top of your screen/i)
    expect(placementPreviewCaption('right-edge')).toMatch(/right edge/i)

    const markup = renderToStaticMarkup(
      createElement(OnboardingAppearance, {
        value: 'hide',
        locked: false,
        placement: 'right-edge',
        placementLocked: false,
        onChange: vi.fn(),
        onPlacementChange: vi.fn()
      })
    )
    expect(markup).toContain('data-appearance-preview="island"')
    expect(markup).toContain('data-placement-caption="right-edge"')
    expect(markup).toContain('data-onboard-appearance-step="position"')
    expect(markup).not.toContain('data-appearance-preview="bar"')
  })

  it('describes right-edge hover behavior instead of instructing a top-edge click', () => {
    expect(onboardingAppearanceCopy('top-center').hide.desc).toBe(ONBOARDING_APPEARANCE_COPY.hide.desc)
    expect(onboardingAppearanceCopy('right-edge').hide.desc).toMatch(/right edge/i)
    expect(onboardingAppearanceCopy('right-edge').hide.desc).toMatch(/hover/i)
    expect(onboardingAppearanceCopy('right-edge').hide.desc).not.toMatch(/top/i)
    expect(onboardingAppearanceCopy('right-edge').island.desc).toMatch(/right edge/i)
    expect(component).toMatch(/copy=\{onboardingAppearanceCopy\(placement\)\}/)
  })

  it('keeps right-edge Hidden invisible and gives Island the visible rail', () => {
    expect(appearancePreviewEdgeState('hide', 'rest')).toEqual({ showRail: false, showDrawer: false, showEdgeGlow: true })
    expect(appearancePreviewEdgeState('hide', 'in')).toEqual({ showRail: false, showDrawer: true, showEdgeGlow: false })
    expect(appearancePreviewEdgeState('island', 'rest')).toEqual({ showRail: true, showDrawer: false, showEdgeGlow: false })
    expect(appearancePreviewEdgeState('island', 'in')).toEqual({ showRail: true, showDrawer: true, showEdgeGlow: false })
    expect(appearancePreviewEdgeState('island', 'settled')).toEqual({ showRail: true, showDrawer: true, showEdgeGlow: false })
    expect(appearancePreviewEdgeState('island', 'out')).toEqual({ showRail: true, showDrawer: true, showEdgeGlow: false })
    expect(appearancePreviewEdgeState('bar', 'settled')).toEqual({ showRail: false, showDrawer: false, showEdgeGlow: false })
  })

  it('matches the right-edge sidecar by revealing Hidden from its rail hover', () => {
    expect(reduceAppearancePreview('hide', 'rest', 'hover-enter')).toBe('rest')
    expect(reduceAppearancePreview('hide', 'rest', 'hover-enter', 'right-edge')).toBe('in')
    expect(reduceAppearancePreview('hide', 'in', 'spring-in-end', 'right-edge')).toBe('settled')
    expect(reduceAppearancePreview('hide', 'settled', 'hover-leave', 'right-edge')).toBe('out')
  })

  it('resets an Island preview when its presentation moves from the top to the right edge', () => {
    expect(appearancePreviewStateKey('island', false)).not.toBe(appearancePreviewStateKey('island', true))
    expect(appearancePreviewStateKey('island', true)).toBe('right-edge:island')
    expect(appearancePreviewStateKey('bar', false)).toBe('top-center:bar')
  })

  it('renders a compact edge rail instead of embedding a wide preview slab', () => {
    expect(component).toMatch(/appearancePreviewEdgeState/)
    expect(component).toMatch(/onboard-appearance-preview__edge-rail/)
    expect(component).toMatch(/onboard-appearance-preview__edge-glow/)
    expect(component).toMatch(/edgeState\.showEdgeGlow/)
    expect(component).toMatch(/edgeState\.showDrawer/)
    expect(component).toMatch(/useLayoutEffect/)
    expect(component).toMatch(/\[presentationLayout, previewStateKey\]/)
    expect(component).toMatch(/onFocus=\{\(\) => send\('hover-enter'\)\}/)
    expect(component).toMatch(/onBlur=\{\(\) => send\('hover-leave'\)\}/)
    expect(component).not.toMatch(/w-2\/3/)
    expect(component).not.toMatch(/<AppearanceLivePreview key=/)
    expect(css).toMatch(/\.onboard-appearance-preview__edge-rail/)
    expect(css).toMatch(/\.onboard-appearance-preview__edge-glow/)
    expect(css).toMatch(/\.onboard-appearance-preview__edge-drawer/)
    expect(css).toMatch(/width:\s*10px/)
    expect(css).toMatch(/@media \(max-height: 720px\)[\s\S]*onboard-appearance-preview__edge-drawer/)
  })

  it('requires a fresh onboarding build before accepting right-edge E2E evidence', () => {
    expect(e2eSmoke).toMatch(/OnboardingExperience\.tsx/)
    expect(e2eSmoke).toMatch(/OnboardingAppearance\.tsx/)
    expect(e2eSmoke).toMatch(/onboarding-appearance\.ts/)
    expect(e2eSmoke).toMatch(/OverlayChromePicker\.tsx/)
    expect(e2eSmoke).toMatch(/OverlayPlacementPicker\.tsx/)
    expect(e2eSmoke).toMatch(/shared', 'overlay-presentation\.ts/)
    expect(e2eSmoke).toMatch(/shared', 'overlay-chrome\.ts/)
    expect(e2eSmoke).toMatch(/shared', 'overlay-placement\.ts/)
  })

  it('exercises distinct right-edge Hidden and Island rests plus compact hover previews in E2E', () => {
    expect(e2eSmoke).toMatch(/Right-edge Hidden preview rendered a visible rail at rest/)
    expect(e2eSmoke).toMatch(/Right-edge Hidden preview did not render its faint edge glow/)
    expect(e2eSmoke).toMatch(/Right-edge Island preview did not render its compact rail/)
    expect(e2eSmoke).toMatch(/Right-edge preview rendered a drawer before it was hovered/)
    expect(e2eSmoke).toMatch(/Right-edge preview did not reveal its drawer on rail hover/)
    expect(e2eSmoke).toMatch(/Right-edge preview drawer is too wide/)
    expect(e2eSmoke).toMatch(/verifyRightEdgeOnboardingPreview\('hide'/)
    expect(e2eSmoke).toMatch(/Top-center Island preview did not expand before the placement switch/)
    expect(e2eSmoke).toMatch(/Right-edge preview is clipped inside the compact onboarding surface/)
  })

  it('keeps the 1.9.8 placement-first flow while retaining current safe pickers', () => {
    expect(component).toMatch(/const \[step, setStep\] = useState<'position' \| 'appearance'>\('position'\)/)
    expect(component).toMatch(/data-onboard-appearance-step=\{step\}/)
    expect(component).toMatch(/step === 'position'/)
    expect(component).toMatch(/Continue to appearance/)
    expect(component).toMatch(/Back to position/)
    expect(component.indexOf('<OverlayPlacementPicker')).toBeLessThan(component.indexOf('<OverlayChromePicker'))
    expect(e2eSmoke).toMatch(/Continue to appearance/)
    expect(e2eSmoke).toMatch(/Back to position/)
  })

  it('lets managed-placement users continue while keeping their placement picker read-only', () => {
    const markup = renderToStaticMarkup(
      createElement(OnboardingAppearance, {
        value: 'hide',
        locked: true,
        placement: 'right-edge',
        placementLocked: true,
        saving: false,
        onChange: vi.fn(),
        onPlacementChange: vi.fn(),
        onContinue: vi.fn()
      })
    )
    const placementOptions = [...markup.matchAll(/<button[^>]*role="radio"[^>]*>/g)].map((match) => match[0])
    const continueButton = markup.match(/<button[^>]*data-onboard-placement-continue="1"[^>]*>/)?.[0]
    expect(placementOptions).toHaveLength(2)
    expect(placementOptions.every((option) => /\sdisabled(?:=|\s|>)/.test(option))).toBe(true)
    expect(continueButton).toBeDefined()
    expect(continueButton).not.toMatch(/\sdisabled(?:=|\s|>)/)
  })

  it('guards the exact placement-to-appearance transition against a transparent or masked window frame', () => {
    expect(e2eSmoke).toMatch(/assertOpaqueOnboardingStage/)
    expect(e2eSmoke).toMatch(/before Continue to appearance/)
    expect(e2eSmoke).toMatch(/immediately after Continue to appearance/)
    expect(e2eSmoke).toMatch(/after the next compositor frame/)
    expect(e2eSmoke).toMatch(/Onboarding stage background is not opaque/)
    expect(e2eSmoke).toMatch(/Onboarding stage still has a mask/)
    expect(e2eSmoke).toMatch(/Onboarding stage is still animating/)
  })

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
    expect(component).toMatch(/data-edge-glow="true"/)
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
