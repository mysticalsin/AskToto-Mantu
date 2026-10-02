import { afterEach, describe, expect, it } from 'vitest'
import { isOnboardingDemoActive, setOnboardingDemoActive } from './onboarding-demo-guard'

describe('MQA-278 — renderer onboarding-demo-active flag', () => {
  afterEach(() => setOnboardingDemoActive(false))

  it('defaults to inactive — real usage of the app is never affected unless the demo scene sets it', () => {
    expect(isOnboardingDemoActive()).toBe(false)
  })

  it('reflects whatever the demo scene last set, both directions', () => {
    setOnboardingDemoActive(true)
    expect(isOnboardingDemoActive()).toBe(true)
    setOnboardingDemoActive(false)
    expect(isOnboardingDemoActive()).toBe(false)
  })
})
