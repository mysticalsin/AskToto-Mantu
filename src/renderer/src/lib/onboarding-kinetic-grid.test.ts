import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { overlayWindowChrome } from '../../../main/island/geometry'
import { canMarkOnboardingDone } from './onboarding-flow'
import { ONBOARDING_HERO_VIDEO_SRC } from './onboarding-hero-video'
import {
  KINETIC_COLORS,
  KINETIC_DPR_CAP,
  KINETIC_GRID_SCENES,
  edgePinFactor,
  kineticPixelRatio,
  lerp2,
  rippleOffset,
  shouldMountKineticGrid,
  tileWarp
} from './onboarding-kinetic-grid'
import { shouldMountStarfield } from './onboarding-starfield-spec'

const root = join(__dirname, '..')
const kineticLib = readFileSync(join(__dirname, './onboarding-kinetic-grid.ts'), 'utf8')
const kineticHost = readFileSync(join(root, 'components/onboarding/KineticGrid.tsx'), 'utf8')
const experience = readFileSync(join(root, 'components/OnboardingExperience.tsx'), 'utf8')
const demo = readFileSync(join(root, 'components/OnboardingDemoScene.tsx'), 'utf8')
const settings = readFileSync(join(root, 'components/Settings.tsx'), 'utf8')
const css = readFileSync(join(root, 'styles.css'), 'utf8')
const engine = readFileSync(join(__dirname, './onboarding-starfield-engine.ts'), 'utf8')
const flow = readFileSync(join(__dirname, './onboarding-flow.ts'), 'utf8')
const live = [experience, demo].join('\n')

const TOUR = [
  'hero',
  'problem',
  'reveal',
  'setup',
  'personalize',
  'license',
  'appearance',
  'ready'
] as const

