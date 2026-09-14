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

/** True when the boot UI should be onboarding (exclusive Act 1), including settings still null. */
export function isOnboardingBoot(settings: PublicSettings | null | undefined): boolean {
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

/** Packaged + Vite public URL for the no-JS / Suspense poster bed (see src/renderer/public/). */
export const ONBOARDING_BOOT_POSTER_HREF = '/onboarding-hero-poster.jpg'
