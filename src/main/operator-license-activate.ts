/**
 * Desktop-side Operator seat license (METIS-OP-1) activation (PLAN.md P2.2b #1).
 *
 * This is a LOCAL, format-only parse: `parseOperatorLicense` (shared/operator-license.ts) checks the
 * five-part shape and extracts jti/iat/exp, but never verifies the HMAC signature — that needs
 * OPERATOR_INGEST_SECRET, which lives on the Worker, not this device. The Worker is the actual
 * authority: the activation handler immediately confirms the candidate with a signed heartbeat before
 * saving it. This module only rejects malformed or expired candidates before that network request.
 *
 * Pure and Electron-free so it's trivially unit-testable; main/index.ts's IPC handler does the actual
 * settings write.
 */
import { operatorLicenseLast4, parseOperatorLicense } from '@shared/operator-license'

export interface OperatorLicenseActivateResult {
  ok: boolean
  error?: string
  jti?: string
  last4?: string
  /** Epoch ms, from the token's own (unsigned) exp claim. */
  expiresAt?: number
}

/** `raw` is untyped because it arrives straight off an IPC payload. Trims first so a pasted string with
 *  surrounding whitespace (a very common paste artifact) doesn't fail the format check for a reason the
 *  user can't see. */
export function activateOperatorLicenseToken(raw: unknown, now: number = Date.now()): OperatorLicenseActivateResult {
  const token = typeof raw === 'string' ? raw.trim() : ''
  if (!token) return { ok: false, error: 'Enter an Operator license.' }
  const parsed = parseOperatorLicense(token)
  if (!parsed) return { ok: false, error: "That doesn't look like an Operator license." }
  const expiresAt = parsed.exp * 1000
  if (expiresAt <= now) return { ok: false, error: 'This Operator license has expired.' }
  return { ok: true, jti: parsed.jti, last4: operatorLicenseLast4(token), expiresAt }
}
