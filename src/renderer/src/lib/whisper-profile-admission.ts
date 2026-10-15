import { METIS_PACKAGE_PROFILE, type PackageProfile } from '@shared/package-profile'

export function ensureWhisperWorkerProfile(profile: PackageProfile = METIS_PACKAGE_PROFILE): void {
  if (profile === 'lean') throw new Error('The optional Whisper runtime is not configured for this package.')
}
