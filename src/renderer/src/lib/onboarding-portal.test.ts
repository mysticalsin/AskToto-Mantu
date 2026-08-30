import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ONBOARDING_PORTAL_CLOSE_GAIN,
  ONBOARDING_PORTAL_MS,
  ONBOARDING_PORTAL_OPEN_GAIN,
  PORTAL_CLOSE_SAMPLES,
  PORTAL_OPEN_SAMPLES,
  closeOnboardingPortal,
  onboardingPortalWaitMs
} from './onboarding-portal'

const experience = readFileSync(join(__dirname, '../components/OnboardingExperience.tsx'), 'utf8')
const css = readFileSync(join(__dirname, '../styles.css'), 'utf8')
const portalSrc = readFileSync(join(__dirname, './onboarding-portal.ts'), 'utf8')

describe('onboarding portal iris + skip path', () => {
  it('precomputes short whooshes at module load; close is quieter than open', () => {
    expect(PORTAL_OPEN_SAMPLES.length).toBeGreaterThan(1000)
    expect(PORTAL_CLOSE_SAMPLES.length).toBeGreaterThan(PORTAL_OPEN_SAMPLES.length)
    expect(ONBOARDING_PORTAL_CLOSE_GAIN).toBeLessThan(ONBOARDING_PORTAL_OPEN_GAIN)
    expect(portalSrc).toMatch(/export const PORTAL_OPEN_SAMPLES = whoosh/)
    expect(portalSrc).toMatch(/playPrecomputed\(PORTAL_CLOSE_SAMPLES/)
    expect(experience).toMatch(/playPortalOpen\(/)
    expect(experience).toMatch(/await closeOnboardingPortal\(/)
    const finish = experience.slice(experience.indexOf('const finish = async'))
    expect(finish.indexOf('closeOnboardingPortal')).toBeGreaterThan(-1)
    expect(finish.indexOf('closeOnboardingPortal')).toBeLessThan(finish.indexOf('onDone({ mode, recordingConsent: true })'))
  })

  it('portal CSS opens and closes via clip-path; reduced-motion disables the iris', () => {
    expect(ONBOARDING_PORTAL_MS).toBeGreaterThanOrEqual(500)
    expect(ONBOARDING_PORTAL_MS).toBeLessThanOrEqual(700)
    expect(css).toMatch(/@keyframes onboard-portal-open/)
    expect(css).toMatch(/@keyframes onboard-portal-close/)
    expect(css).toMatch(/clip-path:\s*circle/)
    expect(css).toMatch(/\.onboard-stage--portal-close/)
    expect(css).toMatch(
      /prefers-reduced-motion: reduce\) \{[\s\S]*?\.onboard-stage--portal-close \{[\s\S]*?animation:\s*none;[\s\S]*?clip-path:\s*none/
    )
    expect(onboardingPortalWaitMs(true)).toBe(0)
    expect(onboardingPortalWaitMs(false)).toBe(ONBOARDING_PORTAL_MS)
  })

  it('Skip does not mount Onboarding.tsx and still requires recordingConsent before finish', () => {
    const app = readFileSync(join(__dirname, '../App.tsx'), 'utf8')
    expect(experience).not.toMatch(/from '\.\/Onboarding'/)
    expect(experience).not.toMatch(/<Onboarding[\s>]/)
    expect(experience).not.toMatch(/legacy-full/)
    expect(app).not.toMatch(/from '\.\/components\/Onboarding'/)
    expect(experience).toMatch(/setScene\('skip'\)/)
    expect(experience).toMatch(/scene === 'skip'/)
    expect(experience).toMatch(/onboard-skip-chip/)
    const skip = experience.slice(experience.indexOf("scene === 'skip'"))
    expect(skip).toMatch(/TellTheRoomCard/)
    expect(skip).toMatch(/Get started/)
    expect(skip).toMatch(/disabled=\{\!consent\}/)
    expect(skip).toMatch(/onClick=\{\(\) => void finish\(\)\}/)
    expect(skip).not.toMatch(/from '\.\/Onboarding'/)
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
