/** The main process adds this projection only after checking the compiled profile and on-disk resource. */
export type PackageProfileProjection = {
  status: 'verified' | 'legacy-full' | 'development' | 'invalid'
  profile: 'full' | 'lean' | 'development' | null
  identity: string | null
  platform: 'darwin' | 'win32' | null
  arch: 'arm64' | 'x64' | 'universal' | null
  reason: string | null
}

export function hasVerifiedLeanPackageProfile(value: unknown): value is PackageProfileProjection {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const profile = value as Record<string, unknown>
  return (
    profile.status === 'verified' &&
    profile.profile === 'lean' &&
    typeof profile.identity === 'string' &&
    profile.identity.trim().length > 0 &&
    profile.identity.length <= 256 &&
    (profile.platform === 'darwin' || profile.platform === 'win32') &&
    (profile.arch === 'arm64' || profile.arch === 'x64' || profile.arch === 'universal') &&
    profile.reason === null
  )
}

export type ProductPackageMode = 'lean' | 'legacy' | 'invalid'

export function packageModeFromStateSnapshot(snapshot: unknown): ProductPackageMode {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return 'invalid'
  const state = snapshot as Record<string, unknown>
  if (!Object.hasOwn(state, 'packageProfile')) return 'legacy'
  if (state.packageProfile === undefined) return 'invalid'
  return resolveProductPackageMode(state.packageProfile)
}

/** Only absent metadata is the historical/full UI; malformed explicit projections fail closed. */
export function resolveProductPackageMode(value: unknown): ProductPackageMode {
  if (hasVerifiedLeanPackageProfile(value)) return 'lean'
  if (value === undefined) return 'legacy'
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'invalid'
  const profile = value as Record<string, unknown>
  if (profile.status === 'invalid') return 'invalid'
  if (profile.status === 'verified') {
    if (profile.profile === 'full' && hasVerifiedProfileShape(profile)) return 'legacy'
    return 'invalid'
  }
  if (profile.status === 'legacy-full' && profile.profile === 'full' && hasLegacyProfileShape(profile)) return 'legacy'
  if (profile.status === 'development' && profile.profile === 'development' && hasLegacyProfileShape(profile))
    return 'legacy'
  return 'invalid'
}

function hasVerifiedProfileShape(profile: Record<string, unknown>): boolean {
  return (
    typeof profile.identity === 'string' &&
    profile.identity.trim().length > 0 &&
    profile.identity.length <= 256 &&
    (profile.platform === 'darwin' || profile.platform === 'win32') &&
    (profile.arch === 'arm64' || profile.arch === 'x64' || profile.arch === 'universal') &&
    profile.reason === null
  )
}

function hasLegacyProfileShape(profile: Record<string, unknown>): boolean {
  return (
    (profile.identity === null || (typeof profile.identity === 'string' && profile.identity.length <= 256)) &&
    (profile.platform === null || profile.platform === 'darwin' || profile.platform === 'win32') &&
    (profile.arch === null || profile.arch === 'arm64' || profile.arch === 'x64' || profile.arch === 'universal') &&
    (profile.reason === null || typeof profile.reason === 'string')
  )
}