describe('KineticGrid file + Mantu colors + pointer-events none + no stage slide', () => {
  it('ships the canvas host at the contracted path', () => {
    expect(existsSync(join(root, 'components/onboarding/KineticGrid.tsx'))).toBe(true)
    expect(kineticHost).toMatch(/export function KineticGrid/)
    expect(kineticHost).not.toMatch(/from ['"]@\/components\/ui/)
    expect(kineticHost).not.toMatch(/shadcn/)
  })

  it('pins Mantu purples, not #161618 or blue', () => {
    expect(KINETIC_COLORS.bg).toBe('#05010a')
    expect(KINETIC_COLORS.bgDeep).toBe('#1A0033')
    expect(KINETIC_COLORS.lineActive).toBe('#7F00DA')
    expect(KINETIC_COLORS.nodeActive).toBe('#9A2BF0')
    expect(KINETIC_COLORS.glow).toBe('#9A2BF0')
    expect(KINETIC_COLORS.ripple).toBe('#7F00DA')
    expect(KINETIC_COLORS.lineBase).toMatch(/196,\s*132,\s*252/)
    expect(JSON.stringify(KINETIC_COLORS)).not.toMatch(/#161618/)
    expect(JSON.stringify(KINETIC_COLORS)).not.toMatch(/#4C|blue/i)
    expect(css).toMatch(/\.onboard-kinetic-grid \{[\s\S]*?background:\s*#05010a/)
    expect(css).not.toMatch(/onboard-stripes/)
    expect(css).not.toMatch(/onboard-stripe-spin/)
  })

  it('canvas and wrapper are pointer-events none; mouse warps tiles only', () => {
    const grid = css.slice(css.indexOf('.onboard-kinetic-grid {'), css.indexOf('.aw-orb {'))
    expect(grid).toMatch(/pointer-events:\s*none/)
    expect(grid).toMatch(/\.onboard-kinetic-grid canvas \{[\s\S]*?pointer-events:\s*none/)
    expect(kineticHost).toMatch(/aria-hidden/)
    expect(kineticHost).toMatch(/requestAnimationFrame\(paint\)/)
    expect(kineticHost).not.toMatch(/setInterval/)
    expect(kineticHost).toMatch(/document\.hidden/)
    expect(kineticLib).toMatch(/KINETIC_DPR_CAP = 2/)
    expect(kineticPixelRatio(3)).toBe(KINETIC_DPR_CAP)
    expect(kineticPixelRatio(1.5)).toBe(1.5)
    expect(experience).not.toMatch(/transform:\s*`translate/)
    expect(experience).not.toMatch(/ndc\.x \* CONFIG\.parallax/)
    expect(engine).not.toMatch(/ndc\.x \* CONFIG\.parallax/)
    expect(engine).toMatch(/camera\.position\.set\(0, 0, 5 - scroll \* CONFIG\.scrollPush\)/)
    const warp = tileWarp({ cx: 220, cy: 200, mx: 200, my: 200, width: 800, height: 600 })
    expect(warp.dx).not.toBe(0)
    expect(edgePinFactor(0, 0, 800, 600)).toBe(0)
    expect(lerp2({ x: 0, y: 0 }, { x: 10, y: 10 }, 0.5)).toEqual({ x: 5, y: 5 })
    expect(rippleOffset({ cx: 0, cy: 0, ox: 0, oy: 0, ageSec: 10 })).toBe(0)
  })
})

describe('starfield is not mounted after the lady beat', () => {
  it('April 29 lady+universe is hero only; KineticGrid owns the rest', () => {
    expect(ONBOARDING_HERO_VIDEO_SRC).toMatch(/hf_20260429_115139_0fc6bd3d/)
    expect(ONBOARDING_HERO_VIDEO_SRC).not.toMatch(/hf_20260319_055001/)
    expect(experience).toMatch(/\{scene === 'hero' && <OnboardingHeroVideo/)
    expect(KINETIC_GRID_SCENES).toEqual([
      'problem',
      'reveal',
      'appearance',
      'setup',
      'personalize',
      'license',
      'ready'
    ])
    expect(shouldMountKineticGrid('hero')).toBe(false)
    expect(shouldMountStarfield('hero')).toBe(false)
    for (const scene of KINETIC_GRID_SCENES) {
      expect(shouldMountKineticGrid(scene)).toBe(true)
      expect(shouldMountStarfield(scene)).toBe(false)
    }
    for (const scene of TOUR) {
      expect(shouldMountStarfield(scene)).toBe(false)
    }
    expect(shouldMountStarfield('skip')).toBe(false)
    expect(experience).toMatch(/shouldMountKineticGrid\(scene\) && <KineticGrid/)
    expect(experience).not.toMatch(/<OnboardingStarfield/)
    expect(experience).not.toMatch(/shouldMountStarfield/)
    expect(experience).not.toMatch(/starfieldFailed|starfieldPulse/)
  })
})

describe('no Skip control in the live onboarding tree', () => {
  it('deletes Skip the tour, skip scene, Skip to the end, and Get started-skip', () => {
    expect(flow).not.toMatch(/'skip'/)
    expect(live).not.toMatch(/Skip the tour/)
    expect(live).not.toMatch(/Skip to the end/)
    expect(live).not.toMatch(/setScene\('skip'\)/)
    expect(live).not.toMatch(/scene === 'skip'/)
    expect(live).not.toMatch(/onSkipToEnd/)
    expect(live).not.toMatch(/onSkip=/)
    expect(live).not.toMatch(/onboard-skip-chip/)
    expect(live).not.toMatch(/onboard-skip-screen/)
    expect(demo).not.toMatch(/Skip/)
  })
})

describe('onboardingDone cannot become true without completing Ready', () => {
  it('canMarkOnboardingDone is Ready + files + consent only', () => {
    expect(canMarkOnboardingDone({ scene: 'ready', asrReady: true, consent: true })).toBe(true)
    expect(canMarkOnboardingDone({ scene: 'hero', asrReady: true, consent: true })).toBe(false)
    expect(canMarkOnboardingDone({ scene: 'problem', asrReady: true, consent: true })).toBe(false)
    expect(canMarkOnboardingDone({ scene: 'reveal', asrReady: true, consent: true })).toBe(false)
    expect(canMarkOnboardingDone({ scene: 'setup', asrReady: true, consent: true })).toBe(false)
    expect(canMarkOnboardingDone({ scene: 'personalize', asrReady: true, consent: true })).toBe(false)
    expect(canMarkOnboardingDone({ scene: 'license', asrReady: true, consent: true })).toBe(false)
    expect(canMarkOnboardingDone({ scene: 'appearance', asrReady: true, consent: true })).toBe(false)
    expect(canMarkOnboardingDone({ scene: 'skip', asrReady: true, consent: true })).toBe(false)
    expect(canMarkOnboardingDone({ scene: 'ready', asrReady: false, consent: true })).toBe(false)
    expect(canMarkOnboardingDone({ scene: 'ready', asrReady: true, consent: false })).toBe(false)
    expect(experience).toMatch(/canMarkOnboardingDone\(\{ scene, asrReady, consent \}\)/)
    const finish = experience.slice(experience.indexOf('const finish = async'))
    expect(finish.indexOf('canMarkOnboardingDone')).toBeGreaterThan(-1)
    expect(finish.indexOf('canMarkOnboardingDone')).toBeLessThan(finish.indexOf('onDone({ mode, recordingConsent: true })'))
    const v2 = experience.slice(experience.indexOf('export function OnboardingV2'))
    expect(v2).toMatch(/onboardingDone: true/)
    expect(v2).not.toMatch(/scene === 'skip'/)
  })
})

describe('haltAllOnboardingAudio still before Ready and Replay', () => {
  it('Ready finish and Settings Replay halt Goldberg first', () => {
    const finish = experience.slice(experience.indexOf('const finish = async'))
    expect(finish.indexOf('haltAllOnboardingAudio()')).toBeGreaterThan(-1)
    expect(finish.indexOf('haltAllOnboardingAudio()')).toBeLessThan(finish.indexOf('onDone({ mode, recordingConsent: true })'))
    const v2 = experience.slice(experience.indexOf('onDone={async ({ mode, recordingConsent })'))
    expect(v2.indexOf('haltAllOnboardingAudio()')).toBeGreaterThan(-1)
    expect(v2.indexOf('haltAllOnboardingAudio()')).toBeLessThan(v2.indexOf('onboardingDone: true'))
    const replay = settings.slice(settings.indexOf('Replay onboarding from the start?'))
    expect(replay.indexOf('haltAllOnboardingAudio()')).toBeGreaterThan(-1)
    expect(replay.indexOf('haltAllOnboardingAudio()')).toBeLessThan(replay.indexOf('patch({ onboardingDone: false })'))
  })
})

describe('exclusive window stays opaque hero hold while !onboardingDone', () => {
  it('live chrome is #05010A and not purple wash', () => {
    expect(overlayWindowChrome(true)).toEqual({
      transparent: false,
      backgroundColor: '#05010A',
      fullscreenable: true,
      roundedCorners: false
    })
    expect(overlayWindowChrome(true).backgroundColor).not.toBe('#3A0B6B')
    expect(overlayWindowChrome(false).transparent).toBe(true)
  })
})

describe('10-pass tour walk — one scene, KineticGrid after lady, Continue visible', () => {
  it('walks every act: lady → kinetic → remaining steps → Ready', () => {
    expect(experience).toMatch(/scene === 'hero'/)
    expect(experience).toMatch(/scene === 'problem'/)
    expect(experience).toMatch(/scene === 'reveal'/)
    expect(experience).toMatch(/scene === 'setup'/)
    expect(experience).toMatch(/scene === 'personalize'/)
    expect(experience).toMatch(/scene === 'license'/)
    expect(experience).toMatch(/scene === 'appearance'/)
    expect(experience).toMatch(/scene === 'ready'/)
    const problem = experience.slice(experience.indexOf("scene === 'problem'"), experience.indexOf("scene === 'reveal'"))
    expect(problem).toMatch(/onboard-cta no-drag focus-ring/)
    expect(problem.search(/>\s*Continue\s*</)).toBeGreaterThan(-1)
    expect(experience).toMatch(/showAsrRetry=\{asrRowNeedsRetry\(asrRow\)\}/)
    expect(experience).toMatch(/Try again|onRetryAsr/)
    expect(css).toMatch(/\.onboard-cta \{[\s\S]*?opacity:\s*1/)
    expect(css).toMatch(/\.onboard-tour-slot[\s\S]*?z-index:\s*2/)
  })
})
