import type { RendererView } from '@shared/renderer-view'
import { onboardingLaunchFromSearch } from './onboarding-launch'

/** Main uses this one-shot launch hint only when Act 6 chose "set up AI" after the save had replied. */
export function initialViewFromLaunch(): RendererView {
  if (typeof location === 'undefined') return 'answer'
  return onboardingLaunchFromSearch(location.search).view
}

/** The Settings tabs the overlay can open on directly. */
export type OpenTab = 'personalize' | 'calendar' | 'ai' | 'profile'

export function initialSettingsTabFromLaunch(): 'ai' | undefined {
  if (typeof location === 'undefined') return undefined
  return onboardingLaunchFromSearch(location.search).settingsTab
}
