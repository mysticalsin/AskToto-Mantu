/**
 * What a denied credential read looks like to the rest of the app (Métis 2.12 G20, CAP-35 / R092).
 *
 * A stored credential can fail to open for reasons that are not "there is none": the keychain is locked or
 * refuses access, the OS reports encryption unavailable, the profile's file key is gone, or the bytes are
 * damaged. Every reader used to swallow that as an empty string, and some logged the raw error. This module
 * turns the failure into a typed refusal and keeps the text of the underlying error out of everything:
 *
 *  - the code is one of a closed set, and the message is fixed copy from the shared inventory;
 *  - the main log gets the credential id, an identifier-shaped scope and the code, nothing else;
 *  - the audit trail gets the same three fields on the `credential.read.denied` event;
 *  - the error object, its message and its stack are never forwarded, because a decrypt, parse or keystore
 *    error can carry a fragment of the value it failed on.
 *
 * The last refusal per credential is remembered in memory so a caller that only got `''` back (the readers keep
 * their string contract) can still ask why, and say "unlock your keychain" instead of "no key". A later
 * successful save clears it. A repeat of the same refusal is neither logged nor audited again.
 */
import {
  CREDENTIAL_REFUSAL_COPY,
  type CredentialId,
  type CredentialReadRefusal,
  type CredentialReadRefusalCode
} from '@shared/credential-inventory'
import { auditLog, mainLog } from './logger'
import { KeychainKeyRecoveryError, ProfileKeyMissingError } from './secrets'

/** Where the failure surfaced: `keychain` means the OS keystore (safeStorage) was asked to open the value. */
export type CredentialReadVia = 'keychain'

export interface CredentialReadDenialOptions {
  /** A plain identifier (a provider or connection id). Anything else is replaced, never logged. */
  readonly scope?: string
  readonly via?: CredentialReadVia
}

export type CredentialReadResult<T> = { readonly ok: true; readonly value: T } | CredentialReadRefusal

const SCOPE = /^[a-z0-9-]{1,40}$/i
const refusals = new Map<string, CredentialReadRefusal>()

const keyOf = (credential: CredentialId, scope?: string): string => (scope ? `${credential}:${scope}` : credential)

/** Closed-set classification. Looks at the error's type and the failing boundary, never at its message. */
export function classifyCredentialReadError(error: unknown, via?: CredentialReadVia): CredentialReadRefusalCode {
  if (error instanceof KeychainKeyRecoveryError) return 'keychain-locked'
  if (error instanceof ProfileKeyMissingError) return 'profile-key-missing'
  return via === 'keychain' ? 'keychain-locked' : 'unreadable'
}

function record(
  credential: CredentialId,
  code: CredentialReadRefusalCode,
  scopeInput: string | undefined
): CredentialReadRefusal {
  const scope = scopeInput === undefined ? undefined : SCOPE.test(scopeInput) ? scopeInput : 'invalid'
  const key = keyOf(credential, scope)
  const refusal: CredentialReadRefusal = { ok: false, code, credential, message: CREDENTIAL_REFUSAL_COPY[code] }
  if (refusals.get(key)?.code !== code) {
    refusals.set(key, refusal)
    const detail = { credential, ...(scope ? { scope } : {}), code }
    mainLog.warn('[credentials] stored credential could not be read', detail)
    auditLog('credential.read.denied', detail)
  }
  return refusals.get(key) ?? refusal
}

/** Record a denied read from a thrown error. Returns the typed refusal. */
export function noteCredentialReadDenied(
  credential: CredentialId,
  error: unknown,
  options: CredentialReadDenialOptions = {}
): CredentialReadRefusal {
  return record(credential, classifyCredentialReadError(error, options.via), options.scope)
}

/** Record a denied read that has no error: the keystore reported it cannot be used at all. */
export function noteCredentialReadUnavailable(
  credential: CredentialId,
  code: Extract<CredentialReadRefusalCode, 'encryption-unavailable' | 'keychain-locked'>,
  scope?: string
): CredentialReadRefusal {
  return record(credential, code, scope)
}

/** The last refusal recorded for this credential, or null when its last read was not denied. */
export function lastCredentialReadRefusal(credential: CredentialId, scope?: string): CredentialReadRefusal | null {
  return refusals.get(keyOf(credential, scope)) ?? null
}

/** A successful read or write means the credential is readable now: forget the refusal. */
export function clearCredentialReadRefusal(credential: CredentialId, scope?: string): void {
  refusals.delete(keyOf(credential, scope))
}

/** Run a read and return its value, or a typed refusal when it throws. Never throws. */
export function guardedCredentialRead<T>(
  credential: CredentialId,
  read: () => T,
  options: CredentialReadDenialOptions = {}
): CredentialReadResult<T> {
  try {
    const value = read()
    clearCredentialReadRefusal(credential, options.scope)
    return { ok: true, value }
  } catch (error) {
    return noteCredentialReadDenied(credential, error, options)
  }
}
