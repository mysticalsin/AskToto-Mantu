/**
 * FITO-185-I — exclusive first-run must not wait on getSettings/authStatus IPC.
 *
 * Main already treats missing/unreadable settings as exclusive (`onboardingExclusiveLive`
 * fail-closed). The renderer used to paint only a slim "Loading" strip until settings AND
 * auth resolved, so a hung invoke / late hydrate left Tony on a full-screen hero-hold void.
 *
 * Missing settings ≡ onboarding not done. Act 1 may paint with provisional defaults; live
 * settings replace them when IPC lands.
 */
import { DEFAULT_SETTINGS, PublicSettingsSchema, type PublicSettings } from '@shared/ipc'
import bootPosterUrl from '../assets/onboarding-hero-poster.jpg'

/**
 * FITO-185-N: main stamps ?exclusiveOnboarding=1 on the renderer URL while
 * onboardingExclusiveLive(). Fail-closed Act 1 even if async getSettings briefly
 * (or wrongly) looks "done" — that path used to paint the glass Loading strip
 * Tony still calls "Starting Métis".
 * While the flag is present, Act 1 wins even if settings claim done (stale/wrong profile).
 * Post-complete recreate loads without the flag so the Loading strip / bar can resume.
 */
export function exclusiveOnboardingFlag(
  search: string = typeof location !== 'undefined' ? location.search : ''
): boolean {
  try {
    return new URLSearchParams(search).get('exclusiveOnboarding') === '1'
  } catch {
    return false
  }
}

/** True when the boot UI should be onboarding (exclusive Act 1), including settings still null. */
export function isOnboardingBoot(
  settings: PublicSettings | null | undefined,
  search: string = typeof location !== 'undefined' ? location.search : ''
): boolean {
  if (settings?.onboardingDone === true && !exclusiveOnboardingFlag(search)) return false
  if (exclusiveOnboardingFlag(search)) return true
  return settings == null || settings.onboardingDone !== true
}

/**
 * Stand-in PublicSettings for Act 1 while getSettings is in flight.
 * Matches wiped-profile defaults (onboardingDone: false). Never written as-is — patch/setSettings
 * go through real IPC once handlers are up.
 */
export function provisionalOnboardingSettings(): PublicSettings {
  return PublicSettingsSchema.parse({
    ...DEFAULT_SETTINGS,
    hasApiKey: false,
    providerReady: false,
    visionReady: false,
    hasKeys: {},
    hasEncryption: false,
    resolvedMeetingsFolder: ''
  })
}

/**
 * Vite-hashed relative asset URL (same pattern as onboarding-hero-video.ts).
 * Never a leading-slash public path — under Electron file:// that becomes
 * file:///onboarding-hero-poster.jpg and fails.
 */
export const ONBOARDING_BOOT_POSTER_HREF = bootPosterUrl
