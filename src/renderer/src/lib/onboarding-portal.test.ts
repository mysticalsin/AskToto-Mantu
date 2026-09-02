import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
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
  onboardingPortalWaitMs
} from './onboarding-portal'

const experience = readFileSync(join(__dirname, '../components/OnboardingExperience.tsx'), 'utf8')
const css = readFileSync(join(__dirname, '../styles.css'), 'utf8')
const portalSrc = readFileSync(join(__dirname, './onboarding-portal.ts'), 'utf8')
const stageBlock = css.slice(css.indexOf('.onboard-stage {'), css.indexOf('.onboard-stripes,'))

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
    const finish = experience.slice(experience.indexOf('const finish = async'))
    expect(finish.indexOf('closeOnboardingPortal')).toBeGreaterThan(-1)
    expect(finish.indexOf('closeOnboardingPortal')).toBeLessThan(finish.indexOf('onDone({ mode, recordingConsent: true })'))
  })

  it('opens as a slow soft pill, not a clip-path circle pop', () => {
    expect(ONBOARDING_PORTAL_OPEN_MS).toBeGreaterThanOrEqual(1100)
    expect(ONBOARDING_PORTAL_OPEN_MS).toBeLessThanOrEqual(1400)
    expect(ONBOARDING_PORTAL_CLOSE_MS).toBeGreaterThanOrEqual(1100)
    expect(ONBOARDING_PORTAL_CLOSE_MS).toBeLessThanOrEqual(1400)
    expect(ONBOARDING_PORTAL_MS).toBe(ONBOARDING_PORTAL_CLOSE_MS)
    expect(stageBlock).not.toMatch(/clip-path:\s*circle\(8% at 50% 0%\)/)
    expect(stageBlock).not.toMatch(/clip-path:\s*circle/)
    expect(css).toMatch(/@keyframes onboard-portal-open/)
    expect(css).toMatch(/@keyframes onboard-portal-close/)
    expect(css).toMatch(/cubic-bezier\(0\.22,\s*1,\s*0\.36,\s*1\)/)
    expect(css).toMatch(/cubic-bezier\(0\.4,\s*0,\s*0\.2,\s*1\)/)
    expect(css).toMatch(/mask-size:\s*120px 36px/)
    expect(css).toMatch(/\.onboard-stage--portal-close/)
    expect(css).toMatch(/\.onboard-portal-content/)
    expect(css).toMatch(/translateY\(8px\)/)
    expect(css).toMatch(
      /prefers-reduced-motion: reduce\) \{[\s\S]*?\.onboard-stage--portal-close \{[\s\S]*?animation:\s*none;[\s\S]*?mask-image:\s*none/
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
  it('requests the close class as part of the helper (exclusive exit happens after)', async () => {
    expect(portalSrc).toMatch(/playPortalClose\(muted\)\s*\n\s*requestOnboardingPortalClose\(\)/)
    expect(closeOnboardingPortal).toBeTypeOf('function')
    const start = Date.now()
    await closeOnboardingPortal(true, true)
    expect(Date.now() - start).toBeLessThan(50)
  })
})
