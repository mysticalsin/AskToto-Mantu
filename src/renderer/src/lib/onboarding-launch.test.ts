import { describe, expect, it } from 'vitest'
import { onboardingLaunchFromSearch } from './onboarding-launch'

describe('onboardingLaunchFromSearch', () => {
  it('routes the optional Ready action to the AI Settings tab', () => {
    expect(onboardingLaunchFromSearch('?view=settings&tab=ai')).toEqual({ view: 'settings', settingsTab: 'ai' })
  })

  it('allows only the exact trusted settings and AI tokens', () => {
    expect(onboardingLaunchFromSearch('?view=settings&tab=privacy')).toEqual({ view: 'settings' })
    expect(onboardingLaunchFromSearch('?view=brain&tab=ai')).toEqual({ view: 'answer' })
  })
})
