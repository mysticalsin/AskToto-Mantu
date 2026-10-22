/**
 * Opening a stored credential blob, with a typed refusal when it cannot be opened (Métis 2.12 G20).
 *
 * Provider keys, the Soniox key, the Dust refresh token and the MCP secrets all share one on-disk shape: a
 * format marker plus an AES-GCM envelope under the per-install file key, or an older blob that only the OS
 * keystore (Keychain, DPAPI, secret-service) can open. They used to repeat this branch, each swallowing a failure
 * as an empty string and one logging the raw error. This is the single copy. A failure returns `''` (the callers
 * keep their string contract) after recording a typed refusal (credential-read-denial.ts) that carries no secret
 * and no error text, and a success clears any earlier refusal.
 */
import { safeStorage } from 'electron'
import type { CredentialId } from '@shared/credential-inventory'
import {
  clearCredentialReadRefusal,
  noteCredentialReadDenied,
  noteCredentialReadUnavailable
} from './credential-read-denial'
import { decryptSecret } from './secrets'

export interface SealedCredentialOptions {
  /** Format marker that prefixes the AES-GCM form of this credential family. */
  readonly marker: Buffer
  readonly credential: CredentialId
  /** Identifier-shaped scope for the refusal record (a provider or connection id). */
  readonly scope?: string
  /**
   * True: a forced local keystore (ASKTOTO_LOCAL_KEYSTORE) means the OS keystore is never consulted, so an old
   * keystore-only blob is refused instead of prompting. Every reader uses true; the option exists so a caller
   * that needs the old behaviour must say so.
   */
  readonly honourLocalKeystore?: boolean
}

export interface OpenedCredential {
  /** The plaintext, or '' when absent, empty or refused. */
  readonly value: string
  /** True when the value came from an old keystore-only blob, so the caller may re-seal it in the current form. */
  readonly legacy: boolean
}

const EMPTY: OpenedCredential = { value: '', legacy: false }

export function openSealedCredential(buf: Buffer, options: SealedCredentialOptions): OpenedCredential {
  const { marker, credential, scope } = options
  const note = (error: unknown, via?: 'keychain'): OpenedCredential => {
    noteCredentialReadDenied(credential, error, { scope, via })
    return EMPTY
  }
  if (buf.length === 0) return EMPTY
  if (buf.length > marker.length && buf.subarray(0, marker.length).equals(marker)) {
    try {
      const value = decryptSecret(buf.subarray(marker.length))
      clearCredentialReadRefusal(credential, scope)
      return { value, legacy: false }
    } catch (error) {
      return note(error)
    }
  }
  if ((options.honourLocalKeystore ?? true) && process.env.ASKTOTO_LOCAL_KEYSTORE) {
    noteCredentialReadUnavailable(credential, 'keychain-locked', scope)
    return EMPTY
  }
  let available = false
  try {
    available = safeStorage.isEncryptionAvailable()
  } catch {
    available = false
  }
  if (!available) {
    noteCredentialReadUnavailable(credential, 'encryption-unavailable', scope)
    return EMPTY
  }
  try {
    const value = safeStorage.decryptString(buf)
    clearCredentialReadRefusal(credential, scope)
    return { value, legacy: true }
  } catch (error) {
    return note(error, 'keychain')
  }
}
