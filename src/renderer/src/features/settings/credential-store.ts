import { isWindows } from '../../lib/keys'

// Name the OS credential facility the way the user's own OS names it — "Keychain" is macOS-only, and
// telling a Windows user to "restore Keychain access" names something their machine does not have. Two
// constants, not one, because these are genuinely different facilities on Windows: the Dust CLI session
// is read out of Credential Manager (dust-secret-store.ts CredReadW), while the encrypted profile's key
// is wrapped by DPAPI via safeStorage. The profile wording matches main's KeychainKeyRecoveryError.
export const DUST_CREDENTIAL_STORE = isWindows ? 'Windows Credential Manager' : 'Keychain'
export const PROFILE_CREDENTIAL_STORE = isWindows ? 'Windows credential store' : 'Keychain'

export function isProfileUnlockError(message: string): boolean {
  return /keychain|encrypted profile|secret.?key/i.test(message)
}
