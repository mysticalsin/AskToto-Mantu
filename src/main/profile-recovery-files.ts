import { CREDENTIAL_INVENTORY } from '@shared/credential-inventory'

/**
 * Credential files the inventory says Reset archives (shared/credential-inventory.ts). Driven by the inventory so a
 * credential file added there is archived on repair with no second list to forget (dust-refresh.bin and
 * license-cache.bin were missing from the old fixed list).
 */
const ARCHIVED_CREDENTIAL_FILES: readonly RegExp[] = CREDENTIAL_INVENTORY.filter(
  (entry) => entry.cleanup.reset === 'archive'
).flatMap((entry) => (entry.holder.kind === 'keystore-file' ? entry.holder.files.map((file) => file.match) : []))

/** Profile-local files that prove a user profile already exists and must be archived on repair. */
const PROFILE_RECOVERY_FIXED_FILES = new Set([
  'settings.json',
  'settings.json.tmp',
  'auth-configured.flag',
  // MQA-260: this one-shot seed marker must not carry an old profile's verdict into a rebuilt profile.
  '.cloudflare-key-seeded',
  // D7-7: the readUserRaw fail-closed copy of an unreadable settings.json belongs to the same old profile.
  'settings.json.recovered'
])

/** Whether a profile-root entry is durable evidence of an existing profile. */
export function isProfileRecoveryFileName(name: string): boolean {
  const base = name.replace(/\.tmp$/, '') // an interrupted atomic write leaves `<file>.tmp` beside the credential
  return (
    PROFILE_RECOVERY_FIXED_FILES.has(name) ||
    /^key-.+\.bin(?:\.tmp)?$/.test(name) ||
    ARCHIVED_CREDENTIAL_FILES.some((pattern) => pattern.test(name) || pattern.test(base))
  )
}

/**
 * Whether a profile-root entry is encrypted under this profile's file key, so a freshly minted key could
 * never open it. A plaintext settings.json is deliberately not one: it proves a profile exists, not that
 * secrets would be orphaned.
 */
export function isEncryptedProfileFileName(name: string): boolean {
  return name === 'auth-session.bin' || /^key-.+\.bin$/.test(name)
}
