import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ONBOARDING_PORTAL_CLOSE_GAIN,
  ONBOARDING_PORTAL_CLOSE_MS,
  ONBOARDING_PORTAL_CLOSE_SECONDS,
  ONBOARDING_PORTAL_MS,
  ONBOARDING_PORTAL_OPEN_GAIN,
  ONBOARDING_PORTAL_OPEN_MS,
  ONBOARDING_PORTAL_OPEN_SECONDS,
  ONBOARDING_PORTAL_SAMPLE_RATE,
  PORTAL_CLOSE_SAMPLES,
  PORTAL_OPEN_SAMPLES,
  closeOnboardingPortal,
  onboardingPortalWaitMs,
  requestOnboardingPortalOpen,
  requestOnboardingPortalClose
} from './onboarding-portal'

const experience = readFileSync(join(__dirname, '../components/OnboardingExperience.tsx'), 'utf8')
const css = readFileSync(join(__dirname, '../styles.css'), 'utf8')
const portalSrc = readFileSync(join(__dirname, './onboarding-portal.ts'), 'utf8')
const stageStart = css.indexOf('.onboard-stage {')
const stageBlock = css.slice(stageStart, css.indexOf('@media (prefers-reduced-motion: reduce)', stageStart))
const baseStageBlock = css.slice(stageStart, css.indexOf('.onboard-stage--portal-close', stageStart))

