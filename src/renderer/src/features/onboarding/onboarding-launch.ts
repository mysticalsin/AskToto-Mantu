export type OnboardingLaunch = {
  view: 'answer' | 'settings'
  settingsTab?: 'ai'
}

/** Parse only the one-shot, main-process-owned route used after Ready's optional AI action. */
export function onboardingLaunchFromSearch(search: string): OnboardingLaunch {
  const params = new URLSearchParams(search)
  if (params.get('view') !== 'settings') return { view: 'answer' }
  return params.get('tab') === 'ai' ? { view: 'settings', settingsTab: 'ai' } : { view: 'settings' }
}
