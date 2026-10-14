/** Profile-local files that prove a user profile already exists and must be archived on repair. */
const PROFILE_RECOVERY_FIXED_FILES = new Set([
  'secret-key.bin',
  'secret-key.bin.migrate.tmp',
  'settings.json',
  'settings.json.tmp',
  'auth-session.bin',
  'auth-configured.flag',
  'msal-cache.bin',
  'google-session.bin',
  // MQA-260: this one-shot seed marker must not carry an old profile's verdict into a rebuilt profile.
  '.cloudflare-key-seeded'
])

/** Whether a profile-root entry is durable evidence of an existing profile. */
export function isProfileRecoveryFileName(name: string): boolean {
  return PROFILE_RECOVERY_FIXED_FILES.has(name) || /^key-.+\.bin(?:\.tmp)?$/.test(name)
}