describe('onboarding portal pill + Ready-only finish', () => {
  it('precomputes different sci-fi open and close buffers at module load', () => {
    expect(PORTAL_OPEN_SAMPLES.length / ONBOARDING_PORTAL_SAMPLE_RATE).toBeGreaterThanOrEqual(1.1)
    expect(PORTAL_CLOSE_SAMPLES.length / ONBOARDING_PORTAL_SAMPLE_RATE).toBeGreaterThanOrEqual(1.1)
    expect(ONBOARDING_PORTAL_OPEN_SECONDS).toBeGreaterThanOrEqual(1.1)
    expect(ONBOARDING_PORTAL_CLOSE_SECONDS).toBeGreaterThanOrEqual(1.1)
    expect(PORTAL_OPEN_SAMPLES).not.toEqual(PORTAL_CLOSE_SAMPLES)
    expect(portalSrc).toMatch(/function sciFiOpen/)
    expect(portalSrc).toMatch(/function sciFiClose/)
    expect(portalSrc).not.toMatch(/export const PORTAL_OPEN_SAMPLES = whoosh/)
    expect(portalSrc).toMatch(/export const PORTAL_OPEN_SAMPLES = sciFiOpen/)
    expect(portalSrc).toMatch(/export const PORTAL_CLOSE_SAMPLES = sciFiClose/)
    expect(ONBOARDING_PORTAL_CLOSE_GAIN).toBeLessThan(ONBOARDING_PORTAL_OPEN_GAIN)
    expect(experience).toMatch(/playPortalOpen\(/)
    expect(experience).toMatch(/await closeOnboardingPortal\(/)
    const finish = experience.slice(experience.indexOf('const finish = async ('))
    expect(finish.indexOf('closeOnboardingPortal')).toBeGreaterThan(-1)
    expect(finish.indexOf('closeOnboardingPortal')).toBeLessThan(finish.indexOf('onDone({ mode, recordingConsent: true, destination })'))
  })

  it('keeps the full onboarding window opaque instead of opening it through a desktop-revealing mask', () => {
    expect(ONBOARDING_PORTAL_OPEN_MS).toBeGreaterThanOrEqual(1100)
    expect(ONBOARDING_PORTAL_OPEN_MS).toBeLessThanOrEqual(1400)
    expect(ONBOARDING_PORTAL_CLOSE_MS).toBeGreaterThanOrEqual(1100)
    expect(ONBOARDING_PORTAL_CLOSE_MS).toBeLessThanOrEqual(1400)
    expect(ONBOARDING_PORTAL_MS).toBe(ONBOARDING_PORTAL_CLOSE_MS)
    expect(stageBlock).not.toMatch(/clip-path:\s*circle\(8% at 50% 0%\)/)
    expect(stageBlock).not.toMatch(/clip-path:\s*circle/)
    expect(stageBlock).toMatch(/background:\s*#05010a/)
    expect(baseStageBlock).not.toMatch(/mask-image/)
    expect(baseStageBlock).not.toMatch(/mask-size/)
    expect(baseStageBlock).not.toMatch(/animation:/)
    expect(css).not.toMatch(/@keyframes onboard-portal-open/)
    expect(css).not.toMatch(/@keyframes onboard-portal-close/)
    expect(css).toMatch(/\.onboard-stage\.onboard-stage--portal-open\s*\{[\s\S]*?background:\s*#05010a/)
    expect(css).toMatch(/\.onboard-stage--portal-close\s*\{[\s\S]*?background:\s*#05010a/)
    // A final exit may move content, but the window bed itself must remain opaque.
    expect(css).toMatch(/\.onboard-stage--portal-close \.onboard-portal-content[\s\S]*?animation:\s*onboard-portal-content-out/)
    expect(css).toMatch(/\.onboard-stage\.onboard-stage--portal-open \.onboard-portal-content[\s\S]*?opacity:\s*1/)
    // FITO-185-P
    expect(css).toMatch(/onboard-stage--portal-open \.fade-up/)

    expect(css).toMatch(/\.onboard-portal-content/)
    expect(css).toMatch(/@keyframes onboard-portal-content-out/)
    expect(css).toMatch(
      /prefers-reduced-motion: reduce\) \{[\s\S]*?\.onboard-stage--portal-close \{[\s\S]*?animation:\s*none/
    )
    expect(onboardingPortalWaitMs(true)).toBe(0)
    expect(onboardingPortalWaitMs(false)).toBe(ONBOARDING_PORTAL_CLOSE_MS)
  })

  it('Ready is the only finish; does not mount Onboarding.tsx; recordingConsent still required', () => {
    const app = readFileSync(join(__dirname, '../App.tsx'), 'utf8')
    expect(experience).not.toMatch(/from '\.\/Onboarding'/)
    expect(experience).not.toMatch(/<Onboarding[\s>]/)
    expect(experience).not.toMatch(/legacy-full/)
    expect(app).not.toMatch(/from '\.\/components\/Onboarding'/)
    expect(experience).not.toMatch(/setScene\('skip'\)/)
    expect(experience).not.toMatch(/scene === 'skip'/)
    expect(experience).not.toMatch(/onboard-skip-chip/)
    expect(experience).toMatch(/canMarkOnboardingDone\(\{ scene, asrReady, consent \}\)/)
    expect(experience).toMatch(/recordingConsent: true/)
    expect(experience).toMatch(/onboardingDone: true/)
    const v2 = experience.slice(experience.indexOf('export function OnboardingV2'))
    expect(v2).toMatch(/mode, recordingConsent, onboardingDone: true/)
  })
})

describe('closeOnboardingPortal call order', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('removes the open state before it starts the close state', () => {
    const classes = new Set(['onboard-stage--portal-open'])
    const classList = {
      add: (value: string) => classes.add(value),
      remove: (value: string) => classes.delete(value),
      contains: (value: string) => classes.has(value)
    }
    vi.stubGlobal('document', {
      querySelector: vi.fn(() => ({ classList }))
    })

    requestOnboardingPortalClose()

    expect(classList.contains('onboard-stage--portal-open')).toBe(false)
    expect(classList.contains('onboard-stage--portal-close')).toBe(true)
  })

  it('removes a prior close state when onboarding opens again after a recoverable save failure', () => {
    const classes = new Set(['onboard-stage--portal-close'])
    const classList = {
      add: (value: string) => classes.add(value),
      remove: (value: string) => classes.delete(value),
      contains: (value: string) => classes.has(value)
    }
    vi.stubGlobal('document', {
      querySelector: vi.fn(() => ({ classList }))
    })

    requestOnboardingPortalOpen()

    expect(classList.contains('onboard-stage--portal-close')).toBe(false)
    expect(classList.contains('onboard-stage--portal-open')).toBe(true)
  })

  it('requests the close class as part of the helper (exclusive exit happens after)', async () => {
    expect(portalSrc).toMatch(/playPortalClose\(muted\)\s*\n\s*requestOnboardingPortalClose\(\)/)
    expect(closeOnboardingPortal).toBeTypeOf('function')
    const start = Date.now()
    await closeOnboardingPortal(true, true)
    expect(Date.now() - start).toBeLessThan(50)
  })
})

describe('FITO-185-L portal-open on Act 1 first paint', () => {
  it('App exclusive stage ships an opaque portal-open bed from its first paint', () => {
    const app = readFileSync(join(__dirname, '../App.tsx'), 'utf8')
    expect(app).toMatch(/onboard-stage onboard-stage--portal-open onboard-exclusive-lock/)
    const openBlock = css.slice(
      css.indexOf('.onboard-stage.onboard-stage--portal-open {'),
      css.indexOf('.onboard-stage.onboard-stage--portal-open .onboard-portal-content')
    )
    expect(openBlock).toMatch(/background:\s*#05010a/)
    expect(openBlock).not.toMatch(/mask-/)
    expect(openBlock).not.toMatch(/animation:/)
  })

  it('HeroWelcome + Act1 mount call requestOnboardingPortalOpen immediately (no 1400ms race)', () => {
    expect(experience).toMatch(/requestOnboardingPortalOpen/)
    expect(experience).toMatch(/function HeroWelcome[\s\S]*?useLayoutEffect\(\(\) => \{[\s\S]*?requestOnboardingPortalOpen\(\)/)
    expect(experience).not.toMatch(/setTimeout\([\s\S]*?onboard-stage--portal-open[\s\S]*?1400\)/)
    expect(portalSrc).toMatch(/export function requestOnboardingPortalOpen/)
    expect(requestOnboardingPortalOpen).toBeTypeOf('function')
  })

  it('hero poster stays opacity 1 above the #05010A stage slab', () => {
    expect(css).toMatch(/\.onboard-hero-poster\s*\{[\s\S]*?opacity:\s*1/)
    expect(css).toMatch(/\.onboard-hero-poster\s*\{[\s\S]*?z-index:\s*1/)
  })
})

describe('FITO-185-V portal-open keeps entrance animations', () => {
  it('unlocks opacity/visibility under portal-open without animation:none (except reduced-motion)', () => {
    const unlock = css.slice(
      css.indexOf('FITO-185-V: keep opacity'),
      css.indexOf('/* Liquid glass')
    )
    const ruleBody = unlock.slice(unlock.indexOf('{'), unlock.lastIndexOf('}') + 1)
    expect(ruleBody).toMatch(/opacity:\s*1\s*!important/)
    expect(ruleBody).toMatch(/visibility:\s*visible\s*!important/)
    expect(ruleBody).not.toMatch(/animation:\s*none/)
    expect(ruleBody).not.toMatch(/transform:\s*none/)
    expect(css).toMatch(/onboard-hero-kenburns/)
    // Kenburns must not be killed under portal-open
    expect(css).not.toMatch(
      /onboard-stage--portal-open[\s\S]{0,400}onboard-hero-video video[\s\S]{0,80}animation:\s*none/
    )
    const prm = css.slice(css.indexOf('FITO-185-V: reduced-motion portal-open'))
    const prmBlock = prm.slice(0, prm.indexOf('/* Act 1 welcome atmosphere'))
    expect(prmBlock).toMatch(/FITO-185-V: reduced-motion portal-open/)
    expect(prmBlock).toMatch(/animation:\s*none\s*!important/)
  })
})
