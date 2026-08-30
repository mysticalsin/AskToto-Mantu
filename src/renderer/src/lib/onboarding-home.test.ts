import { describe, it, expect } from 'vitest'
import {
  onboardingHomeCopy,
  onboardingHomeSurface,
  READY_LAND_MS,
  WINDOWS_SETUP_MOMENTS
} from './onboarding-home'

describe('onboarding home surface (Mac island vs Windows strip)', () => {
  it('maps Mac to island and Windows to strip', () => {
    expect(onboardingHomeSurface(false)).toBe('island')
    expect(onboardingHomeSurface(true)).toBe('strip')
  })

  it('Mac Ready copy lands Métis in the island and keeps the Listen honesty caveat', () => {
    const c = onboardingHomeCopy('island')
    expect(c.readyTitle).toMatch(/island/i)
    expect(c.readyCta).toMatch(/Hide in my island/)
    expect(c.readyBody).toMatch(/Listen/)
    expect(c.heroTagline).toMatch(/Mac island/)
  })

  it('Windows Ready copy pins to the top strip without claiming a notch', () => {
    const c = onboardingHomeCopy('strip')
    expect(c.readyTitle).toMatch(/top of your screen/i)
    expect(c.readyCta).toMatch(/Pin to the top/)
    expect(c.readyBody).not.toMatch(/notch|Dynamic Island/i)
    expect(c.readyBody).toMatch(/Listen/)
  })

  it('Windows setup moments give the exe a denser product pitch', () => {
    expect(WINDOWS_SETUP_MOMENTS).toHaveLength(3)
    expect(WINDOWS_SETUP_MOMENTS.map((m) => m.title).join('|')).toMatch(/Hear both sides/)
  })

  it('keeps a short land animation delay so finish is not instantaneous', () => {
    expect(READY_LAND_MS).toBeGreaterThan(400)
    expect(READY_LAND_MS).toBeLessThan(1500)
  })
})
