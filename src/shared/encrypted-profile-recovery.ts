/**
 * Cross-process recovery contract for a profile whose existing encryption key cannot be unwrapped.
 *
 * Electron IPC preserves an Error message but not a reliable custom Error subclass, so the renderer
 * must only offer the archive-and-retry action for this exact, intentionally stable prefix. Do not
 * widen this into keyword matching: an ordinary write or credential-store error must never suggest
 * changing a user's encrypted profile.
 */
export const ENCRYPTED_PROFILE_RECOVERY_ERROR_PREFIX =
  'Métis could not unlock the existing encrypted profile.'

export function isEncryptedProfileRecoveryMessage(message: string): boolean {
  return message.startsWith(ENCRYPTED_PROFILE_RECOVERY_ERROR_PREFIX)
}
