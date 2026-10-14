import type { ProductPackageMode } from './package-profile-readiness'
import { speechPackAllowsEnsure, type LocalSpeechPackSetting } from './local-speech-pack-policy'

export type OnboardingPackageMode = ProductPackageMode | 'pending'

/** Legacy/full onboarding keeps its established behavior; other package identities never provision ASR. */
export function allowsAutomaticAsrSetup(packageMode: OnboardingPackageMode, policy: LocalSpeechPackSetting): boolean {
  return packageMode === 'legacy' && speechPackAllowsEnsure(policy)
}
